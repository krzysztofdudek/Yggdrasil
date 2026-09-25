import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
import { readLock as readTriadLock, detLockPath, nondetLockPath, logsLockPath } from './support/read-lock.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

// ---------------------------------------------------------------------------
// CLI E2E — the DETERMINISTIC FILL LIFECYCLE (verdict-lock model).
//
// The lifecycle is now: cold `yg check` (unverified, exit 1) → `yg check
// --approve` (deterministic fill, writes the gitignored
// .yggdrasil/.yg-lock.deterministic.json) → `yg check` (verified, exit 0) →
// source edit → unverified → `yg check --approve` (refused or approved) → fix →
// fill → verified. There is no `yg approve` command, no `.drift-state/`, and no
// drift/baseline vocabulary — verification state lives in the committed lock
// triad (yg-lock.nondeterministic.json + yg-lock.logs.json) plus the gitignored
// .yg-lock.deterministic.json, and the states are verified / unverified / refused.
//
// Hermetic — no LLM, no network dependency: the fixture's LLM aspect is stripped
// so the deterministic `no-todo-comments` (enforced) and `requires-named-export`
// (advisory) checks drive every refuse/pass outcome. Each test builds its own
// temp copy of the committed e2e-lifecycle fixture and removes it in a finally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so a fill records deterministic-only verdicts and never
// produces an unreliable (or environment-dependent) LLM verdict. The
// reviewer-unreachable test uses this so its assertion holds on ANY machine —
// port 1 never has a listener — with no dependency on any real endpoint being
// absent.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-fill-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced) and `requires-named-export` (advisory)
 * deterministic aspects drive every refuse/pass outcome.
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
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the reviewer is ALWAYS unreachable regardless of the machine — no reliance
 * on any specific external host being present or absent.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

// The deterministic fill writes its verdicts to the gitignored
// .yg-lock.deterministic.json — the on-disk presence of THIS file is the signal
// that a deterministic fill has run (the committed nondeterministic/logs files
// carry no deterministic verdicts). The deterministic-fixture aspects under test
// (`no-todo-comments`, `requires-named-export`) are all deterministic, so this is
// the triad file every verdict assertion here actually lands in.
const detLockFile = (dir: string) => detLockPath(path.join(dir, '.yggdrasil'));

type Lock = ReturnType<typeof readTriadLock>;
type LockEntry = NonNullable<Lock['verdicts'][string][string]>;

/** Read the unified lock by merging the on-disk triad (committed + gitignored det file). */
function readLock(dir: string): Lock {
  return readTriadLock(path.join(dir, '.yggdrasil'));
}

/** The stored verdict for an (aspect, node) pair, or undefined if absent. */
function verdictFor(lock: Lock, aspectId: string, node: string): LockEntry | undefined {
  return lock.verdicts[aspectId]?.[`node:${node}`];
}

// ---------------------------------------------------------------------------
// A–E: Deterministic fill lifecycle. Hermetic — no LLM, no network dependency.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — deterministic fill/verify/refuse/status/suppress lifecycle', () => {
  // --- A. Fill + verify lifecycle ---

  it('A1: cold check is unverified (exit 1); the fill writes the lock and a later check is verified (exit 0)', () => {
    const dir = deterministicFixture('a1');
    try {
      // Cold start: no lock yet → every pair is unverified, check fails.
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.stdout).toContain('error[unverified]');
      // The capped view counts pairs per rule; --details names each pair.
      expect(run(['check', '--details'], dir).stdout).toMatch(/no-todo-comments @ services\/orders$/m);
      expect(existsSync(detLockFile(dir))).toBe(false);

      // Fill: deterministic checks run locally and record approved verdicts.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Progress lines (the `fill  …` lines) go to STDERR; final report to STDOUT.
      expect(fill.stdout).toContain('yg check: PASS');
      // The fill writes the deterministic verdict lock with an approved entry for the pair.
      expect(existsSync(detLockFile(dir))).toBe(true);
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');

      // A subsequent plain check sees valid verdicts and passes with no fill.
      const verified = run(['check'], dir);
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('A2: after a fill, check reports no unverified pair for that node', () => {
    const dir = deterministicFixture('a2');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { stdout } = run(['check'], dir);
      // No unverified line should mention services/orders.
      const unverifiedForOrders = stdout
        .split('\n')
        .filter((l) => l.includes('unverified') && l.includes('services/orders'));
      expect(unverifiedForOrders.length).toBe(0);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('A3: a TODO source edit invalidates the verdict — check reports the pair as unverified (exit 1)', () => {
    const dir = deterministicFixture('a3');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // The source hash changed, so the stored verdict no longer hashes-valid.
      // The unverified block names the cause (stale inputs) in its subject and
      // the pair (`<aspect> @ <node>`) on its member line.
      expect(stdout).toContain('error[unverified] 1 pair whose inputs changed since the verdict');
      expect(stdout).toMatch(/^ {2}at: +no-todo-comments @ services\/orders$/m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('A4: filling with the enforced no-todo-comments violation present records a refused verdict (exit 1)', () => {
    const dir = deterministicFixture('a4');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Progress (the fill's closing line) goes to STDERR; final report to STDOUT.
      // The closing line counts the refusal, and the check renderer surfaces the
      // enforced refusal as a blocking error[refused] block whose member line
      // names the node, the violating line and the violation message.
      expect(fill.stderr).toMatch(/^fill {2}done in .* — 1 passed · 1 refused · 0 failed/m);
      expect(fill.stdout).toContain('error[refused] no-todo-comments — 1 violation in services/orders');
      expect(fill.stdout).toMatch(/^ {2}at: +services\/orders {2}src\/services\/orders\.ts:\d+ {2}TODO comment found/m);
      // The lock records the refused verdict (with the violation text in reason).
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('refused');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('A5: removing the TODO and re-filling records an approved verdict again (exit 0)', () => {
    const dir = deterministicFixture('a5');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const original = readFileSync(ordersFile(dir), 'utf-8');
      // Introduce then remove the violation.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      expect(run(['check', '--approve'], dir).status).toBe(1);
      writeFileSync(ordersFile(dir), original, 'utf-8');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- B. Status levels ---

  it('B6: an advisory requires-named-export refusal is a non-blocking warning — fill and check both exit 0', () => {
    const dir = deterministicFixture('b6');
    try {
      // Remove the named exports so the advisory aspect flags the file.
      const stripped = readFileSync(paymentsFile(dir), 'utf-8').replace(/^export /gm, '');
      writeFileSync(paymentsFile(dir), stripped, 'utf-8');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory refusal does NOT block the fill
      // Progress (the fill's closing line) goes to STDERR; final report to STDOUT.
      expect(fill.stderr).toMatch(/^fill {2}done in .* · 1 refused · /m);
      expect(fill.stdout).toContain('warning[refused] requires-named-export — 1 violation in services/payments');
      expect(fill.stdout).not.toContain('error[refused]');

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory warning does NOT fail check
      expect(check.stdout).toContain('warning[refused] requires-named-export — 1 violation in services/payments');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('B7: a draft wip-rule is never evaluated — a WIP line is not flagged and produces no pair', () => {
    const dir = deterministicFixture('b7');
    try {
      appendFileSync(ordersFile(dir), '\n// WIP marker here\n');
      const fill = run(['check', '--approve'], dir);
      // The draft aspect never produces a pair, so the fill never mentions it on
      // either stderr (progress) or stdout (report).
      expect(fill.stderr).not.toContain('wip-rule');
      expect(fill.stdout).not.toContain('wip-rule');
      // ...and the WIP line itself caused no deterministic refusal (no TODO present).
      expect(fill.stdout).not.toContain('refused');
      expect(fill.status).toBe(0);
      // The draft is still counted in the header metrics.
      expect(fill.stdout).toContain('1 draft');
      // No verdict is recorded for the draft aspect.
      const lock = readLock(dir);
      expect(lock.verdicts['wip-rule']).toBeUndefined();
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- C. Suppress ---

  it('C8: yg-suppress waives the violation; removing it makes the fill refuse again', () => {
    const dir = deterministicFixture('c8');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Single-line suppress: it covers the immediately-following line.
      const withSuppress =
        readFileSync(ordersFile(dir), 'utf-8') +
        '\n// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker\n' +
        '// TODO: refactor this later\n';
      writeFileSync(ordersFile(dir), withSuppress, 'utf-8');

      const suppressed = run(['check', '--approve'], dir);
      expect(suppressed.status).toBe(0); // violation waived
      // Progress (the `fill  …` lines) goes to STDERR; final report to STDOUT.
      expect(suppressed.stdout).toContain('yg check: PASS');

      // Remove the suppress marker but keep the TODO line.
      const withoutSuppress = readFileSync(ordersFile(dir), 'utf-8')
        .split('\n')
        .filter((l) => !l.includes('yg-suppress(no-todo-comments)'))
        .join('\n');
      writeFileSync(ordersFile(dir), withoutSuppress, 'utf-8');

      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1); // the suppress was what waived it
      // Progress (the fill's closing line) goes to STDERR; final report to STDOUT.
      expect(refused.stderr).toMatch(/^fill {2}done in .* · 1 refused · /m);
      // The blocking refusal block names the aspect and the node; its member line
      // carries the violating line and the violation message.
      expect(refused.stdout).toContain('error[refused] no-todo-comments — 1 violation in services/orders');
      expect(refused.stdout).toMatch(/^ {2}at: +services\/orders {2}src\/services\/orders\.ts:\d+ {2}TODO comment found/m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- D. Aspect change invalidates verdicts (the upstream-input change) ---

  it('D9: editing the aspect check.mjs invalidates both nodes (unverified); a re-fill restores them', () => {
    const dir = deterministicFixture('d9');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Trivial no-op change to the aspect's implementation. The aspect bytes are
      // an input to the pair hash, so both nodes' no-todo-comments verdicts go stale.
      appendFileSync(
        path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'),
        '\n// trivial no-op comment\n',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // Both nodes report the no-todo-comments pair as unverified. The capped
      // view collapses them into one rule line counting both nodes; --details
      // lists each pair on its own line.
      expect(drifted.stdout).toContain('error[unverified] 2 pairs whose inputs changed since the verdict');
      expect(drifted.stdout).toMatch(/^ {2}at: +no-todo-comments {2}2 pairs · 2 nodes · script$/m);
      const details = run(['check', '--details'], dir).stdout;
      expect(details).toMatch(/no-todo-comments @ services\/orders$/m);
      expect(details).toMatch(/no-todo-comments @ services\/payments$/m);

      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      // Progress ([det] fill outcomes) go to STDERR; final report to STDOUT.

      // The pairs are valid again after the re-fill.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- E. Guards / errors ---
  //
  // The old E10/E11 guards (`approve --node + --aspect` multi-target, `approve
  // --aspect --dry-run`) targeted the removed `yg approve` command and its
  // batch-targeting / dry-run flags. Fill is repo-wide with no scoping and no
  // dry-run, so those guards no longer exist. E12 (approve of a nonexistent
  // node) is re-pointed onto `yg aspect-test --node`, which keeps the
  // node-not-found contract. E13 (tree numeric validation) is unchanged.

  it('E12: aspect-test of a nonexistent node returns node-not-found (exit 1)', () => {
    const dir = copyFixture('e12');
    try {
      const { status, all } = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'does/not/exist'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Node 'does/not/exist' not found.");
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('E13: tree --depth with a non-numeric value is rejected (exit 1)', () => {
    const dir = copyFixture('e13');
    try {
      const { status, all } = run(['tree', '--depth', 'notanumber'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--depth');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- Reviewer-unreachable fail-closed: an enforced LLM aspect that cannot be
  // verified must leave its pair unverified, NOT silently record an approved
  // verdict over code the reviewer never saw. ---

  it('the LLM reviewer being unreachable during a fill fails closed (exit 1) and records no LLM verdict', () => {
    const dir = copyFixture('unreachable');
    try {
      killReviewer(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('unreachable');
      // Fail-closed: the LLM pair is left unverified, no verdict written for it,
      // so a later check cannot go green over the unverified LLM aspect.
      const lock = readLock(dir);
      expect(lock.verdicts['has-doc-comment']).toBeUndefined();
      // The deterministic pairs DID fill (they need no reviewer).
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- F. `--only-deterministic`: the keyless CI / pre-commit gate ---
  //
  // The flag fills ONLY deterministic pairs into the gitignored cache and writes
  // ONLY that file — the committed lock files are never touched (positive closure
  // skipped, GC scoped to the cache), and the reviewer is never contacted. These
  // two tests prove those headline properties end-to-end through the real CLI.

  it('F1: --only-deterministic re-fills only the gitignored cache and leaves the committed lock files byte-identical (zero CI churn), keyless', () => {
    const dir = deterministicFixture('f1-only-det');
    const ygg = path.join(dir, '.yggdrasil');
    try {
      // A full approve writes only the gitignored det cache here: this fixture is
      // deterministic-only (no LLM verdicts) and non-log_required (no source), so
      // BOTH committed files are empty → absent.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const nondetPath = nondetLockPath(ygg);
      const logsPath = logsLockPath(ygg);
      expect(existsSync(nondetPath)).toBe(false);
      expect(existsSync(logsPath)).toBe(false);

      // Edit source → the deterministic pair goes unverified.
      appendFileSync(ordersFile(dir), '\nexport const onlyDetTouch = 1;\n');
      expect(run(['check'], dir).status).toBe(1);

      // Re-fill with --only-deterministic: keyless, free, writes ONLY the gitignored cache.
      const det = run(['check', '--approve', '--only-deterministic'], dir);
      // Progress (the `fill  …` lines) goes to STDERR; final report to STDOUT.
      expect(det.status).toBe(0);

      // The committed files are untouched — zero churn in CI / pre-commit (both
      // absent before, both absent after).
      expect(existsSync(nondetPath)).toBe(false);
      expect(existsSync(logsPath)).toBe(false);
      // The gitignored cache reflects the re-fill.
      expect(verdictFor(readLock(dir), 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('F2: with an LLM aspect present and the reviewer unreachable, --only-deterministic fills the cache, never contacts the reviewer, and writes no committed lock', () => {
    const dir = copyFixture('f2-only-det-llm'); // full fixture — keeps the has-doc-comment LLM aspect
    const ygg = path.join(dir, '.yggdrasil');
    try {
      killReviewer(dir);
      const det = run(['check', '--approve', '--only-deterministic'], dir);

      // Deterministic pairs filled into the gitignored cache.
      expect(existsSync(detLockFile(dir))).toBe(true);
      // Fill progress (the opening and closing `fill` lines) goes to STDERR; the
      // verdict is confirmed via the lock.
      expect(det.stderr).toMatch(/^fill {2}4 pairs · 4 script \(free\) · 0 reviewer calls$/m);
      expect(det.stderr).toMatch(/^fill {2}done in .* — 4 passed · 0 refused · 0 failed · 0 reviewer calls/m);
      expect(verdictFor(readLock(dir), 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');

      // The reviewer was NEVER contacted — a full --approve would say 'unreachable'; this does not.
      expect(det.all).not.toMatch(/unreachable/i);
      // No committed lock files were written — only the gitignored cache.
      expect(existsSync(nondetLockPath(ygg))).toBe(false);
      expect(existsSync(logsLockPath(ygg))).toBe(false);

      // The LLM pair stays unverified → the gate is red (CI must commit LLM verdicts via a full approve).
      expect(det.status).toBe(1);
      expect(det.stdout).toContain('unverified');
      expect(readLock(dir).verdicts['has-doc-comment']).toBeUndefined();
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('F3: --only-deterministic reports SKIPPED LLM pairs honestly — it never claims all pairs hold valid verdicts', () => {
    const dir = copyFixture('f3-honest-skip'); // full fixture — keeps the has-doc-comment LLM aspect
    try {
      const det = run(['check', '--approve', '--only-deterministic'], dir);

      // Deterministic pairs fill; the LLM pair (has-doc-comment) is skipped → red.
      expect(det.status).toBe(1);

      // BUG: the summary used to print "all expected pairs hold valid verdicts"
      // even though LLM pairs were left unverified. It must NOT claim that here.
      expect(det.all).not.toContain('all expected pairs hold valid verdicts');
      // Instead it must state the skip honestly and point at the full approve:
      // the closing fill line counts the reviewer pairs it left, and the
      // report names the paid run for them (here the one block's fix is that
      // step) — the fill prints no next: of its own (a run shows one step, the report's).
      expect(det.stderr).toMatch(/^fill {2}done in .* · 2 reviewer pairs left alone$/m);
      expect(det.stderr).not.toMatch(/^next: /m);
      expect(det.stdout).toMatch(/^ {2}fix: {2}yg check --approve {2}\(2 reviewer pairs · 2 calls · paid — ask the user to approve it first\)$/m);
      // And the report keeps them red as unverified reviewer pairs.
      expect(det.stdout).toContain('error[unverified] 2 pairs with no verdict yet');
      expect(det.stdout).toMatch(/^ {2}at: +has-doc-comment {2}2 pairs · 2 nodes · reviewer$/m);

      // BUG: the pre-dispatch header must flag that LLM pairs will NOT be reviewed
      // this run — not imply it is filling them.
      expect(det.stderr).toMatch(
        /^fill {2}2 reviewer pairs left alone — script rules only this run$/m,
      );
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });
});
