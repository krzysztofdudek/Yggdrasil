import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  symlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitFixtureEnv } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// HERMETICITY
//
// Every scenario here is LLM-independent and network-free. The fill cases run on
// `deterministicFixture` (the LLM aspect `has-doc-comment` is stripped from the
// service type, so `yg check --approve` records only deterministic verdicts and
// never contacts a reviewer endpoint). The log add/read and merge-resolve cases
// never invoke the reviewer at all. No real host/port is dialed; no wall clock
// or random source is read in assertions (log-entry timestamps are produced by
// the binary and read back, never compared to the current time). Each test
// works inside a fresh mkdtemp dir and removes it in a finally block; the
// committed fixture bytes are never mutated.
//
// MODEL — `yg approve` / `.drift-state/` are GONE; state lives in
// `.yggdrasil/yg-lock.logs.json`. Append-only integrity surfaces as `log-integrity`
// and format as `log-format`, BOTH at plain `yg check` time (pure reads). The
// `yg check` rendering shows only the violation-CODE summary line
// (`Log integrity broken (<reason>)` / `Log format invalid at <path>:`) plus a
// generic Why/Fix; the per-line FORMAT reason detail (`out_of_order`,
// `invalid_datetime`, …) is surfaced by `yg log read`, which runs the same
// validateFormat before rendering. So each format case asserts the code via
// `yg check` AND the detailed reason via `yg log read`. The restore-from-git
// guidance now names `.yggdrasil/yg-lock.logs.json` (the log baseline lives there,
// in `nodes.<path>.log`), not the removed `.drift-state/` path.
//
// SCOPE — this suite covers the REMAINING log-domain error paths NOT asserted
// by cli-log-integrity.test.ts.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-logintx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible.
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

const ordersLogPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');

/**
 * Seed services/orders with a log baseline of TWO entries, filled. After this
 * the lock carries a `log` baseline (last_entry_datetime + prefix_hash) under
 * `nodes.services/orders.log`, whose boundary is the SECOND entry — so the FIRST
 * entry lives strictly inside the hashed prefix and later post-baseline appends
 * are validated by the format check. The single-entry case records no `log`
 * baseline (no prior prefix to protect), so two entries are required to engage
 * append-only integrity. Fill is hermetic (deterministic-only, no reviewer).
 */
function seedTwoEntryLogBaseline(dir: string, first: string, second: string): void {
  expect(run(['log', 'add', '--node', 'services/orders', '--reason', first], dir).status).toBe(0);
  expect(run(['check', '--approve'], dir).status).toBe(0);
  expect(run(['log', 'add', '--node', 'services/orders', '--reason', second], dir).status).toBe(0);
  expect(run(['check', '--approve'], dir).status).toBe(0);
}

/** Seed a single-entry log + fill — enough for post-baseline FORMAT appends. */
function seedOneEntryLogBaseline(dir: string, reason: string): void {
  expect(run(['log', 'add', '--node', 'services/orders', '--reason', reason], dir).status).toBe(0);
  expect(run(['check', '--approve'], dir).status).toBe(0);
}

// ---------------------------------------------------------------------------
// merge-resolve git-repo builder. Drives the REAL binary against a copy of the
// e2e-lifecycle graph. git stdio is piped so conflict notices never leak; the
// conflicting `git merge` returns non-zero, which is tolerated (the conflict is
// then hand-resolved with `resolvedLog`).
// ---------------------------------------------------------------------------

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const P1_NEW = '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const P2_NEW = '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

/** Run a git command in the repo with stdio piped (silent). */
function git(repo: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
}

function buildMergeRepo(label: string, resolvedLog: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), `yg-logmrx-${label}-`));
  cpSync(FIXTURE, repo, { recursive: true });
  const logPath = ordersLogPath(repo);
  mkdirSync(path.dirname(logPath), { recursive: true });

  git(repo, 'init -q -b main');
  git(repo, 'config user.email t@t.test');
  git(repo, 'config user.name Test');

  writeFileSync(logPath, ANCESTOR_LOG, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm ancestor');

  git(repo, 'checkout -qb feat1');
  writeFileSync(logPath, ANCESTOR_LOG + P1_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat1');

  git(repo, 'checkout -q main');
  git(repo, 'checkout -qb feat2 main');
  writeFileSync(logPath, ANCESTOR_LOG + P2_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat2');

  try {
    git(repo, 'merge --no-commit --no-ff feat1 -q');
  } catch {
    /* expected conflict — resolved by hand below */
  }
  writeFileSync(logPath, resolvedLog, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm "merge feat1 into feat2"');

  return repo;
}

describe.skipIf(!distExists)('CLI E2E — log integrity (append-only), format validation, add/read error paths', () => {
  // =========================================================================
  // APPEND-ONLY INTEGRITY — modifying pre-baseline log content
  //
  // A node is filled with a TWO-entry log baseline (the boundary is the SECOND
  // entry; the FIRST is pre-baseline, inside the hashed prefix). Editing the
  // FIRST entry's body changes the hashed prefix → validateAppendOnly returns
  // `prefix_modified`. `yg check` surfaces it as code `log-integrity` with
  // restore-from-git guidance that names log.md AND yg-lock.logs.json (the log
  // baseline lives in that triad member now).
  // =========================================================================

  it('1a: check refuses (exit 1) when pre-baseline log content is modified — prefix_modified', () => {
    const dir = deterministicFixture('appendonly-check-a');
    try {
      seedTwoEntryLogBaseline(dir, 'first entry body', 'second entry body');

      // Tamper an EARLIER (pre-baseline) line in place.
      const log = readFileSync(ordersLogPath(dir), 'utf-8');
      expect(log).toContain('first entry body');
      writeFileSync(ordersLogPath(dir), log.replace('first entry body', 'TAMPERED HISTORY'), 'utf-8');

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // The per-issue `what` summary ('Log integrity broken (prefix_modified)')
      // is gone in the grouped default view (log-integrity is not a FULL_WHAT
      // code). Assert the group label/code plus the now-visible shared why.
      expect(all).toContain('log-integrity');
      expect(all).toContain('Historical (pre-baseline) log content was modified — append-only violated.');
      // Restore-from-git guidance names both the log.md and the committed log
      // baseline (the triad member yg-lock.logs.json), not the retired single-file
      // yg-lock.json name.
      expect(all).toContain('git checkout HEAD -- .yggdrasil/model/services/orders/log.md');
      expect(all).toContain('.yggdrasil/yg-lock.logs.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1b: check renders the integrity code (log-integrity) plus the offending node path (exit 1)', () => {
    const dir = deterministicFixture('appendonly-check-b');
    try {
      seedTwoEntryLogBaseline(dir, 'baseline entry one', 'baseline entry two');

      const log = readFileSync(ordersLogPath(dir), 'utf-8');
      writeFileSync(ordersLogPath(dir), log.replace('baseline entry one', 'EDITED'), 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // check renders the validation code plus the offending node path. The
      // per-issue `what` summary ('Log integrity broken (prefix_modified)') is
      // gone in the grouped view (log-integrity is not a FULL_WHAT code); the
      // group label, node line, shared why, and Fix remain.
      expect(stdout).toContain('log-integrity');
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('append-only violated');
      expect(stdout).toContain('git checkout HEAD --');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1c: deleting log.md after a log baseline exists is detected as boundary_missing (exit 1)', () => {
    const dir = deterministicFixture('appendonly-deleted');
    try {
      // Two entries so a `log` baseline (boundary entry) is recorded in the lock.
      seedTwoEntryLogBaseline(dir, 'first only entry', 'second only entry');
      // Remove the file entirely — the baseline boundary entry can no longer be
      // found, which validateAppendOnly reports as boundary_missing.
      rmSync(ordersLogPath(dir), { force: true });

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // The per-issue `what` ('Log integrity broken (boundary_missing)' and the
      // '(file missing)' detail) is gone in the grouped default view
      // (log-integrity is not a FULL_WHAT code). Assert the group label/code plus
      // the now-visible shared why, which still names the deletion/reset cause.
      expect(all).toContain('log-integrity');
      expect(all).toContain('Baseline boundary entry not found — log was deleted or reset.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG FORMAT VALIDATION (beyond the level-2-heading case the base suite owns)
  //
  // Each violation is APPENDED after the integrity boundary (post-baseline) so
  // the append-only check passes and the FORMAT validator is the gate that
  // fires. `yg check` surfaces the violation as code `log-format` (summary line
  // only); the per-line reason detail (out_of_order, invalid_datetime, …) is
  // surfaced by `yg log read`, which runs the same validateFormat. Both are
  // asserted: the code via check, the reason via read.
  // =========================================================================

  it('2a: an out-of-order (older) appended entry is rejected as out_of_order (exit 1, post-baseline)', () => {
    const dir = deterministicFixture('fmt-out-of-order');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      // Append an entry whose datetime is OLDER than the existing one.
      appendFileSync(ordersLogPath(dir), '## [2020-01-01T00:00:00.000Z]\nolder than base\n');

      // check surfaces the format violation by code.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      // The per-issue `what` ('Log format invalid at <path>') is gone in the
      // grouped default view (log-format is not a FULL_WHAT code). Assert the
      // group's now-visible shared why plus the offending node line instead.
      expect(check.all).toContain('Log format must be parseable for indexing and integrity.');
      expect(check.all).toContain('- services/orders');
      // read surfaces the per-line reason detail.
      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('out_of_order');
      expect(read.all).toContain('is not strictly greater than previous');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2b: an entry whose datetime is parseable but non-strict is rejected as invalid_datetime (exit 1)', () => {
    const dir = deterministicFixture('fmt-invalid-datetime');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      // 2027-06-01T10:00:00Z is parseable by Date.parse but lacks the required
      // milliseconds, so the strict ISO check rejects it as invalid_datetime.
      appendFileSync(ordersLogPath(dir), '## [2027-06-01T10:00:00Z]\nbody\n');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('invalid_datetime');
      expect(read.all).toContain('ISO 8601 UTC with milliseconds and Z suffix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2c: an entry header with entirely unparseable datetime is rejected as invalid_header (exit 1)', () => {
    const dir = deterministicFixture('fmt-invalid-header');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      appendFileSync(ordersLogPath(dir), '## [2026-13-99 not-a-date]\nbody\n');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('invalid_header');
      expect(read.all).toContain('is not parseable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2d: an unclosed code fence is rejected as unclosed_code_fence (exit 1)', () => {
    const dir = deterministicFixture('fmt-unclosed-fence');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      // Open a fence in a new entry's body and never close it before EOF.
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-01-01T00:00:00.000Z]\nbody\n```\nopen fence never closed\n',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('unclosed_code_fence');
      expect(read.all).toContain('opened but never closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2e: a stray level-2 heading inside an entry body is rejected as level2_header_in_body (exit 1)', () => {
    const dir = deterministicFixture('fmt-stray-h2');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      // A level-2 heading written directly into log.md body (cannot be produced
      // via `yg log add`, which rejects it up front — the base suite covers that
      // path; here it is hand-written into the file to drive the FILE validator).
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-02-01T00:00:00.000Z]\nbody line\n## Stray top-level heading\nmore\n',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('level2_header_in_body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2f: check surfaces the format violation as code log-format with the node path (exit 1)', () => {
    const dir = deterministicFixture('fmt-via-check');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      appendFileSync(ordersLogPath(dir), '## [2020-01-01T00:00:00.000Z]\nolder\n');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // check renders the validation code and the offending node path. The
      // per-issue `what` ('Log format invalid at <path>') is gone in the grouped
      // default view (log-format is not a FULL_WHAT code); assert the group's
      // now-visible shared why instead.
      expect(stdout).toContain('log-format');
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('Log format must be parseable for indexing and integrity.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GIT CONFLICT MARKERS — a conflict-markered log.md routes to merge-resolve
  //
  // A log.md left with unresolved git conflict markers cannot be validated for
  // integrity or format; hand-stitching the two sides would break the
  // append-only integrity hashes. `yg check` detects the open/close markers
  // FIRST and surfaces code `log-conflict`, steering to `yg log merge-resolve`
  // (NOT the format-fix or restore-from-git guidance).
  // =========================================================================

  it('2g: conflict markers in log.md → log-conflict, route to merge-resolve (exit 1)', () => {
    const dir = deterministicFixture('conflict-markers');
    try {
      seedOneEntryLogBaseline(dir, 'base entry');
      // Overwrite the log with an unresolved git conflict (open/close + separator).
      writeFileSync(
        ordersLogPath(dir),
        '## [2026-05-11T10:00:00.000Z]\n' +
          '<<<<<<< HEAD\n' +
          'ours reason.\n' +
          '=======\n' +
          'theirs reason.\n' +
          '>>>>>>> branch\n',
        'utf-8',
      );

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('log-conflict');
      expect(all).toContain('yg log merge-resolve --node services/orders');
      // The conflict short-circuits the format validator — the agent is NOT told
      // to hand-edit the file (which would break the integrity hashes).
      expect(all).not.toContain('Fix format violations');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG ADD — error/guard paths
  // =========================================================================

  it('3a: log add refuses a symlinked log.md with the symlink message (exit 1)', () => {
    const dir = copyFixture('add-symlink');
    try {
      const logPath = ordersLogPath(dir);
      mkdirSync(path.dirname(logPath), { recursive: true });
      const target = path.join(dir, 'symlink-target.md');
      writeFileSync(target, '## [2026-01-01T00:00:00.000Z]\nbody\n', 'utf-8');
      symlinkSync(target, logPath);
      // Guard: the test setup really created a symlink.
      expect(statSync(logPath, { throwIfNoEntry: true }).isFile()).toBe(true);

      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('log.md is a symbolic link');
      expect(all).toContain('Symlinks bypass append-only guarantees');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3b: log add refuses a hard-linked log.md with the hardlink message (exit 1)', () => {
    const dir = copyFixture('add-hardlink');
    try {
      const logPath = ordersLogPath(dir);
      mkdirSync(path.dirname(logPath), { recursive: true });
      const other = path.join(dir, 'hardlink-other.md');
      writeFileSync(other, '## [2026-01-01T00:00:00.000Z]\nbody\n', 'utf-8');
      linkSync(other, logPath);
      // Guard: st_nlink is now 2.
      expect(statSync(logPath).nlink).toBeGreaterThan(1);

      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('log.md has multiple hard links');
      expect(all).toContain('st_nlink > 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3c: log add with a whitespace-only --reason is rejected as empty (exit 1)', () => {
    const dir = copyFixture('add-empty');
    try {
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', '   '],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Reason cannot be empty after trim');
      // Nothing was written for the rejected entry.
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3d: log add --reason-file with a missing file is rejected (exit 1)', () => {
    const dir = copyFixture('add-rf-missing');
    try {
      const missing = path.join(dir, 'no-such-reason.txt');
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', missing],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Cannot stat --reason-file');
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3e: log add --reason-file pointing at a directory is rejected as not-a-regular-file (exit 1)', () => {
    const dir = copyFixture('add-rf-dir');
    try {
      const aDir = path.join(dir, 'reason-dir');
      mkdirSync(aDir, { recursive: true });
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', aDir],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('--reason-file is not a regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3f: log add --reason-file with multi-line content writes the full body (exit 0)', () => {
    const dir = copyFixture('add-rf-multiline');
    try {
      const reasonFile = path.join(dir, 'reason.txt');
      // Multi-line body with a level-3 sub-heading (level-3 is allowed).
      writeFileSync(reasonFile, 'first line of rationale\n### context\nsecond line of rationale\n', 'utf-8');
      const { status, stdout } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', reasonFile],
        dir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');

      const written = readFileSync(ordersLogPath(dir), 'utf-8');
      expect(written).toContain('first line of rationale');
      expect(written).toContain('### context');
      expect(written).toContain('second line of rationale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3g: log add with both --reason and --reason-file is rejected (exit 1)', () => {
    const dir = copyFixture('add-both');
    try {
      const reasonFile = path.join(dir, 'reason.txt');
      writeFileSync(reasonFile, 'body\n', 'utf-8');
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x', '--reason-file', reasonFile],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Exactly one of --reason or --reason-file is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG READ — error/guard paths and full-history
  // =========================================================================

  it('4a: read --all returns the full history newest-first (exit 0)', () => {
    const dir = copyFixture('read-all');
    try {
      // Three entries with monotonic timestamps guaranteed by the binary.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'alpha'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'beta'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'gamma'], dir).status).toBe(0);

      const { status, stdout } = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(status).toBe(0);
      // All three present.
      expect(stdout).toContain('alpha');
      expect(stdout).toContain('beta');
      expect(stdout).toContain('gamma');
      // Newest-first ordering: gamma's body precedes beta's, which precedes alpha's.
      expect(stdout.indexOf('gamma')).toBeLessThan(stdout.indexOf('beta'));
      expect(stdout.indexOf('beta')).toBeLessThan(stdout.indexOf('alpha'));
      // Exactly three entry headers rendered.
      const headerCount = stdout.split('\n').filter((l) => l.startsWith('## [')).length;
      expect(headerCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4b: read --top with a non-integer value is rejected (exit 1)', () => {
    const dir = copyFixture('read-top-nan');
    try {
      run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir);
      // parseInt('abc', 10) → NaN; logRead rejects a non-positive/non-integer top.
      const { status, all } = run(
        ['log', 'read', '--node', 'services/orders', '--top', 'abc'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Invalid --top value: NaN');
      expect(all).toContain('positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4c: read --top combined with --all is rejected (exit 1)', () => {
    const dir = copyFixture('read-top-all');
    try {
      run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir);
      const { status, all } = run(
        ['log', 'read', '--node', 'services/orders', '--top', '2', '--all'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Cannot combine --top with --all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4d: read a node that has no log.md returns "No log entries." (exit 0)', () => {
    const dir = copyFixture('read-no-log');
    try {
      // services/payments ships no log.md in the fixture.
      expect(existsSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md'))).toBe(false);
      const { status, stdout } = run(['log', 'read', '--node', 'services/payments'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('No log entries.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // MERGE-RESOLVE — additional tamper paths (NOT in the base suite, which
  // covers non-merge HEAD + tampered ancestor prefix only)
  // =========================================================================

  it('5a: merge-resolve rejects a DROPPED parent entry (exit 1)', () => {
    // Resolved log keeps the ancestor + feat2 but drops feat1's entry.
    const repo = buildMergeRepo('drop', ANCESTOR_LOG + P2_NEW);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('missing or has altered');
      // The dropped entry's datetime is named in the restore guidance.
      expect(all).toContain('2026-05-11T11:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5b: merge-resolve rejects a FABRICATED entry present in neither parent (exit 1)', () => {
    const fabricated = '## [2026-05-11T13:00:00.000Z]\nfabricated, in no branch.\n';
    const repo = buildMergeRepo('fab', ANCESTOR_LOG + P1_NEW + P2_NEW + fabricated);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('not present in either merge parent');
      expect(all).toContain('2026-05-11T13:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5c: merge-resolve rejects an ALTERED parent-entry body (exit 1)', () => {
    // feat1's body is changed; content-hash matching classifies it as a missing
    // (altered) parent entry rather than a clean union.
    const alteredP1 = '## [2026-05-11T11:00:00.000Z]\nfeat1-ALTERED-BODY.\n';
    const repo = buildMergeRepo('alter', ANCESTOR_LOG + alteredP1 + P2_NEW);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('missing or has altered');
      expect(all).toContain('2026-05-11T11:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
