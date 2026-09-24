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
import {
  readLock as readTriadLock,
  nondetLockPath,
  logsLockPath,
  detLockPath,
} from './support/read-lock.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

// ---------------------------------------------------------------------------
// LOCK FILE FORMAT — the 5.1.0 verdict-lock TRIAD.
//
// This suite proves the on-disk shape and the read-boundary gate of the verdict
// state the runtime keeps. As of 5.1.0 the single `.yggdrasil/yg-lock.json` is
// GONE — verification state is split across three sibling files:
//   * yg-lock.nondeterministic.json (committed)  → LLM verdicts
//   * yg-lock.logs.json             (committed)  → the `nodes` section
//                                                  (per-node source fingerprint
//                                                  + log baseline)
//   * .yg-lock.deterministic.json   (gitignored) → deterministic-aspect verdicts
// The in-memory LockFile stays unified — `readLock` merges the three files back
// into { version, verdicts, nodes }; on disk each file owns its own section and
// leaves the others as an empty object. (The pre-v… typed per-node
// `.drift-state/<node>.json` format this file used to assert is REMOVED surface
// — there is no per-node baseline file anymore — so those assertions are
// replaced WHOLESALE with lock-triad assertions.)
//
// What is pinned here:
//   * Absent lock = cold start — every pair reports `unverified`, nothing is
//     silently treated as valid.
//   * After a fill each triad file is valid JSON: version 1, keys sorted at every
//     level, one verdict entry per line, a trailing newline, unitKeys prefixed
//     `node:`/`file:`, verdict entries carry `hash`+`verdict` (+`touched` on
//     deterministic entries, +`reason` on refused ones), and `nodes.<path>.source`
//     (in the logs file) appears only at positive closure (all enforced pairs
//     approved).
//   * A garbled / conflict-markered / unknown-version COMMITTED lock file is
//     refused at the read boundary with `lock-invalid` (exit 1) and a
//     copy-pasteable recovery `next:` (git checkout restore, or delete-and-refill).
//     These scenarios target the committed yg-lock.nondeterministic.json — the
//     file readLock parses and reports by name.
//   * Deleting the lock triad returns the repo to a clean cold start that re-fills.
//
// Hermetic: every test copies the e2e-lifecycle fixture into a FRESH mkdtemp dir,
// strips the LLM `has-doc-comment` aspect so every effective aspect is
// deterministic (no network, no LLM), mutates only that copy, and rmSync's it in
// a finally. Every refuse/pass is driven solely by the deterministic check.mjs
// aspects (`no-todo-comments` enforced, `requires-named-export` advisory) — so
// every verdict assertion here lands in the gitignored .yg-lock.deterministic.json.
// ---------------------------------------------------------------------------

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

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. Fully hermetic — no network, no
 * LLM verdict; the `no-todo-comments` (enforced) and `requires-named-export`
 * (advisory) deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lock-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
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

const ygRoot = (dir: string) => path.join(dir, '.yggdrasil');

// ── Triad file paths ───────────────────────────────────────────────────────
// Deterministic verdicts (every aspect under test is deterministic) land in the
// gitignored det file; the per-node `source` closure state lands in the committed
// logs file; the committed nondeterministic file is the LLM-verdict file readLock
// parses and reports by name on a read-boundary error.
const nondetFile = (dir: string) => nondetLockPath(ygRoot(dir));
const logsFile = (dir: string) => logsLockPath(ygRoot(dir));
const detFile = (dir: string) => detLockPath(ygRoot(dir));

type Lock = ReturnType<typeof readTriadLock>;

/** Read the unified lock by merging the on-disk triad (committed + gitignored det file). */
function readLock(dir: string): Lock {
  return readTriadLock(ygRoot(dir));
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

/** A lock-invalid error is a recoverable STATE problem, never a CLI bug. */
function expectCleanLockError(all: string): void {
  expect(all).not.toContain('Unexpected error');
  expect(all).not.toContain('This is a bug');
  expect(all).not.toContain('file an issue');
}

describe.skipIf(!distExists)('CLI E2E — verdict-lock triad format and read-boundary gate', () => {
  // --- 1. Absent lock = cold start: every pair is unverified. ---

  it('1: with no lock present, check is a cold start — every pair reports unverified (exit 1)', () => {
    const dir = deterministicFixture('cold');
    try {
      // The fixture ships NO lock — confirm the cold-start precondition: none of
      // the triad files exist on disk.
      expect(existsSync(nondetFile(dir))).toBe(false);
      expect(existsSync(logsFile(dir))).toBe(false);
      expect(existsSync(detFile(dir))).toBe(false);

      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      // The unverified block names the cause in its subject and the rule in its
      // at: line; both deterministic-effective nodes report unverified for the
      // enforced aspect (no entry exists for any pair yet) — counted in the
      // default view, named per pair under --details.
      expect(cold.all).toMatch(/error\[unverified\] \d+ pairs? (?:with no verdict yet|whose inputs changed since the verdict|whose script check has not run on this checkout — free to run)/);
      expect(cold.all).toMatch(/at:\s+no-todo-comments {2}2 pairs · 2 nodes · script/);
      // The capped default view counts the nodes; the uncapped --details view names each pair.
      const coldDetails = run(['check', '--details'], dir);
      expect(coldDetails.all).toContain('no-todo-comments @ services/orders');
      expect(coldDetails.all).toContain('no-todo-comments @ services/payments');
      // The block's fix points at the (free) fill command.
      expect(cold.all).toMatch(/fix:\s+yg check --approve --only-deterministic/);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 2. After a fill: each triad file is well-formed JSON with the documented shape. ---

  it('2: after a fill each triad file is valid JSON — version 1, keys sorted at every level, trailing newline', () => {
    const dir = deterministicFixture('shape');
    try {
      // Give a node a log.md so the committed logs file exists (a non-log_required
      // node records no source; the logs file then holds only the log baseline).
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'shape fixture'], dir).status).toBe(0);
      expect(run(['check', '--approve'], dir).status).toBe(0);
      // The deterministic verdicts land in the gitignored det file; the log baseline
      // lands in the committed logs file. Both must exist. This fixture has no LLM
      // verdicts, so the nondet file's section is empty → it is not written at all.
      expect(existsSync(detFile(dir))).toBe(true);
      expect(existsSync(logsFile(dir))).toBe(true);
      expect(existsSync(nondetFile(dir))).toBe(false);

      // Trailing newline + version 1 on every WRITTEN triad file (an empty section
      // is not written, so only the present files are asserted).
      const present = [nondetFile(dir), logsFile(dir), detFile(dir)].filter((f) => existsSync(f));
      for (const f of present) {
        expect(readFileSync(f, 'utf-8').endsWith('\n')).toBe(true);
      }
      for (const f of present) {
        const raw = JSON.parse(readFileSync(f, 'utf-8')) as { version: number };
        expect(raw.version).toBe(1);
      }

      // Structural shape is asserted on the MERGED lock — verdicts come from the
      // det file, nodes from the logs file. Keys sorted at every level.
      const merged = readLock(dir);
      const sorted = (keys: string[]): boolean =>
        JSON.stringify(keys) === JSON.stringify([...keys].sort());
      expect(sorted(Object.keys(merged.verdicts))).toBe(true);
      expect(sorted(Object.keys(merged.nodes))).toBe(true);
      for (const aspectId of Object.keys(merged.verdicts)) {
        const byUnit = merged.verdicts[aspectId];
        expect(sorted(Object.keys(byUnit))).toBe(true);
        for (const unitKey of Object.keys(byUnit)) {
          // Entry field keys are themselves sorted (hash, [reason,] touched, verdict).
          expect(sorted(Object.keys(byUnit[unitKey] as unknown as Record<string, unknown>))).toBe(true);
        }
      }
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 3. unitKeys are prefixed; deterministic verdict entries carry hash + verdict + touched. ---

  it('3: deterministic verdict entries carry hash + verdict + touched; unitKeys are node:/file: prefixed', () => {
    const dir = deterministicFixture('entries');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      // Deterministic verdicts live in the gitignored det file; readLock merges it.
      const parsed = readLock(dir);

      const todo = parsed.verdicts['no-todo-comments'];
      const unitKeys = Object.keys(todo);
      expect(unitKeys).toContain('node:services/orders');
      expect(unitKeys).toContain('node:services/payments');
      // Every unitKey is prefixed `node:` or `file:`.
      for (const k of unitKeys) {
        expect(k.startsWith('node:') || k.startsWith('file:')).toBe(true);
      }

      const entry = todo['node:services/orders'] as unknown as Record<string, unknown>;
      // A clean deterministic verdict: hash + verdict + touched (no reason).
      expect(typeof entry.hash).toBe('string');
      expect(entry.verdict).toBe('approved');
      expect(Array.isArray(entry.touched)).toBe(true);
      // `touched` is empty when the check observed nothing outside its subject.
      expect(entry.touched).toEqual([]);
      expect('reason' in entry).toBe(false);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 4. nodes.<path>.source is written at positive closure; refused entries carry reason. ---
  //
  // A refused enforced pair leaves the node short of positive closure, so NO
  // `nodes.<path>.source` is recorded for it — while a refused verdict entry
  // carries a human-readable `reason`. The sibling node, which DID reach closure,
  // gets its `source`. (The `source` closure state lives in the committed logs
  // file; the verdict entries live in the gitignored det file — readLock merges
  // both.)

  it('4: nodes.<path>.source appears only at positive closure; a refused entry carries hash + reason + verdict', () => {
    const dir = deterministicFixture('closure');
    try {
      // Source fingerprints are recorded at closure ONLY for log_required nodes —
      // flip the service type on and give both nodes a justification entry so the
      // gate passes; payments will then carry a source after closing, orders won't.
      const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      writeFileSync(archPath, readFileSync(archPath, 'utf-8').replace(/log_required: false/g, 'log_required: true'), 'utf-8');
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'closure fixture'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'closure fixture'], dir).status).toBe(0);
      // orders violates the enforced no-todo aspect; payments stays clean.
      appendFileSync(ordersFile(dir), '\n// TODO: this refuses on purpose\n');

      const fill = run(['check', '--approve'], dir);
      // The fill itself completes (det runs, nothing to retry), but the resulting
      // enforced refusal makes the post-fill check FAIL.
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('error[refused] no-todo-comments — 1 violation in services/orders');

      const parsed = readLock(dir);

      // The refused entry: hash + reason + touched + verdict, sorted.
      const refused = parsed.verdicts['no-todo-comments']['node:services/orders'] as unknown as Record<string, unknown>;
      expect(refused.verdict).toBe('refused');
      expect(typeof refused.hash).toBe('string');
      expect(typeof refused.reason).toBe('string');
      expect(String(refused.reason)).toContain('TODO comment found');

      // Closure: payments reached all-enforced-approved → has source; orders did
      // NOT reach closure (refused enforced pair) → no source entry.
      expect(typeof parsed.nodes['services/payments']?.source).toBe('string');
      expect(parsed.nodes['services/orders']).toBeUndefined();
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 5. file: unitKeys for a per:file aspect; the entry is one per subject file. ---

  it('5: a per:file aspect records file: unitKeys, one verdict entry per subject file', () => {
    const dir = deterministicFixture('perfile');
    try {
      // Author a per:file deterministic aspect attached to orders.
      const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-scoped');
      cpSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        [
          'name: NoTodoScoped',
          'description: Source files (excluding tests) must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'scope:',
          '  per: file',
          '  files:',
          '    all_of:',
          '      - path: "src/**/*.ts"',
          '      - not: { path: "**/*.test.ts" }',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - no-todo-scoped',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      expect(run(['check', '--approve'], dir).status).toBe(0);
      // Deterministic verdicts (incl. the new per:file aspect) merge from the det file.
      const parsed = readLock(dir);

      const scoped = parsed.verdicts['no-todo-scoped'];
      const keys = Object.keys(scoped);
      // The per:file unitKey is the repo-relative POSIX path, `file:`-prefixed.
      expect(keys).toEqual(['file:src/services/orders.ts']);
      expect(scoped['file:src/services/orders.ts'].verdict).toBe('approved');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 6. Garbled JSON → lock-invalid at the read boundary, with recovery next. ---
  //
  // The corrupt-file scenarios target the committed yg-lock.nondeterministic.json:
  // it is a committed file readLock parses, so a structural defect there is the
  // read-boundary failure the recovery `next:` is written for.

  it('6: an unparseable lock is refused with lock-invalid + a copy-pasteable recovery next (exit 1)', () => {
    const dir = deterministicFixture('garbled');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      writeFileSync(nondetFile(dir), 'this is not json {{{', 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      // lock-invalid is not a FULL_WHAT code, so the per-issue `what`
      // ('contains unparseable JSON') is gone from the grouped view; the detail
      // now lives in the shared why. Assert the label + the now-visible why.
      expect(check.all).toContain('a garbled lock file cannot be read');
      // Recovery: restore from git OR delete-and-refill.
      expect(check.all).toContain('git checkout HEAD -- .yggdrasil/yg-lock.nondeterministic.json');
      expect(check.all).toContain('yg check --approve');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 7. Unresolved git conflict markers → lock-invalid with the merge-recovery next. ---

  it('7: a conflict-markered lock is refused with lock-invalid + the take-one-side recovery (exit 1)', () => {
    const dir = deterministicFixture('conflict');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      writeFileSync(
        nondetFile(dir),
        [
          '<<<<<<< HEAD',
          '{ "version": 1, "verdicts": {}, "nodes": {} }',
          '=======',
          '{ "version": 1, "verdicts": {}, "nodes": {} }',
          '>>>>>>> other',
          '',
        ].join('\n'),
        'utf-8',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      // lock-invalid is not a FULL_WHAT code, so the per-issue `what`
      // ('contains git conflict markers') is gone from the grouped view; the
      // detail now lives in the shared why. Assert the label + the now-visible why.
      expect(check.all).toContain('a conflict-markered lock file cannot be parsed');
      // The merge-recovery takes one side wholesale, then re-fills.
      expect(check.all).toContain('git checkout --ours -- .yggdrasil/yg-lock.nondeterministic.json');
      expect(check.all).toContain('git checkout --theirs -- .yggdrasil/yg-lock.nondeterministic.json');
      expect(check.all).toContain('yg check --approve');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 8. Unknown version → lock-invalid with the migration-style recovery. ---

  it('8: a lock with an unsupported version (99) is refused with lock-invalid (exit 1)', () => {
    const dir = deterministicFixture('version');
    try {
      // An empty section is not written, so --approve leaves no nondet file for this
      // deterministic-only fixture; seed a version-99 nondet directly to exercise the
      // unknown-version gate (readLock must refuse it).
      writeFileSync(nondetFile(dir), `${JSON.stringify({ version: 99, verdicts: {}, nodes: {} }, null, 2)}\n`, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      // lock-invalid is not a FULL_WHAT code, so the per-issue `what`
      // ('has unsupported version 99 ...') is gone from the grouped view; the
      // detail now lives in the shared why. Assert the label + the now-visible
      // why (CLI writes v1 and reads v1 native / v2 leniently).
      expect(check.all).toContain('an unrecognized lock version means the file was written by a different or newer CLI');
      expect(check.all).toContain('git checkout HEAD -- .yggdrasil/yg-lock.nondeterministic.json');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 9. Deleting the lock returns to a clean cold start that re-fills. ---

  it('9: deleting the lock returns to cold start — check goes unverified, a re-fill restores green', () => {
    const dir = deterministicFixture('delete');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Delete the lock triad entirely — the repo is back to cold start.
      rmSync(nondetFile(dir), { force: true });
      rmSync(logsFile(dir), { force: true });
      rmSync(detFile(dir), { force: true });
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.all).toContain('unverified');

      // Re-fill writes a fresh lock and the repo is green again.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(existsSync(detFile(dir))).toBe(true);
      // No log_required node and no log.md → the logs file stays absent (empty → no file).
      expect(existsSync(logsFile(dir))).toBe(false);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  // --- 10. Hand-edited verdict hash degrades to unverified — never silently green. ---
  //
  // Tampering with a stored verdict's input hash (the v… per-node
  // baseline-integrity-tamper code is REMOVED surface) does NOT produce a distinct
  // error: the pair simply no longer hashes to the stored value, so it degrades to
  // `unverified`. The load-bearing guarantee is that a tampered verdict NEVER
  // passes as valid — it is re-verified, not trusted. The deterministic verdict
  // whose hash is tampered lives in the gitignored .yg-lock.deterministic.json.

  it('10: hand-editing a stored verdict hash degrades that pair to unverified — never silently green', () => {
    const dir = deterministicFixture('tamper');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Overwrite the recorded input hash for one enforced deterministic pair with
      // a bogus value, in the gitignored det file that holds it.
      const parsed = JSON.parse(readFileSync(detFile(dir), 'utf-8')) as {
        verdicts: Record<string, Record<string, { hash: string }>>;
      };
      parsed.verdicts['no-todo-comments']['node:services/orders'].hash =
        '0000000000000000000000000000000000000000000000000000000000000000';
      writeFileSync(detFile(dir), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // The tampered pair is re-flagged unverified, not accepted: the block's
      // subject names the cause and its at: line names the pair.
      expect(check.all).toMatch(/error\[unverified\] \d+ pairs? (?:with no verdict yet|whose inputs changed since the verdict|whose script check has not run on this checkout — free to run)/);
      expect(check.all).toContain('no-todo-comments @ services/orders');
      // The block's fix points at the fill command.
      expect(check.all).toMatch(/fix:\s+yg check --approve/);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });
});
