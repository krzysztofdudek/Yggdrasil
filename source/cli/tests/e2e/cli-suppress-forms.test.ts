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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable — port 1 never has a listener, on ANY machine, with no
// reliance on a real endpoint being present or absent. Used by killReviewer().
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-suppress-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the check/fill
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — only the
 * deterministic check.mjs aspects drive every refuse/pass outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  // Drop the LLM aspect from the `service` node type's default aspects.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  // Remove the now-orphaned aspect definition so `yg check` is clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address. The
 * deterministicFixture already removes the only LLM aspect, but killing the
 * endpoint as well guarantees no test in this suite can reach out over the
 * network even if a future fixture edit reintroduces an LLM aspect.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');

/**
 * Write a single-file-style deterministic aspect that flags every line
 * containing `token`. The aspect id is the directory name. Both the single-file
 * and the graph-aware deterministic runners surface `ctx.files[].content`, so a
 * content-scan check like this exercises the per-file path.
 */
function writeTokenAspect(dir: string, id: string, token: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Source lines must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const out = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      `        out.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${id}: ${token} present.`)} });`,
      '      }',
      '    }',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/**
 * Write a GRAPH-AWARE deterministic aspect. It reaches the node's own mapped
 * file through the graph surface (`ctx.node.files` + `ctx.fs.read`) rather than
 * iterating raw `ctx.files`, and reports `file`+`line`. This is the path STRUCT-1
 * taught to honor in-source `yg-suppress` markers (the structure runner filters
 * suppressed violations by aspect id + line).
 */
function writeGraphAwareAspect(dir: string, id: string, token: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Graph-aware rule — a node's own file must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const out = [];',
      '  for (const f of ctx.node.files) {',
      '    const content = ctx.fs.read(f.path);',
      '    const lines = content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      `        out.push({ file: f.path, line: i + 1, column: 0, message: ${JSON.stringify(`${id}: ${token} present.`)} });`,
      '      }',
      '    }',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Re-author a service node so its OWN aspects are exactly `aspects`. */
function setNodeAspects(nodeYamlPath: string, name: string, description: string, mapping: string, aspects: string[]): void {
  const lines = [`name: ${name}`, `description: ${description}`, 'type: service'];
  if (aspects.length > 0) {
    lines.push('aspects:');
    for (const a of aspects) lines.push(`  - ${a}`);
  }
  lines.push('mapping:', `  - ${mapping}`, '');
  writeFileSync(nodeYamlPath, lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// yg-suppress SYNTACTIC FORMS + edge cases NOT covered by cli-status-suppress
// (which already pins: bracket wildcard range, single-line over one of two
// TODOs, draft-aspect suppress no-op). Fully hermetic: every test builds its
// own graph in a fresh temp dir, uses only deterministic check.mjs aspects, and
// makes no network / clock / random reads in any assertion.
//
// Verdict-lock model: `yg approve` is gone — verification happens via
// `yg check --approve` (repo-wide fill). A deterministic verdict renders per
// pair; a refusal of an
// enforced aspect blocks check (exit 1). A waived (suppressed) violation makes
// the pair `approved`.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — yg-suppress syntactic forms + aspect-path matching', () => {
  // --- 1. FILE-LEVEL placement: bare disable() at the top waives the WHOLE file ---
  //
  // UNIFIED SUPPRESS SEMANTICS — pinning the (now-shared) LINE-BASED behavior.
  //
  // Suppress is resolved identically for BOTH reviewer kinds. The matcher
  // (src/ast/suppress.ts) computes line spans once, and the LLM path now injects
  // those exact spans into the reviewer prompt as <suppressed-ranges> (Task #18) —
  // so the LLM honors the SAME lines the deterministic runners waive, with no
  // model-side re-derivation of marker scope. The spans are purely LINE-BASED:
  //   * A single-line `yg-suppress(<id>)` covers exactly ONE line — the line
  //     immediately below it (`m.line + 1`). A marker on line 1 waives only line 2;
  //     a violation deeper in the file is NOT waived (for EITHER reviewer kind).
  //   * The only construct that waives "to end of file" is a bare
  //     `yg-suppress-disable(<id>)` with NO matching `enable` — the unterminated
  //     disable range extends through the last line.
  //
  // This suite exercises the DETERMINISTIC runners for the line-span behavior; the
  // separate "LLM/deterministic parity" block below proves the LLM prompt receives
  // the same spans. (Test 1b proves the single-line form does NOT do whole-file
  // scoping — true for both kinds under the unified resolver.)

  it('1: a file-level yg-suppress-disable(no-todo-comments) (no enable) waives a TODO deep in the file; fill + check green', () => {
    const dir = hermeticFixture('file-level-disable');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // File-level marker at the TOP (before any code), then a TODO buried in a
      // function body further down. The unterminated disable covers to EOF.
      const body = readFileSync(paymentsFile(dir), 'utf-8');
      writeFileSync(
        paymentsFile(dir),
        [
          '// yg-suppress-disable(no-todo-comments) generated file, debt tracked in the issue tracker',
          body,
          '',
          'function deepHelper(p: Payment): Payment {',
          '  // TODO: buried debt far below the file-level marker',
          '  return p;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(fill.all).not.toContain('refused');

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1b. NEGATION + the single-line-at-top divergence proof ---

  it('1b: the identical deep TODO refuses WITHOUT the file-level disable; a single-line marker on line 1 does NOT cover it either', () => {
    const dir = hermeticFixture('file-level-control');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const clean = readFileSync(paymentsFile(dir), 'utf-8');

      const deepTodo = [
        '',
        'function deepHelper(p: Payment): Payment {',
        '  // TODO: buried debt far below the top of the file',
        '  return p;',
        '}',
        '',
      ].join('\n');

      // (a) No marker at all -> the enforced aspect refuses.
      writeFileSync(paymentsFile(dir), clean + deepTodo, 'utf-8');
      const noMarker = run(['check', '--approve'], dir);
      expect(noMarker.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR.
      expect(noMarker.stderr).toContain('[det] no-todo-comments on node:services/payments — refused');

      // (b) A SINGLE-LINE yg-suppress(...) on line 1 still refuses: the unified
      // resolver makes the single-line form cover only the line immediately below
      // the marker (line 2), not the whole file — for BOTH reviewer kinds. The LLM
      // is handed that same one-line span via <suppressed-ranges>, so it cannot
      // over-waive the rest of the file either.
      writeFileSync(
        paymentsFile(dir),
        '// yg-suppress(no-todo-comments) generated file, debt tracked in the issue tracker\n' +
          clean +
          deepTodo,
        'utf-8',
      );
      const singleLineTop = run(['check', '--approve'], dir);
      expect(singleLineTop.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR.
      expect(singleLineTop.stderr).toContain('[det] no-todo-comments on node:services/payments — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. SINGLE-LINE WILDCARD waives EVERY aspect on the contextual block ---

  it('2: a single-line yg-suppress(*) above one line waives TWO distinct aspects both violated on that line; fill exits 0', () => {
    const dir = hermeticFixture('single-line-wildcard');
    try {
      // Two independent enforced aspects that both flag any line carrying the
      // same token. Attach both to the payments node.
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // ONE wildcard single-line marker directly above the single offending line.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(*) generated reconciliation constant, debt tracked in the issue tracker',
          'const reconcileTag = "BADTOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // BOTH aspects waived by the single wildcard marker — both pairs approve.
      // Fill-time progress ([det] lines) go to STDERR; final report to STDOUT.
      expect(fill.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2b. control: the same line WITHOUT the wildcard marker fires both aspects ---

  it('2b: WITHOUT the wildcard marker the identical line trips BOTH aspects; fill exits 1', () => {
    const dir = hermeticFixture('single-line-wildcard-control');
    try {
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);

      appendFileSync(paymentsFile(dir), '\nconst reconcileTag = "BADTOKEN";\n', 'utf-8');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Fill-time progress ([det] lines) go to STDERR.
      expect(fill.stderr).toContain('[det] ban-foo on node:services/payments — refused');
      expect(fill.stderr).toContain('[det] ban-bar on node:services/payments — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. WRONG aspect-path is a silent no-op (matched by id, not blanket-applied) ---

  it('3: a yg-suppress naming a NON-EXISTENT aspect-path does NOT waive the real violation; no "unknown target" notice; exit 1', () => {
    const dir = hermeticFixture('wrong-path-noop');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Marker names "no-todo-commentz" — a typo. The real aspect is
      // "no-todo-comments". The token is matched as a plain string against the
      // aspect id; a non-matching id suppresses nothing.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-commentz) typo in the aspect id, debt tracked in the issue tracker',
          '// TODO: this is still flagged because the suppress id does not match',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR.
      expect(fill.stderr).toContain('[det] no-todo-comments on node:services/orders — refused');
      // The CLI does NOT warn that the suppress id is unknown — a wrong/typo'd
      // aspect-path is silently inert (nothing validates the id exists).
      expect(fill.all.toLowerCase()).not.toContain('unknown suppress');
      expect(fill.all.toLowerCase()).not.toContain('suppress target');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. CORRECT aspect-path IS waived (positive control for test 3) ---

  it('4: the SAME violation with the CORRECT aspect-path in the single-line marker IS waived; fill exits 0', () => {
    const dir = hermeticFixture('correct-path-match');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Identical placement to test 3, but the id is spelled correctly.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker',
          '// TODO: this is waived because the suppress id matches exactly',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(fill.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. GRAPH-AWARE (structure) runner honors in-source yg-suppress (STRUCT-1) ---

  it('5: a graph-aware (ctx.graph/ctx.fs) violation is waived by a single-line yg-suppress; fill exits 0', () => {
    const dir = hermeticFixture('graph-aware-suppress');
    try {
      // FORBIDDENMARK is chosen so it never appears inside the marker comment
      // text itself (the aspect id contains no such substring) — the only
      // matching line is the offending code line.
      writeGraphAwareAspect(dir, 'graph-no-forbidden', 'FORBIDDENMARK');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['graph-no-forbidden'],
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);

      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(graph-no-forbidden) graph-shape debt, tracked in the issue tracker',
          'const forbiddenTag = "FORBIDDENMARK";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(fill.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5b: the same graph-aware violation refuses WITHOUT the marker, and a WRONG-id marker does NOT waive it; exit 1', () => {
    const dir = hermeticFixture('graph-aware-control');
    try {
      writeGraphAwareAspect(dir, 'graph-no-forbidden', 'FORBIDDENMARK');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['graph-no-forbidden'],
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const clean = readFileSync(ordersFile(dir), 'utf-8');

      // (a) No marker -> graph-aware aspect refuses.
      writeFileSync(ordersFile(dir), clean + '\nconst forbiddenTag = "FORBIDDENMARK";\n', 'utf-8');
      const noMarker = run(['check', '--approve'], dir);
      expect(noMarker.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR.
      expect(noMarker.stderr).toContain('[det] graph-no-forbidden on node:services/orders — refused');

      // (b) Wrong-id marker -> still refuses (suppress is matched by aspect id).
      writeFileSync(
        ordersFile(dir),
        clean +
          '\n// yg-suppress(graph-no-forbiddenz) wrong id, debt tracked in the issue tracker\n' +
          'const forbiddenTag = "FORBIDDENMARK";\n',
        'utf-8',
      );
      const wrongId = run(['check', '--approve'], dir);
      expect(wrongId.status).toBe(1);
      expect(wrongId.stderr).toContain('[det] graph-no-forbidden on node:services/orders — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. NAMED bracket disable/enable waives ONLY that aspect; a second aspect in the range still fires ---

  it('6: a bracket yg-suppress-disable(ban-foo)..enable(ban-foo) waives only ban-foo; ban-bar in the same range still refuses; exit 1', () => {
    const dir = hermeticFixture('named-bracket');
    try {
      // Two enforced aspects flagging the same token; attach both to payments.
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // A bracket scoped to ONE NAMED aspect (NOT wildcard) around the offending
      // line. Only ban-foo is named, so ban-bar still fires inside the range.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress-disable(ban-foo) legacy reconciliation block, debt tracked in the issue tracker',
          'const reconcileTag = "BADTOKEN";',
          '// yg-suppress-enable(ban-foo)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // ban-foo is waived by the named bracket; ban-bar is NOT (different id).
      expect(fill.stderr).toContain('[det] ban-bar on node:services/payments — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ANCHORED MARKER GRAMMAR — a marker counts only when the yg-suppress token
// begins its comment line (at most ONE leading comment delimiter). Prose that
// merely MENTIONS the syntax is invisible to the reviewer AND to the
// `yg suppressions` inventory. Pins the closed enforcement hole: a mid-sentence
// wildcard mention above a violating line used to silently waive an enforced
// violation.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — anchored marker grammar (prose mentions are not markers)', () => {
  it('7: a prose comment mentioning yg-suppress(*) above a violating line does NOT waive the enforced violation; --only-deterministic still refuses (exit 1)', () => {
    const dir = hermeticFixture('prose-wildcard-hole');
    try {
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

      // The repro of the enforcement hole: a mid-sentence wildcard mention in a
      // real comment, directly above a real violation. Under the anchored
      // grammar the mention is prose, not a marker — nothing is waived.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// Note: never use yg-suppress(*) here because wildcards mask real problems',
          '// TODO: real debt that must stay visible',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR.
      expect(fill.stderr).toContain('[det] no-todo-comments on node:services/orders — refused');

      // Plain check stays red too — the prose mention waives nothing.
      expect(run(['check'], dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a legit anchored single-line marker still waives the violation, and yg suppressions lists ONLY that marker (no phantoms, exit 0)', () => {
    const dir = hermeticFixture('anchored-marker-inventory');
    try {
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

      // One prose mention AND one genuine anchored marker in the same file. The
      // marker waives the violation on the line below it; the prose line is
      // invisible to both the reviewer and the inventory.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// Remember: yg-suppress(no-todo-comments) mentioned mid-sentence is only prose',
          '// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker',
          '// TODO: waived by the anchored marker directly above',
          '',
        ].join('\n'),
        'utf-8',
      );

      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).not.toContain('refused');

      // The inventory lists exactly the ONE anchored marker: no phantom rows for
      // the prose mention, no warnings, exit 0.
      const inv = run(['suppressions'], dir);
      expect(inv.status).toBe(0);
      expect(inv.stdout).toContain('single(no-todo-comments)');
      expect(inv.stdout).toContain('known debt, tracked in the issue tracker');
      expect(inv.stdout).toContain('Total: 1 marker across 1 file.');
      expect(inv.stdout).not.toContain('mentioned mid-sentence');
      expect(inv.stdout).not.toContain('Warnings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RAW-SCAN SECURITY (F5) + INVENTORY PARITY (F4) + MALFORMED MARKER (F6)
//
// A mapped non-grammar file (`.md`/`.sql`) is raw-scanned by the honoring path.
// The comment delimiter is MANDATORY there: a bare prose line that merely begins
// with the token must NOT waive (F5). The SAME mapped file must be visible to the
// `yg suppressions` audit (F4). A reasonless marker surfaces its own diagnostic,
// never a check.mjs-crash (F6). Fully hermetic (deterministic checks only).
// ---------------------------------------------------------------------------

const ordersDocFile = (dir: string, name: string) => path.join(dir, 'src', 'services', name);

/** Re-author the orders node to map orders.ts + an extra mapped doc, own aspects. */
function mapDocToOrders(dir: string, docName: string, ownAspects: string[]): void {
  const lines = ['name: OrdersService', 'description: Creates and retrieves customer orders.', 'type: service'];
  if (ownAspects.length > 0) {
    lines.push('aspects:');
    for (const a of ownAspects) lines.push(`  - ${a}`);
  }
  lines.push('mapping:', '  - src/services/orders.ts', `  - src/services/${docName}`, '');
  writeFileSync(ordersNodeYaml(dir), lines.join('\n'), 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — raw-scan mandatory delimiter (F5) + inventory parity (F4) + malformed marker (F6)', () => {
  it('F5: a mapped .md line beginning with a BARE yg-suppress(...) (no delimiter) does NOT waive an enforced violation', () => {
    const dir = hermeticFixture('raw-scan-bare-nowaive');
    try {
      writeTokenAspect(dir, 'ban-secret', 'SECRETTOKEN');
      mapDocToOrders(dir, 'orders-notes.md', ['ban-secret']);
      writeFileSync(
        ordersDocFile(dir, 'orders-notes.md'),
        [
          '# Orders migration notes (keeps an export reference for the module rule)',
          '',
          'When migrating legacy config you might be tempted to write a',
          'yg-suppress(ban-secret) marker, but prefer fixing the value instead:',
          'SECRETTOKEN lives here for legacy reasons.',
          '',
        ].join('\n'),
        'utf-8',
      );
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      // The bare (delimiter-less) line is NOT a marker → the secret line refuses.
      expect(fill.status).toBe(1);
      expect(fill.stderr).toContain('[det] ban-secret on node:services/orders — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: a mapped .sql line with a REAL -- delimiter DOES waive the enforced violation', () => {
    const dir = hermeticFixture('raw-scan-sql-waive');
    try {
      writeTokenAspect(dir, 'ban-secret', 'SECRETTOKEN');
      mapDocToOrders(dir, 'orders-recon.sql', ['ban-secret']);
      writeFileSync(
        ordersDocFile(dir, 'orders-recon.sql'),
        [
          '-- Orders reconciliation (keeps an export reference for the module rule)',
          '-- yg-suppress(ban-secret) known debt, tracked in the issue tracker',
          'SELECT val FROM orders WHERE token = SECRETTOKEN;',
          '',
        ].join('\n'),
        'utf-8',
      );
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: a mapped .md line with a REAL # delimiter DOES waive the enforced violation', () => {
    const dir = hermeticFixture('raw-scan-md-hash-waive');
    try {
      writeTokenAspect(dir, 'ban-secret', 'SECRETTOKEN');
      mapDocToOrders(dir, 'orders-notes.md', ['ban-secret']);
      writeFileSync(
        ordersDocFile(dir, 'orders-notes.md'),
        [
          'Orders notes that keep an export reference for the module rule.',
          '# yg-suppress(ban-secret) known debt, tracked in the issue tracker',
          'SECRETTOKEN lives here for legacy reasons.',
          '',
        ].join('\n'),
        'utf-8',
      );
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).not.toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F4: a honored marker in a mapped .md is visible to `yg suppressions` (audit parity)', () => {
    const dir = hermeticFixture('inventory-mapped-md');
    try {
      writeTokenAspect(dir, 'ban-secret', 'SECRETTOKEN');
      mapDocToOrders(dir, 'orders-notes.md', ['ban-secret']);
      writeFileSync(
        ordersDocFile(dir, 'orders-notes.md'),
        [
          'Orders notes that keep an export reference for the module rule.',
          '# yg-suppress(ban-secret) known debt, tracked in the issue tracker',
          'SECRETTOKEN lives here for legacy reasons.',
          '',
        ].join('\n'),
        'utf-8',
      );
      // The waiver above is HONORED (F5 positive). The audit must not be blind to it.
      const inv = run(['suppressions'], dir);
      expect(inv.status).toBe(0);
      expect(inv.stdout).toContain('src/services/orders-notes.md');
      expect(inv.stdout).toContain('single(ban-secret)');
      expect(inv.stdout).toContain('known debt, tracked in the issue tracker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F6: a reasonless marker in a mapped file surfaces a MALFORMED-MARKER diagnostic, never a check.mjs crash', () => {
    const dir = hermeticFixture('malformed-marker-diag');
    try {
      // A reasonless marker directly above a real violation: collectSuppressions
      // throws, but the fault is the SOURCE marker, not the (correct) check.
      appendFileSync(
        ordersFile(dir),
        ['', '// yg-suppress(no-todo-comments)', '// TODO: real debt below a reasonless marker', ''].join('\n'),
        'utf-8',
      );
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(1);
      // Its OWN diagnostic names the malformed marker + file:line.
      expect(fill.all).toContain('Malformed yg-suppress marker');
      expect(fill.all).toContain('src/services/orders.ts:');
      // NEVER misattributed to the aspect's check.
      expect(fill.all).not.toContain('aspect-check-runtime-error');
      expect(fill.all).not.toContain('check.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// errs: under — the suppression inventory FLAGS a waiver on an under-approximating
// check. Such a check produces no false positives by design, so waiving one is a
// footgun. The warning is advisory: `yg suppressions` still exits 0.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — suppressions flags a waiver on an errs: under check', () => {
  /** Write a deterministic aspect explicitly labeled under-approximating. */
  function writeUnderAspect(dir: string, id: string): void {
    const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      [
        `name: ${id}`,
        'description: A provable-only rule; never a false positive.',
        'reviewer:',
        '  type: deterministic',
        'errs: under',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
  }

  it('yg suppressions prints the under-approximating warning and exits 0', () => {
    const dir = hermeticFixture('errs-under-waiver');
    try {
      writeUnderAspect(dir, 'under-approx');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['under-approx'],
      );

      // A genuine single-line waiver naming the under-approximating aspect.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(under-approx) waiving a provable-only check, tracked in the issue tracker',
          'const flagged = 1;',
          '',
        ].join('\n'),
        'utf-8',
      );

      const inv = run(['suppressions'], dir);
      // Advisory only — the inventory still exits 0.
      expect(inv.status).toBe(0);
      expect(inv.stdout).toContain('single(under-approx)');
      // The exact under-approximating footgun sentence reached the inventory output.
      expect(inv.stdout).toContain(
        'such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// LLM / deterministic PARITY — the LLM reviewer prompt receives the SAME
// resolved <suppressed-ranges> spans the deterministic matcher computes (Task
// #18). Driven by an in-process mock reviewer (the dead-endpoint suite above can
// only fail-closed to INFRA, never REFUSE, so it cannot exercise the LLM verdict
// path). The mock captures every /api/chat request, letting us assert the exact
// suppress block that crossed the wire.
// ---------------------------------------------------------------------------

/** Point the fixture's reviewer tier at the in-process mock endpoint. */
function pointReviewerAt(dir: string, endpoint: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${endpoint}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** The verifier prompt sent for the given aspect id (the <aspect id="..."> tag). */
function promptFor(chatRequests: Array<{ prompt: string }>, aspectId: string): string | undefined {
  return chatRequests.find((r) => r.prompt.includes(`<aspect id="${aspectId}"`))?.prompt;
}

describe.skipIf(!distExists)('CLI E2E — yg-suppress LLM/deterministic parity (injected ranges reach the reviewer)', () => {
  it('a single-line yg-suppress(has-doc-comment) injects its resolved 1-line span into the LLM reviewer prompt', async () => {
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'mock-refuse' }) });
    const dir = copyFixture('llm-suppress-inject');
    try {
      pointReviewerAt(dir, mock.endpoint);

      // orders.ts already starts with a doc comment (has-doc-comment is content-
      // local). Append a single-line marker for the LLM aspect: the resolver waives
      // exactly the line BELOW the marker. The exact span (one line) must reach the
      // reviewer in <suppressed-ranges>.
      const body = readFileSync(ordersFile(dir), 'utf-8');
      const markerBlock = [
        '',
        '// yg-suppress(has-doc-comment) known debt, tracked in the issue tracker',
        'export const SUPPRESSED_LINE = 1;',
        '',
      ].join('\n');
      writeFileSync(ordersFile(dir), body + markerBlock, 'utf-8');

      // Derive the resolved span from the written file: a single-line marker waives
      // exactly the line BELOW it. Compute it by scanning rather than arithmetic so
      // the assertion can't drift with fixture-content changes.
      const writtenLines = readFileSync(ordersFile(dir), 'utf-8').split('\n');
      const markerIdx = writtenLines.findIndex((l) => l.includes('yg-suppress(has-doc-comment)'));
      const suppressedLine = markerIdx + 2; // 1-based line below the marker

      const res = await runAsync(['check', '--approve'], dir);

      // The has-doc-comment reviewer was called for the orders node.
      const prompt = promptFor(mock.chatRequests, 'has-doc-comment');
      expect(prompt).toBeDefined();
      // The injected block — and the exact resolved 1-line span — crossed the wire.
      expect(prompt).toContain('</suppressed-ranges>');
      expect(prompt).toContain('<file path="src/services/orders.ts">');
      expect(prompt).toContain(`<range start-line="${suppressedLine}" end-line="${suppressedLine}" />`);
      // The reviewer is instructed to honor exactly those lines (unified text).
      expect(prompt).toContain('Honor exactly these line ranges');
      expect(prompt).not.toContain('treat the suppressed code as satisfied');
      // The mock refused, so has-doc-comment is recorded refused (exit 1) — the
      // assertion of interest is purely that the block reached the reviewer.
      expect(res.all).toContain('has-doc-comment');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await mock.close();
    }
  });

  it('WITHOUT a marker the LLM reviewer prompt carries NO <suppressed-ranges> block', async () => {
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'mock-refuse' }) });
    const dir = copyFixture('llm-no-suppress-control');
    try {
      pointReviewerAt(dir, mock.endpoint);
      // No marker touched — the unedited fixture file has no yg-suppress.
      await runAsync(['check', '--approve'], dir);
      const prompt = promptFor(mock.chatRequests, 'has-doc-comment');
      expect(prompt).toBeDefined();
      // The prose preamble still NAMES <suppressed-ranges> (telling the model where
      // a block WOULD appear), but no actual block is rendered: its closing tag is
      // the block-only marker.
      expect(prompt).not.toContain('</suppressed-ranges>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await mock.close();
    }
  });

  it('a wildcard bracket waives the SAME span for the LLM aspect AND a deterministic aspect over those lines', async () => {
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    const dir = copyFixture('llm-det-parity');
    try {
      pointReviewerAt(dir, mock.endpoint);

      // A deterministic token aspect on the orders node + the default LLM aspect.
      // Wrap one offending line in a wildcard bracket: the SAME span is waived for
      // both the deterministic check (line-based) and the LLM (via injected range).
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['ban-foo', 'has-doc-comment'],
      );

      const body = readFileSync(ordersFile(dir), 'utf-8');
      writeFileSync(
        ordersFile(dir),
        body +
          [
            '',
            '// yg-suppress-disable(*) generated reconciliation block, debt tracked in the issue tracker',
            'export const reconcileTag = "BADTOKEN";',
            '// yg-suppress-enable(*)',
            '',
          ].join('\n'),
        'utf-8',
      );

      await runAsync(['check', '--approve'], dir);

      // Deterministic ban-foo was waived over the wildcard range — it approves.
      // The wildcard span reached the LLM reviewer too (proving cross-kind parity).
      const prompt = promptFor(mock.chatRequests, 'has-doc-comment');
      expect(prompt).toBeDefined();
      expect(prompt).toContain('</suppressed-ranges>');
      expect(prompt).toContain('<file path="src/services/orders.ts">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await mock.close();
    }
  });
});
