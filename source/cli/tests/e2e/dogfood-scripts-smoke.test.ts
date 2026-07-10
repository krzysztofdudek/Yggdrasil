import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Tests for the DOGFOOD-ONLY repo scripts (never adopter surfaces):
//   - scripts/lock-history-audit.mjs  (the lock laundering-signature CI gate)
//   - scripts/decision-load.mjs       (the decision-load λ proxy meter)
//
// Both are plain Node ESM with no deps that run READ-ONLY over a git history via
// `git log`/`git show`, self-locating the repo root with `git rev-parse
// --show-toplevel`. No mocking, no fabricated data:
//   * the spawn-smoke block runs each script against THIS repository's real
//     history and asserts exit 0 + a recognizable header;
//   * the audit-signature block builds a REAL on-disk git repo in a temp dir with
//     hand-crafted lock commits and proves the audit's FAIL (exit 1) and WARN
//     (exit 0) paths — without these, a future `===`→`!==` slip in the detector
//     would keep CI green.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'scripts/lock-history-audit.mjs');
const isGitRepo = existsSync(path.join(REPO_ROOT, '.git'));

function runScript(rel: string) {
  return spawnSync('node', [path.join(REPO_ROOT, rel)], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

describe.skipIf(!isGitRepo)('dogfood scripts — spawn smoke', () => {
  it('lock-history-audit.mjs exits 0 with its header and summary on real history', () => {
    const res = runScript('scripts/lock-history-audit.mjs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('lock-history-audit');
    // The summary line is always emitted; on a clean history it reads "0 laundering
    // signatures ...". A non-zero count would have failed the exit-0 assertion above.
    expect(res.stdout).toContain('laundering signatures');
  });

  it('decision-load.mjs exits 0 with its header and the RZ-16 honesty label', () => {
    const res = runScript('scripts/decision-load.mjs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('decision-load');
    expect(res.stdout).toContain('[RZ-16]');
  });
});

// ---------------------------------------------------------------------------
// Fixture-backed proof of the audit's two detection paths. Each test builds a
// throwaway git repo on disk (no mocking), writes successive revisions of
// .yggdrasil/yg-lock.nondeterministic.json, and spawns the real script with cwd
// set to that repo so its `git` commands resolve there. Deterministic identity
// and dates are supplied via GIT_* env so nothing depends on ambient git config
// or the wall clock. The temp dir is removed in a finally.
// ---------------------------------------------------------------------------

const LOCK_REL = '.yggdrasil/yg-lock.nondeterministic.json';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'audit-fixture',
  GIT_AUTHOR_EMAIL: 'audit@fixture.test',
  GIT_COMMITTER_NAME: 'audit-fixture',
  GIT_COMMITTER_EMAIL: 'audit@fixture.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function lock(verdicts: unknown): string {
  return JSON.stringify({ version: 1, verdicts, nodes: {} });
}

/** Build a temp git repo; `commit(verdicts)` writes the lock and commits it. */
function makeAuditRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-lock-audit-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV });
  git(['init', '-q']);
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  let n = 0;
  const commit = (verdicts: unknown) => {
    writeFileSync(path.join(dir, LOCK_REL), lock(verdicts));
    git(['add', '-A']);
    git(['commit', '-q', '-m', `rev ${++n}`]);
  };
  return { dir, commit };
}

function runAudit(cwd: string) {
  return spawnSync('node', [AUDIT_SCRIPT], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

describe('lock-history-audit — detection paths (fixture git repo)', () => {
  it('FAILS (exit 1) on a verdict flip with an UNCHANGED input hash', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // Same (aspectId, unitKey), identical hash, verdict laundered approved->refused.
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'approved' } } });
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'refused' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(1);
      // Verbatim signature line (sha matched loosely as a hex suffix).
      expect(res.stdout).toMatch(
        /^LAUNDERING SIGNATURE: asp-x \/ file:src\/a\.ts verdict approved->refused with unchanged input hash at [0-9a-f]{7,40}$/m,
      );
      expect(res.stdout).toContain('1 laundering signatures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT fire when the hash also changed (legitimate re-verification)', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // Verdict flips BUT the input hash changed too — this is a normal re-verify,
      // not a laundering signature, so the audit must stay green.
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'approved' } } });
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'ZZZZ', verdict: 'refused' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('0 laundering signatures');
      expect(res.stdout).not.toContain('LAUNDERING SIGNATURE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WARNs (exit 0) when a refused entry DISAPPEARS between commits', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // A refused entry present in rev 1 is gone in rev 2 (replaced by an unrelated
      // approved entry) — the first half of a delete-and-rerun, surfaced as a warning
      // that never fails the build.
      commit({ 'asp-y': { 'file:src/b.ts': { hash: 'KKKK', verdict: 'refused' } } });
      commit({ 'asp-z': { 'file:src/c.ts': { hash: 'LLLL', verdict: 'approved' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('WARN:');
      expect(res.stdout).toContain('asp-y / file:src/b.ts');
      expect(res.stdout).toContain('0 laundering signatures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
