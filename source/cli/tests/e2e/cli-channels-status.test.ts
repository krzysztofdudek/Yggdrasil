import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so `yg check --approve` never produces an environment-dependent LLM
// verdict — port 1 never has a listener, on ANY machine, with no reliance on a
// real endpoint being present or absent. Used by killReviewer().
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

// Harness — REUSED verbatim from cli-deterministic-lifecycle.test.ts /
// cli-channels.test.ts: spawnSync run(args, cwd), BIN_PATH resolution, the
// distExists guard with describe.skipIf, copyFixture(label) on mkdtempSync +
// cpSync, deterministicFixture (strip the LLM aspect) and killReviewer (repoint
// the endpoint at the dead loopback). Every aspect this suite uses is
// reviewer.type: deterministic, so `yg check --approve` makes NO LLM call and needs NO
// reviewer endpoint — nothing here touches the network, the clock, or randomness.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-chst-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic — no network, no LLM verdict, fully
 * reproducible. The `no-banned-word` aspect this suite authors per-test drives
 * every warn/skip/block outcome.
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

/** Repoint the reviewer endpoint at the dead loopback address (belt-and-braces:
 *  the LLM aspect is already removed, but this guarantees no test can reach out
 *  even if a future fixture edit reintroduces one). */
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
const archYaml = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const flowYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');

/**
 * Author the deterministic aspect `no-banned-word` (flags any line containing
 * the literal token `BANNED`). Raw-content check — no AST, fully hermetic. Its
 * yg-aspect.yaml default `status:` is set from `defaultStatus` so each test can
 * exercise the status that arrives through the channel under test.
 *
 * The aspect is NOT attached anywhere by this helper — each test attaches it on
 * exactly the channel under test, so the `Source:` line is unambiguous.
 */
function authorBannedAspect(dir: string, defaultStatus: 'draft' | 'advisory' | 'enforced'): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'no-banned-word');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: NoBannedWord',
      'description: Source files must not contain the banned token BANNED.',
      'reviewer:',
      '  type: deterministic',
      `status: ${defaultStatus}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      '      if (lines[i].includes("BANNED")) {',
      '        violations.push({ file: file.path, line: i + 1, column: 0, message: "Banned token found." });',
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Plant a BANNED token in the orders source so `no-banned-word` would trip if run. */
function plantBannedToken(dir: string): void {
  appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
}

/**
 * Rewrite yg-architecture.yaml. `serviceAspects` is the verbatim aspect list for
 * the `service` (own) type → channel 3. `moduleAspects` (optional) is the list
 * for the `module` (ancestor) type → channel 4. Either may carry bare ids or
 * object-form `- id: x` / `  status: y` lines. The LLM aspect is never added.
 */
function writeArchitecture(
  dir: string,
  serviceAspects: string[],
  moduleAspects: string[] = [],
): void {
  const lines = [
    'node_types:',
    '  module:',
    "    description: 'Organizational grouping of related services. Parent-only — has no file mapping.'",
    '    log_required: false',
    ...(moduleAspects.length > 0 ? ['    aspects:', ...moduleAspects.map((l) => `    ${l}`)] : []),
    '',
    '  service:',
    "    description: 'Discrete service unit implemented as a single source file under src/services/.'",
    '    log_required: false',
    '    when:',
    '      path: "src/services/**"',
    '    parents: [module]',
    '    aspects:',
    ...serviceAspects.map((l) => `    ${l}`),
    '    relations:',
    '      uses: [service]',
    '      calls: [service]',
    '',
  ];
  writeFileSync(archYaml(dir), lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// STATUS (draft / advisory) propagation on the CASCADING channels CH3 (own arch
// type-default) and CH4 (ancestor arch type-default), plus a cross-channel
// max() pairing not exercised elsewhere. The risk being closed: an advisory
// aspect arriving via a type-default that WRONGLY blocks CI, or a draft one that
// WRONGLY runs. Each test proves BOTH the `yg context` status tag AND the
// approve/check warn-vs-skip-vs-block outcome.
//
// Deliberately NOT duplicated here (covered elsewhere, verified):
//   - CH5 (flow) advisory→warning + draft→skip  → cli-flows-advanced CF3/CF4/CF6/CF7
//   - CH6 (port) advisory→warning + draft→skip   → cli-ports-extended C5/C6/C7
//   - cross-channel draft+enforced max via CH2+CH4 → cli-channels-extended F1
//   - CH3 enforced refuse (no-todo-comments type default) → cli-deterministic-lifecycle A4
//   - CH4 enforced refuse (module-type default)   → cli-channels scenario 2
// This suite adds the missing CH3/CH4 ADVISORY-warn and DRAFT-skip paths, and a
// fresh CH3-draft + CH5-enforced max() pairing (F1 only proves CH2+CH4).
//
// Fully hermetic: each test copies into a fresh mkdtemp, strips the LLM aspect,
// points the reviewer at a dead loopback endpoint, and rmSync's in finally.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — status propagation on cascading channels (CH3/CH4 advisory-warn & draft-skip, cross-channel max)', () => {
  // === CH3 — own ARCHITECTURE TYPE default (service) ===

  it('1: an ADVISORY aspect via CH3 (own type default) — context tags [advisory] with Source: architecture (type: service); a violation WARNS, never blocks (approve exit 0, check PASS)', () => {
    const dir = hermeticFixture('ch3-advisory');
    try {
      authorBannedAspect(dir, 'advisory');
      // CH3 ONLY: bare attach on the `service` (own) type default.
      writeArchitecture(dir, [
        '  - no-todo-comments',
        '  - requires-named-export',
        '  - no-banned-word',
      ]);

      // Context attributes the aspect to the OWN type and tags it advisory.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');
      expect(ctx.stdout).toContain('Source: architecture (type: service)');

      // Plant the violation, then fill repo-wide. The fill is repo-scoped, so it
      // records both nodes in one pass — no need to seed the other node first.
      plantBannedToken(dir);

      // Advisory via CH3 does NOT block the fill — exit 0, recorded-not-blocking.
      // The removed per-node approve banner ("advisory aspect violation(s) ..."
      // / "not blocking: ...") is replaced by the fill's non-blocking warning.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stderr).toContain('[det] no-banned-word on node:services/orders — refused');
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain('services/orders');
      expect(fill.stdout).toContain('no-banned-word');
      // The advisory violation renders under the Warnings section as an
      // `advisory` group (the grouped renderer drops the old per-issue
      // "(advisory — not blocking)" suffix; non-blocking is shown by the
      // Warnings section + PASS verdict). A second warning group
      // (`rules-digest-stale`) is always present too — this fixture never ran
      // `yg init`, so it carries no AGENTS.md/CLAUDE.md/.clinerules digest
      // artifacts, and the committed-digest staleness gate flags that on every
      // `yg check`/`yg check --approve` here. It is unrelated to the aspect
      // under test, so we assert its presence explicitly rather than let it
      // silently inflate the count.
      expect(fill.stdout).toContain('Warnings (2) in 2 groups:');
      expect(fill.stdout).toContain("advisory  1 pairs  1 nodes  aspect 'no-banned-word'");
      expect(fill.stdout).toContain('rules-digest-stale');

      // `yg check` renders it as a non-blocking warning and PASSES.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS (2 warnings)');
      expect(check.stdout).toContain('advisory');
      expect(check.stdout).toContain('services/orders');
      expect(check.stdout).toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a DRAFT aspect via CH3 (own type default) — context tags [draft] (reviewer skipped); the violating token is IGNORED, approve announces the skip and exits 0', () => {
    const dir = hermeticFixture('ch3-draft');
    try {
      authorBannedAspect(dir, 'draft');
      writeArchitecture(dir, [
        '  - no-todo-comments',
        '  - requires-named-export',
        '  - no-banned-word',
      ]);

      // Context shows the draft aspect attributed to the own type, with the
      // skipped note — NOT a live `read:` line.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [draft]');
      expect(ctx.stdout).toContain('Source: architecture (type: service)');
      expect(ctx.stdout).toContain('(reviewer skipped; aspect is draft)');

      // The token the draft check WOULD flag is planted, yet the fill ignores it:
      // a draft aspect is never run, so it contributes no fill pair and no
      // verdict. (The old per-node approve emitted an explicit "[draft] ...
      // skipped" banner; in the fill model a draft aspect is simply absent from
      // the dispatch — proven by the lack of any no-banned-word pair below.)
      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      // The draft aspect produced no verdict — it never entered the fill and no
      // refusal text exists for it.
      expect(fill.all).not.toContain('no-banned-word on node:services/orders');
      expect(fill.all).not.toContain('is refused');

      // And `yg check` stays green — the draft aspect never blocks.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === CH4 — ancestor ARCHITECTURE TYPE default (module) ===

  it('3: an ADVISORY aspect via CH4 (ancestor type default, module) — context tags [advisory] with Source: inherited from parent (type: module); a violation WARNS, never blocks (approve exit 0, check PASS)', () => {
    const dir = hermeticFixture('ch4-advisory');
    try {
      authorBannedAspect(dir, 'advisory');
      // CH4 ONLY: default on the `module` (ancestor) type. The service type
      // carries no `no-banned-word`, so the only path to the child is CH4.
      writeArchitecture(
        dir,
        ['  - no-todo-comments', '  - requires-named-export'],
        ['  - no-banned-word'],
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');
      expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');

      plantBannedToken(dir);

      // Advisory via CH4 does NOT block the fill — exit 0, recorded-not-blocking.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stderr).toContain('[det] no-banned-word on node:services/orders — refused');
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain('services/orders');
      expect(fill.stdout).toContain('no-banned-word');
      // The advisory violation renders under the Warnings section as an
      // `advisory` group (the grouped renderer drops the old per-issue
      // "(advisory — not blocking)" suffix; non-blocking is shown by the
      // Warnings section + PASS verdict). A second warning group
      // (`rules-digest-stale`) is always present too — see the comment on the
      // CH3 case above.
      expect(fill.stdout).toContain('Warnings (2) in 2 groups:');
      expect(fill.stdout).toContain("advisory  1 pairs  1 nodes  aspect 'no-banned-word'");
      expect(fill.stdout).toContain('rules-digest-stale');

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS (2 warnings)');
      expect(check.stdout).toContain('advisory');
      expect(check.stdout).toContain('services/orders');
      expect(check.stdout).toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a DRAFT aspect via CH4 (ancestor type default, module) — context tags [draft] (reviewer skipped); the violating token is IGNORED, approve announces the skip and exits 0', () => {
    const dir = hermeticFixture('ch4-draft');
    try {
      authorBannedAspect(dir, 'draft');
      writeArchitecture(
        dir,
        ['  - no-todo-comments', '  - requires-named-export'],
        ['  - no-banned-word'],
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [draft]');
      expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');
      expect(ctx.stdout).toContain('(reviewer skipped; aspect is draft)');

      // A draft aspect is never run, so it contributes no fill pair and no
      // verdict — the planted token is ignored (old "[draft] ... skipped" banner
      // is replaced by the aspect's plain absence from the fill dispatch).
      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      expect(fill.all).not.toContain('no-banned-word on node:services/orders');
      expect(fill.all).not.toContain('is refused');

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Cross-channel max() — a cascading channel contributes DRAFT, another
  //     contributes ENFORCED → effective ENFORCED. Distinct pairing from
  //     cli-channels-extended F1 (CH2 draft + CH4 enforced): here the draft
  //     contributor is CH3 (own type default) and the enforced one is CH5 (flow).

  it('5: CH3 contributes DRAFT and CH5 (flow) contributes ENFORCED for the SAME aspect → max() = enforced — context tags [enforced] with no downgrade error; a violation BLOCKS approve (exit 1) and FAILS check', () => {
    const dir = hermeticFixture('max-draft-enforced-ch3-ch5');
    try {
      // Aspect DEFAULT draft.
      authorBannedAspect(dir, 'draft');
      // CH3: bare attach on the service (own) type → inherits the draft default
      // (no explicit attach-site status, so no downgrade attempt).
      writeArchitecture(dir, [
        '  - no-todo-comments',
        '  - requires-named-export',
        '  - no-banned-word',
      ]);
      // CH5: the flow attaches the SAME aspect with explicit status: enforced.
      writeFileSync(
        flowYaml(dir),
        [
          'name: OrderProcessing',
          'description: End-to-end processing of a customer order, from creation through payment.',
          'nodes:',
          '  - services/orders',
          '  - services/payments',
          'aspects:',
          '  - no-todo-comments',
          '  - id: no-banned-word',
          '    status: enforced',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Effective status is the STRICTEST contributor → enforced. The draft
      // contributor does NOT pin it to draft, and combining a bare-inherited
      // draft cascade with an enforced channel is legal (no downgrade error).
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');
      expect(ctx.all).not.toContain('aspect-status-downgrade');

      // A clean fill passes (the now-enforced aspect is satisfied).
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // The same token that was a mere skip when the aspect was draft (tests 2/4)
      // now BLOCKS, because the flow channel raised it to enforced.
      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Fill-time line names the refused deterministic pair on the node.
      expect(fill.stderr).toContain('[det] no-banned-word on node:services/orders — refused');
      // The grouped error body lists the node under the enforced group.
      expect(fill.stdout).toContain("enforced  1 pairs  1 nodes  aspect 'no-banned-word'");
      expect(fill.stdout).toContain('- services/orders');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('FAIL');
      expect(check.stdout).toContain('enforced');
      expect(check.stdout).toContain('services/orders');
      expect(check.stdout).toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
