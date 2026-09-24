import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock, detLockPath } from './support/read-lock.js';

// Hermetic E2E — ASPECT AUTHORING, the remaining (~uncovered) paths:
//   * ctx.parseYaml / ctx.parseJson / ctx.parseToml — the structured-data parse
//     helpers of the graph-aware deterministic ctx surface. cli-deterministic-ctx
//     exercises ctx.parseAst only; the three structured-data parsers are unpinned.
//     Pinned here on a CONFORMING input (parse succeeds, semantic rule holds) and
//     a MALFORMED input (the helper throws — the check catches it and emits a
//     clean author violation, proving the helper genuinely parses).
//   * a per-attach `when` on a DESCENDANTS.RELATIONS atom (a descendant that
//     declares a relation of a given type to a given target_type). cli-aspect-authoring
//     E2 covers descendants.type and cli-channels-extended B2 covers descendants.type;
//     the descendants.relations atom is unexercised end-to-end. (The consumes_port
//     when-atom on an aspect attach is already pinned by cli-ports-enforcement 4a;
//     the relation-atom by cli-aspect-authoring E1 — both deliberately SKIPPED here.)
//   * the reference-file MODIFICATION round-trip with a WORKING LLM verdict (the
//     in-process mock): editing an LLM aspect's declared `references:` file is an
//     input change that invalidates EVERY node the aspect reaches (their pairs go
//     unverified), and a clean re-fill via the reviewer RESTORES them — the full
//     round-trip.
//   * aspect REMOVAL lazy lock cleanup: detaching an aspect from a node and
//     re-filling evicts its stale per-aspect verdict from the verdict lock (the
//     gitignored .yg-lock.deterministic.json for these deterministic aspects).
//
// Harness (run / BIN_PATH / copyFixture / deterministicFixture) is reused verbatim
// from cli-deterministic-fill-lifecycle.test.ts; the mock-reviewer harness
// (startMockReviewer / runAsync) from support/mock-reviewer.ts. Every graph is
// built in a fresh mkdtemp COPY of the committed e2e-lifecycle fixture; the
// committed fixture is never mutated; each test rmSync's its dir in finally. No
// network, no fixed port, no clock/random in assertions.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-authrem-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. Keeps the suite hermetic: no
 * reviewer endpoint is contacted, every approve/context/check outcome is
 * reproducible, and only deterministic check.mjs runs drive every verdict.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const nodeYaml = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', 'model', ...node.split('/'), 'yg-node.yaml');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);
const aspectYaml = (dir: string, id: string) => path.join(aspectDir(dir, id), 'yg-aspect.yaml');

// The deterministic fill writes its verdicts to the gitignored
// .yg-lock.deterministic.json — the on-disk presence of THIS file is the signal
// that a deterministic fill has run (the committed nondeterministic/logs files
// carry no deterministic verdicts). Every aspect under test here that records a
// verdict via `yg check --approve` (`parse-helpers`, `extra-rule`,
// `no-todo-comments`) is deterministic, so this is the triad file those verdicts
// land in.
const detLockFile = (dir: string) => detLockPath(path.join(dir, '.yggdrasil'));

/** Author a deterministic aspect (yg-aspect.yaml + check.mjs) into the temp copy. */
function writeDeterministicAspect(dir: string, id: string, description: string, checkSource: string): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    aspectYaml(dir, id),
    [
      `name: ${id.replace(/-/g, '')}`,
      `description: ${description}`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(adir, 'check.mjs'), checkSource, 'utf-8');
}

/**
 * Read, from the verdict lock, the set of aspect ids that hold a stored verdict
 * for a given node (its `node:<path>` unitKey). The verdict-lock model keys by
 * aspect first, then unitKey — so we walk every aspect and keep those that have
 * an entry for this node. (Replaces the old per-node baseline `aspectVerdicts`.)
 */
function verdictKeys(dir: string, node: string): string[] {
  const lock = readLock(path.join(dir, '.yggdrasil'));
  const unitKey = `node:${node}`;
  return Object.entries(lock.verdicts ?? {})
    .filter(([, byUnit]) => Object.prototype.hasOwnProperty.call(byUnit, unitKey))
    .map(([aspectId]) => aspectId);
}

/**
 * Silence the two channels that deliver `no-todo-comments` unconditionally in the
 * committed fixture (the `service` architecture-type default, channel 3, and the
 * order-processing flow, channel 5), leaving a node's own declaration as the sole
 * delivery path — so a per-attach `when` is the ONLY include/exclude lever.
 */
function isolateNoTodoToNodeChannel(dir: string): void {
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').replace(
      '    aspects:\n      - no-todo-comments\n      - requires-named-export\n',
      '    aspects:\n      - requires-named-export\n',
    ),
    'utf-8',
  );
  const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
  writeFileSync(
    flowPath,
    readFileSync(flowPath, 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'),
    'utf-8',
  );
}

// `no-todo-comments [enforced]` is the stable heading substring `yg context`
// prints when the aspect is effective; wholly absent when `when` filters it out.
const EFFECTIVE_MARKER = 'no-todo-comments [enforced]';

// ---------------------------------------------------------------------------
// A check.mjs that parses every mapped data file with the format-appropriate
// ctx parse helper, validates a single field, and CATCHES a parse failure to
// emit a clean author violation. This pins that ctx.parseYaml/Json/Toml actually
// parse: a conforming file yields the parsed value (semantic rule holds), a
// malformed file makes the helper throw (surfaced as an author violation here).
// ---------------------------------------------------------------------------
const PARSE_HELPERS_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    let data;
    if (file.path.endsWith('.yaml') || file.path.endsWith('.yml')) {
      try { data = ctx.parseYaml(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseYaml failed: ' + e.message }); continue; }
    } else if (file.path.endsWith('.json')) {
      try { data = ctx.parseJson(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseJson failed: ' + e.message }); continue; }
    } else if (file.path.endsWith('.toml')) {
      try { data = ctx.parseToml(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseToml failed: ' + e.message }); continue; }
    } else {
      continue;
    }
    if (data == null || data.enabled !== true) {
      violations.push({ file: file.path, line: 1, column: 0, message: 'parsed object must have enabled === true, got ' + JSON.stringify(data && data.enabled) });
    }
  }
  return violations;
}
`;

/**
 * Attach the parse-helpers aspect to services/orders and add a single data file
 * (of the given extension+content) to that node's mapping. The orders node then
 * owns the .ts source plus the one data file; the check reads the data file
 * through the matching ctx parse helper.
 */
function setupParseFixture(dir: string, dataName: string, dataContent: string): void {
  writeDeterministicAspect(dir, 'parse-helpers', 'Parsed config files must declare enabled true.', PARSE_HELPERS_CHECK);
  writeFileSync(path.join(dir, 'src', 'services', dataName), dataContent, 'utf-8');
  writeFileSync(
    nodeYaml(dir, 'services/orders'),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      '  - parse-helpers',
      'mapping:',
      '  - src/services/orders.ts',
      `  - src/services/${dataName}`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe.skipIf(!distExists)('CLI E2E — aspect authoring remaining paths (parse helpers / descendants.relations / reference cascade / removal cleanup)', () => {
  // =========================================================================
  // GROUP P — ctx.parseYaml / parseJson / parseToml structured-data helpers.
  // cli-deterministic-ctx pins ctx.parseAst only; these three are unpinned.
  // =========================================================================

  it('P1: ctx.parseYaml parses a CONFORMING .yaml mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p1-yaml-ok');
    try {
      setupParseFixture(dir, 'cfg.yaml', 'name: widget\nenabled: true\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2: ctx.parseYaml on a CONFORMING-but-wrong-VALUE .yaml flags the semantic rule (exit 1, parsed value surfaced)', () => {
    const dir = deterministicFixture('p2-yaml-value');
    try {
      // Valid YAML, but enabled is false → the helper parsed it; the rule fails.
      setupParseFixture(dir, 'cfg.yaml', 'name: widget\nenabled: false\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parsed object must have enabled === true, got false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3: ctx.parseYaml on a MALFORMED .yaml throws — the check catches it and reports parseYaml failed (exit 1)', () => {
    const dir = deterministicFixture('p3-yaml-bad');
    try {
      // Broken block structure → the yaml parser throws.
      setupParseFixture(dir, 'cfg.yaml', 'name: [1, 2\n  - broken: : :\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseYaml failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P4: ctx.parseJson parses a CONFORMING .json mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p4-json-ok');
    try {
      setupParseFixture(dir, 'cfg.json', '{ "name": "widget", "enabled": true }\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P5: ctx.parseJson on a MALFORMED .json throws — the check catches it and reports parseJson failed (exit 1)', () => {
    const dir = deterministicFixture('p5-json-bad');
    try {
      setupParseFixture(dir, 'cfg.json', '{ "name": "widget", enabled true \n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseJson failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P6: ctx.parseToml parses a CONFORMING .toml mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p6-toml-ok');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = "widget"\nenabled = true\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P7: ctx.parseToml on a MALFORMED .toml throws — the check catches it and reports parseToml failed (exit 1)', () => {
    const dir = deterministicFixture('p7-toml-bad');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = = "widget"\n');
      const test = run(['aspect-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseToml failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P8: a CONFORMING parse-helpers aspect drives a real fill to a recorded approved verdict (exit 0)', () => {
    const dir = deterministicFixture('p8-fill');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = "widget"\nenabled = true\n');
      const fill = run(['check', '--approve'], dir);
      // The conforming config makes parse-helpers pass; the fill records it approved.
      // (The advisory requires-named-export may warn on the data file — that is a
      // non-blocking warning and does not fail the fill.)
      expect(fill.status).toBe(0);
      expect(existsSync(detLockFile(dir))).toBe(true);
      expect(verdictKeys(dir, 'services/orders')).toContain('parse-helpers');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — per-attach `when` on a DESCENDANTS.RELATIONS atom. cli-aspect-authoring
  // E2 + cli-channels-extended B2 cover descendants.type; the descendants.relations
  // atom (a descendant declaring a relation of a given type to a given target_type)
  // is unexercised. Gated on the `services` MODULE having any service descendant
  // that `calls` another service.
  // =========================================================================

  it('D1: descendants.relations atom INCLUDES the aspect when a descendant declares the matching relation', () => {
    const dir = deterministicFixture('d1-desc-rel-true');
    try {
      isolateNoTodoToNodeChannel(dir);
      // orders (a service descendant of `services`) declares calls→payments.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'relations:',
          '  - target: services/payments',
          '    type: calls',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      // Attach on the module, gated on a descendant that calls a service.
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        relations:',
          '          calls:',
          '            target_type: service',
          '',
        ].join('\n'),
        'utf-8',
      );
      const ctx = run(['context', '--node', 'services'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: descendants.relations atom EXCLUDES the aspect when no descendant declares the relation', () => {
    const dir = deterministicFixture('d2-desc-rel-false');
    try {
      isolateNoTodoToNodeChannel(dir);
      // No descendant declares any relation (the committed children have none).
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        relations:',
          '          calls:',
          '            target_type: service',
          '',
        ].join('\n'),
        'utf-8',
      );
      const ctx = run(['context', '--node', 'services'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP R — reference-file MODIFICATION round-trip with a WORKING LLM verdict.
  // The in-process mock plays the reviewer so a CLEAN fill is reachable; the LLM
  // pair's verdict hash folds in the reference file's bytes. Editing the reference
  // file is an input change that invalidates every node the aspect reaches (their
  // pairs go unverified), and a clean re-fill via the mock RESTORES them — the
  // full round-trip. The reference file's bytes are an input to the (aspect, unit)
  // pair hash, so a one-byte change to it flips both pairs to unverified.
  // =========================================================================

  function withReference(dir: string): string {
    // Declare a reference file on the committed LLM aspect (NOT stripped here).
    writeFileSync(
      aspectYaml(dir, 'has-doc-comment'),
      [
        'name: HasDocComment',
        "description: Every source file must begin with a documentation comment describing the file's purpose.",
        'reviewer:',
        '  type: llm',
        'status: enforced',
        'references:',
        '  - docs/guidance.md',
        '',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    const guidance = path.join(dir, 'docs', 'guidance.md');
    writeFileSync(guidance, '# Guidance\n\nDescribe the file purpose in the opening comment.\n', 'utf-8');
    return guidance;
  }

  function pointReviewer(dir: string, endpoint: string): void {
    const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    const cfg = readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`);
    // Disable required coverage so reference files outside src/ (docs/) are advisory-only.
    writeFileSync(p, `${cfg}\ncoverage:\n  required: []\n`, 'utf-8');
  }

  it('R1: editing an LLM aspect reference file invalidates BOTH nodes (unverified); a clean re-fill via the reviewer RESTORES them', async () => {
    const dir = copyFixture('r1-reference-roundtrip');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const guidance = withReference(dir);

      // Clean LLM fill across both participants — each LLM pair's verdict hash
      // folds in the reference file's bytes.
      const filled = await runAsync(['check', '--approve'], dir);
      expect(filled.status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Edit the reference file → both has-doc-comment pairs go unverified.
      appendFileSync(guidance, '\nAdditional guidance appended to change the input.\n');
      const invalidated = run(['check'], dir);
      expect(invalidated.status).toBe(1);
      // One unverified block whose subject names the cause (the reference moved
      // the inputs); the capped view lists the rule once with its pair/node count.
      expect(invalidated.stdout).toContain('error[unverified] 2 pairs whose inputs changed since the verdict\n');
      expect(invalidated.stdout).toContain('  at:   has-doc-comment  2 pairs · 2 nodes · reviewer\n');
      // The uncapped view names each invalidated pair.
      const details = run(['check', '--details'], dir);
      expect(details.stdout).toContain('has-doc-comment @ services/orders');
      expect(details.stdout).toContain('has-doc-comment @ services/payments');


      // A clean re-fill re-runs the reviewer on both pairs and restores them.
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);

      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).not.toContain('unverified');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R2: a reference-file change re-runs ONLY that aspect on re-fill — one reviewer call per affected node', async () => {
    const dir = copyFixture('r2-reference-cost');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const guidance = withReference(dir);

      // Initial fill; has-doc-comment is the sole LLM aspect → 1 call per node = 2.
      await runAsync(['check', '--approve'], dir);
      const afterFirstFill = mock.chatCount();
      expect(afterFirstFill).toBe(2);

      // Edit the reference → both pairs go unverified → re-fill re-runs only this
      // aspect across both nodes (the deterministic pairs need no reviewer call).
      appendFileSync(guidance, '\nMore guidance.\n');
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // Exactly one additional reviewer call per affected node (orders, payments).
      expect(mock.chatCount()).toBe(afterFirstFill + 2);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP X — aspect REMOVAL lazy lock cleanup. Detaching an aspect from a node
  // and re-filling evicts its stale per-aspect verdict from the verdict lock,
  // so no orphaned verdict lingers. Distinct from the draft-transition eviction
  // pinned by cli-aspect-status-extended (which keeps the aspect, only drafts it).
  // =========================================================================

  it('X1: attaching an aspect records its verdict; REMOVING it from the node evicts the stale verdict on re-fill', () => {
    const dir = deterministicFixture('x1-removal-cleanup');
    try {
      // Author an always-pass aspect and attach it to orders.
      writeDeterministicAspect(dir, 'extra-rule', 'An extra always-pass deterministic rule.', 'export function check(ctx) { return []; }\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - extra-rule',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const first = run(['check', '--approve'], dir);
      expect(first.status).toBe(0);
      // The lock records a verdict for the attached aspect on this node.
      expect(verdictKeys(dir, 'services/orders')).toContain('extra-rule');

      // Detach extra-rule from the node (back to the committed node shape) and
      // delete the now-orphaned aspect so `yg check` stays clean.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      rmSync(aspectDir(dir, 'extra-rule'), { recursive: true, force: true });

      const second = run(['check', '--approve'], dir);
      expect(second.status).toBe(0);
      // The removed aspect's verdict is GONE — no stale entry lingers in the lock.
      expect(verdictKeys(dir, 'services/orders')).not.toContain('extra-rule');
      // The node's remaining (type-default) aspects keep their verdicts.
      expect(verdictKeys(dir, 'services/orders')).toContain('no-todo-comments');
      // No unverified pair remains FOR THIS NODE after the cleanup re-fill.
      const check = run(['check'], dir);
      const ordersUnverified = check.stdout
        .split('\n')
        .filter((l) => l.includes('services/orders') && l.includes('unverified'));
      expect(ordersUnverified.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
