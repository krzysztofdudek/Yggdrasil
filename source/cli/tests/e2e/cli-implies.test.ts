import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  mkdirSync,
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

// ---------------------------------------------------------------------------
// Harness — duplicated from cli-deterministic-lifecycle.test.ts so each e2e
// file is self-contained. Every test runs the real dist/bin.js against a fresh
// mkdtemp copy of the e2e-lifecycle fixture, mutates the COPY only, and rmSync's
// it in finally. Fully hermetic: no network, no clock/random in assertions.
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-implies-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible.
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

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

const aspectDir = (dir: string, id: string) =>
  path.join(dir, '.yggdrasil', 'aspects', id);

const noTodoYamlPath = (dir: string) =>
  path.join(aspectDir(dir, 'no-todo-comments'), 'yg-aspect.yaml');

/**
 * A minimal deterministic aspect whose `check.mjs` flags any line containing
 * `literal`. Created fresh in the temp copy only — zero committed bytes. The
 * aspect is NOT attached to any node/type/flow, so the ONLY way it can become
 * effective on a node is via channel 7 (`implies`). That is what lets these
 * tests isolate the implies channel.
 */
function writeBannedLiteralAspect(dir: string, id: string, literal: string): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    path.join(adir, 'yg-aspect.yaml'),
    [
      `name: ${id.replace(/-/g, '')}`,
      `description: Source files must not contain the literal token ${literal}.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  // Minimal check.mjs: a violation only on the banned literal. Operates on raw
  // file content, language-agnostic, zero LLM cost. Arity-1 (ctx) as the runner
  // requires.
  writeFileSync(
    path.join(adir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      "    const lines = file.content.split('\\n');",
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(literal)})) {`,
      '        violations.push({',
      '          file: file.path,',
      '          line: i + 1,',
      '          column: 0,',
      `          message: ${JSON.stringify(`${literal} token found.`)},`,
      '        });',
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

/**
 * Set the `implies:` list on an aspect's yg-aspect.yaml. Rewrites the file with
 * the base metadata plus an implies block (or no block when `implied` is empty).
 * Used to wire / unwire implies edges in the temp copy.
 */
function setImplies(yamlPath: string, baseLines: string[], implied: string[]): void {
  const lines = [...baseLines];
  if (implied.length > 0) {
    lines.push('implies:');
    for (const id of implied) lines.push(`  - ${id}`);
  }
  lines.push('');
  writeFileSync(yamlPath, lines.join('\n'), 'utf-8');
}

const NO_TODO_BASE = [
  'name: NoTodoComments',
  'description: Source files must not contain TODO comments — track work in the issue tracker, not the code.',
  'reviewer:',
  '  type: deterministic',
  'status: enforced',
];

/**
 * Build a deterministic copy wired with a 2-level implies chain that reaches
 * `services/orders` only via channel 7:
 *
 *   no-todo-comments (architecture type-default on `service`)
 *     └─implies→ no-banned-word (NEW; flags `BANNED`)
 *                  └─implies→ no-fixme (NEW; flags `FIXME`)
 *
 * Neither `no-banned-word` nor `no-fixme` is attached anywhere except through
 * this chain, so their presence in a node's effective set proves implies pulled
 * them in.
 */
function impliesFixture(label: string): string {
  const dir = deterministicFixture(label);
  writeBannedLiteralAspect(dir, 'no-banned-word', 'BANNED');
  writeBannedLiteralAspect(dir, 'no-fixme', 'FIXME');
  // Level 2: no-banned-word implies no-fixme.
  setImplies(
    path.join(aspectDir(dir, 'no-banned-word'), 'yg-aspect.yaml'),
    [
      'name: nobannedword',
      'description: Source files must not contain the literal token BANNED.',
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
    ],
    ['no-fixme'],
  );
  // Level 1: no-todo-comments implies no-banned-word.
  setImplies(noTodoYamlPath(dir), NO_TODO_BASE, ['no-banned-word']);
  return dir;
}

// ---------------------------------------------------------------------------
// IMPLIED ASPECTS — channel 7. Prove `implies` pulls an aspect into a node's
// effective set transitively, enforced at fill (`yg check --approve`), at zero
// LLM cost. Every aspect is deterministic, so the repo-wide fill makes no LLM
// call and plain spawnSync is safe.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — implied aspects (channel 7 / implies)', () => {
  // --- 1. Effective via implies ------------------------------------------
  // no-banned-word reaches services/orders ONLY because no-todo-comments (the
  // service type-default) implies it. yg context lists it with an "implied by"
  // origin, and it is NOT in the node's own/type/flow attachments.
  it('1: an implied aspect is effective on the node with an "implied by" origin', () => {
    const dir = impliesFixture('eff');
    try {
      const { status, stdout } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);

      // The implied aspect appears in the effective set.
      expect(stdout).toContain('no-banned-word');
      // Its origin is channel 7 — implied by the implier, not a direct attach.
      expect(stdout).toContain("implied by 'no-todo-comments'");

      // Sanity: the implier itself is present and shown as implying it.
      expect(stdout).toContain('no-todo-comments');
      expect(stdout).toContain('Implies: no-banned-word');

      // Proof it was NOT directly attached: no-banned-word never appears in the
      // node yaml, the architecture type defaults, or any flow file.
      const nodeYaml = readFileSync(
        path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml'),
        'utf-8',
      );
      const archYaml = readFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'utf-8',
      );
      const flowYaml = readFileSync(
        path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml'),
        'utf-8',
      );
      expect(nodeYaml).not.toContain('no-banned-word');
      expect(archYaml).not.toContain('no-banned-word');
      expect(flowYaml).not.toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Recursive expansion --------------------------------------------
  // no-fixme is 2 levels deep (no-todo → no-banned-word → no-fixme). The implies
  // expansion is recursive, so it is ALSO effective on the node.
  it('2: implies expands recursively — a 2-level-deep aspect is effective', () => {
    const dir = impliesFixture('rec');
    try {
      const { status, stdout } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // The deepest aspect is present, implied by the middle aspect.
      expect(stdout).toContain('no-fixme');
      expect(stdout).toContain("implied by 'no-banned-word'");
      // And the middle aspect advertises that it implies the deepest one.
      expect(stdout).toContain('Implies: no-fixme');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Enforcement of the implied aspect ------------------------------
  // A BANNED line violates no-banned-word, an aspect reachable ONLY via implies.
  // approve must refuse — proving implied aspects are enforced, not decorative.
  it('3: a violation of the implied no-banned-word aspect refuses the fill (exit 1)', () => {
    const dir = impliesFixture('enf');
    try {
      // Clean baseline first.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// this constant is BANNED here\n');
      const { status, stdout, stderr } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('no-banned-word');
      // The old per-issue WHAT line 0 ("... is refused on <unit> by a
      // deterministic check") is now the group header; assert the grouped render
      // — the enforced group naming the implied aspect and the refusing node line.
      expect(stdout).toContain("aspect 'no-banned-word'");
      expect(stdout).toContain('- services/orders');
      // The implied aspect's pair refused while the implier itself
      // (no-todo-comments) was satisfied — its fill pair is approved. (The fill
      // summary no longer echoes individual violation messages such as "BANNED
      // token found." — that per-violation detail now lives in `yg aspect-test`.)
      // Fill-time progress ([det] lines) go to STDERR; final report to STDOUT.
      expect(stderr).toContain('[det] no-banned-word on node:services/orders — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Recursive enforcement ------------------------------------------
  // A FIXME line violates no-fixme, reachable only via the 2-level implies
  // chain. approve must refuse on no-fixme.
  it('4: a violation of the 2-level-deep no-fixme aspect refuses the fill (exit 1)', () => {
    const dir = impliesFixture('recenf');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// FIXME: handle this case\n');
      const { status, stdout, stderr } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('no-fixme');
      // The old per-issue WHAT line 0 ("Aspect '...' is refused on <unit> ...")
      // is now the group header; assert the grouped render — the enforced group
      // naming the 2-level-deep implied aspect and the refusing node line.
      expect(stdout).toContain("aspect 'no-fixme'");
      expect(stdout).toContain('- services/orders');
      // The 2-level-deep implied aspect's pair refused. (Per-violation message
      // text "FIXME token found." moved to `yg aspect-test`; the fill summary
      // reports the pair-level refusal only.)
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(stderr).toContain('[det] no-fixme on node:services/orders — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. Remove the implies link ----------------------------------------
  // Deleting `implies: [no-banned-word]` from no-todo-comments severs the whole
  // chain: no-banned-word AND no-fixme drop out of the effective set, and a
  // BANNED line that previously refused now approves clean. This proves the
  // implies edge was the ONLY thing pulling those aspects in.
  it('5: removing the implies edge unlinks the chain — BANNED line then approves clean', () => {
    const dir = impliesFixture('rm');
    try {
      // With the chain wired, a BANNED line refuses.
      appendFileSync(ordersFile(dir), '\n// this is BANNED\n');
      const wired = run(['check', '--approve'], dir);
      expect(wired.status).toBe(1);
      expect(wired.stdout).toContain('no-banned-word');
      // The old per-issue WHAT line 0 ("... is refused on <unit> ...") is now the
      // group header; assert the grouped render — the enforced group naming the
      // implied aspect and the refusing node line — proving the chain was wired.
      expect(wired.stdout).toContain("aspect 'no-banned-word'");
      expect(wired.stdout).toContain('- services/orders');

      // Sever the chain at level 1: no-todo-comments no longer implies anything.
      setImplies(noTodoYamlPath(dir), NO_TODO_BASE, []);

      // Both implied aspects are gone from the effective set.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain('no-banned-word');
      expect(ctx.stdout).not.toContain('no-fixme');
      expect(ctx.stdout).not.toContain('implied by');

      // The BANNED line is still in the source, but no aspect flags it now — the
      // fill is clean (no refusal) and `yg check` PASSES. (Severing the edge
      // leaves no-banned-word/no-fixme orphaned, so their ids still surface as
      // non-blocking orphaned-aspect warnings — hence assert on the absence of a
      // REFUSAL rather than the absence of the id.)
      const cleared = run(['check', '--approve'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('yg check: PASS');
      expect(cleared.all).not.toContain('is refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. status_inherit (default 'strictest') ---------------------------
  // The implied aspect's effective status is structurally derived from the
  // implier's. Default `status_inherit: strictest` promotes the implied aspect
  // to the implier's status when higher; an enforced implier keeps an enforced
  // implied aspect enforced — so its violation BLOCKS yg check (error, not
  // warning). We assert the implied aspect renders [enforced] and that its
  // violation surfaces as a blocking error.
  it('6: an enforced-implied aspect keeps enforced status and blocks check', () => {
    const dir = impliesFixture('status');
    try {
      // Fill clean, then introduce a BANNED violation and let check see it.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // context renders the implied aspect at enforced status.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');
      expect(ctx.stdout).toContain('no-fixme [enforced]');

      // A BANNED violation blocks the fill (enforced → exit 1, error), confirming
      // the implied aspect is enforced rather than downgraded.
      appendFileSync(ordersFile(dir), '\n// BANNED token\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1); // enforced implied aspect blocks
      expect(fill.stdout).toContain('no-banned-word');
      // The old per-issue WHAT line 0 ("... is refused on <unit> ...") is now the
      // group header; assert the grouped render — the ENFORCED group (not advisory)
      // naming the implied aspect and the refusing node line, proving the implied
      // aspect kept enforced status and blocked.
      expect(fill.stdout).toContain('enforced');
      expect(fill.stdout).toContain("aspect 'no-banned-word'");
      expect(fill.stdout).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7. status_inherit: own-default ------------------------------------
  // With `status_inherit: own-default` on the implies edge, the implied aspect
  // is anchored to its OWN aspect-level default instead of promoting to the
  // implier's status. Here we give no-banned-word its own `status: advisory`
  // default and pin the edge to own-default, so the implied aspect stays
  // advisory: a BANNED violation becomes a non-blocking warning (approve exits
  // 0, check exits 0) rather than an error.
  it('7: status_inherit own-default anchors the implied aspect to its own (advisory) default', () => {
    const dir = deterministicFixture('owndefault');
    try {
      // no-banned-word with advisory own-default, not attached anywhere.
      writeBannedLiteralAspect(dir, 'no-banned-word', 'BANNED');
      writeFileSync(
        path.join(aspectDir(dir, 'no-banned-word'), 'yg-aspect.yaml'),
        [
          'name: nobannedword',
          'description: Source files must not contain the literal token BANNED.',
          'reviewer:',
          '  type: deterministic',
          'status: advisory',
          '',
        ].join('\n'),
        'utf-8',
      );
      // no-todo-comments (enforced) implies it, but with own-default inherit so
      // the advisory default is preserved instead of promoting to enforced.
      writeFileSync(
        noTodoYamlPath(dir),
        [
          ...NO_TODO_BASE,
          'implies:',
          '  - id: no-banned-word',
          '    status_inherit: own-default',
          '',
        ].join('\n'),
        'utf-8',
      );

      // The implied aspect renders advisory, NOT promoted to enforced.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');
      expect(ctx.stdout).toContain("implied by 'no-todo-comments'");

      // A BANNED violation is advisory → does not block the fill or check.
      appendFileSync(ordersFile(dir), '\n// BANNED token\n');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory does NOT block the fill
      expect(fill.stdout).toContain('no-banned-word');
      // The advisory refusal renders under the Warnings section (non-blocking).
      // The old per-issue "(advisory — not blocking)" Fix suffix only existed in
      // the per-issue renderer; the GROUP renderer (default full view) has no such
      // suffix — assert the grouped warning render instead.
      expect(fill.stdout).toMatch(/Warnings \(\d+\)( in \d+ groups)?:/);
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain("aspect 'no-banned-word'");
      expect(fill.stdout).toContain('- services/orders');

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory violation does NOT fail check
      expect(check.stdout).toContain('no-banned-word');
      expect(check.stdout).toContain('advisory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 8. implies cycle, attached directly -------------------------------
  // A mutual implies cycle (a → b → a) where one of the cycle aspects is
  // attached to a node directly. yg check reports the static aspect-implies-cycle
  // validation error cleanly (exit 1). The generic two-aspect cycle is also
  // covered in cli-check-validation.test.ts; this variant additionally proves
  // the cycle aspects can be deterministic and attached via the node's own
  // declaration.
  it('8: a directly-attached implies cycle is reported as aspect-implies-cycle (exit 1)', () => {
    const dir = deterministicFixture('cycle');
    try {
      writeBannedLiteralAspect(dir, 'cyc-a', 'BANNED');
      writeBannedLiteralAspect(dir, 'cyc-b', 'BANNED');
      // a → b
      setImplies(
        path.join(aspectDir(dir, 'cyc-a'), 'yg-aspect.yaml'),
        ['name: cyca', 'description: Cycle A.', 'reviewer:', '  type: deterministic', 'status: enforced'],
        ['cyc-b'],
      );
      // b → a  (closes the cycle)
      setImplies(
        path.join(aspectDir(dir, 'cyc-b'), 'yg-aspect.yaml'),
        ['name: cycb', 'description: Cycle B.', 'reviewer:', '  type: deterministic', 'status: enforced'],
        ['cyc-a'],
      );
      // Attach cyc-a directly to the orders node (channel 1).
      const nodeYamlPath = path.join(
        dir,
        '.yggdrasil',
        'model',
        'services',
        'orders',
        'yg-node.yaml',
      );
      appendFileSync(nodeYamlPath, '');
      const nodeYaml = readFileSync(nodeYamlPath, 'utf-8').replace(
        /aspects:\n/,
        'aspects:\n  - cyc-a\n',
      );
      writeFileSync(nodeYamlPath, nodeYaml, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-implies-cycle');
      // The old per-issue WHAT that named the cycle members (cyc-a, cyc-b) is gone
      // in the grouped renderer (aspect-implies-cycle is a structural code, not a
      // FULL_WHAT code). Assert the group's shared `why` + `Fix:` guidance, which
      // conveys the same intent: the cycle was detected with an actionable fix.
      expect(stdout).toContain('Cycles in implies prevent aspect resolution.');
      expect(stdout).toContain('Fix: Break the cycle by removing one implies edge.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 9. implies cycle introduced after the lock exists -----------------
  // When an implies cycle is introduced AFTER the lock already holds verified
  // verdicts, `yg check` walks the implies graph while resolving effective
  // aspects before the validator's static aspect-implies-cycle issue is
  // rendered. The implies cycle is raised as a recognizable ImpliesCycleError
  // that resolution catches and surfaces as the structured issue — so the graph
  // being structurally invalid no longer crashes check with an unclassified
  // "file an issue" wrapper. The user sees the SAME structured
  // `aspect-implies-cycle` error as the no-lock case (test 8), regardless of
  // whether a lock exists.
  it('9: cycle introduced post-lock reports aspect-implies-cycle (exit 1), no crash', () => {
    const dir = impliesFixture('cyclepostbaseline');
    try {
      // Establish the lock (verified verdicts) while the chain is acyclic.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Close a cycle downstream: no-fixme → no-banned-word (already
      // no-banned-word → no-fixme), forming no-banned-word ↔ no-fixme.
      setImplies(
        path.join(aspectDir(dir, 'no-fixme'), 'yg-aspect.yaml'),
        [
          'name: nofixme',
          'description: Source files must not contain the literal token FIXME.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
        ],
        ['no-banned-word'],
      );

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // Clean structured validation error — same as test 8.
      expect(all).toContain('aspect-implies-cycle');
      // The old per-issue WHAT that named the cycle members (no-banned-word,
      // no-fixme) is gone in the grouped renderer (aspect-implies-cycle is a
      // structural code, not a FULL_WHAT code). Assert the group's shared `why` +
      // `Fix:` — same structured guidance as test 8, proving no crash wrapper.
      expect(all).toContain('Cycles in implies prevent aspect resolution.');
      expect(all).toContain('Fix: Break the cycle by removing one implies edge.');
      // NOT the unclassified crash wrapper.
      expect(all).not.toContain('Unexpected error');
      expect(all).not.toContain('This is a bug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 10. implies cycle blocks --approve outright ------------------------
  // An implies cycle makes the graph's aspect resolution unreliable everywhere,
  // not only for the cycle's own members — so `check --approve` must refuse
  // the WHOLE run before dispatching anything, rather than spending reviewer
  // calls on unrelated pairs (no-todo-comments here) before ending red. This
  // is the fill-stage counterpart to test 9's plain-`check` read: same cycle,
  // but through the write path, asserting nothing gets dispatched and no lock
  // byte changes.
  it('10: check --approve refuses outright on an implies cycle, dispatching nothing and writing no lock', () => {
    const dir = impliesFixture('approvecycle');
    try {
      // Establish the lock (verified verdicts) while the chain is acyclic.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      const lockFiles = [
        'yg-lock.nondeterministic.json',
        'yg-lock.logs.json',
        '.yg-lock.deterministic.json',
      ].map((f) => path.join(dir, '.yggdrasil', f));
      const before = lockFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : null));

      // Close a cycle downstream: no-fixme → no-banned-word (already
      // no-banned-word → no-fixme), forming no-banned-word ↔ no-fixme.
      setImplies(
        path.join(aspectDir(dir, 'no-fixme'), 'yg-aspect.yaml'),
        [
          'name: nofixme',
          'description: Source files must not contain the literal token FIXME.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
        ],
        ['no-banned-word'],
      );

      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(1);

      // The gating header: what happened and where to look next. It stays
      // generic on purpose (the same header fires for a broken reviewer config
      // too) so it must not claim a config/tier problem that isn't there for a
      // cycle — it says only that nothing ran.
      expect(all).toContain('yg check --approve aborted');
      expect(all).toContain('must be fixed before anything runs');
      expect(all).toContain('Fix the errors below, then re-run: yg check --approve');
      // What actually tells the user THIS run's problem is a cycle — not the
      // generic header above, which is deliberately silent on specifics — is
      // the cycle's own diagnostic underneath, not buried: same what/why/next
      // test 9 sees on a plain `check`, naming both members and the concrete fix.
      expect(all).toContain('Aspect implies cycle:');
      expect(all).toContain('no-banned-word');
      expect(all).toContain('no-fixme');
      expect(all).toContain('Cycles in implies prevent aspect resolution.');
      expect(all).toContain('Break the cycle by removing one implies edge.');

      // Nothing was dispatched — not even the unrelated no-todo-comments pair;
      // the abort happens before the pre-dispatch plan is ever printed.
      expect(all).not.toContain('[det]');
      expect(all).not.toContain('[llm]');

      // Nothing was written: every lock file is byte-identical to the
      // pre-cycle baseline (or still absent, for any that never existed).
      const after = lockFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : null));
      expect(after).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
