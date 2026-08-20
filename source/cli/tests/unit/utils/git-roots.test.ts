// Unit tests for the roots model header's git helpers (utils/git.ts:
// getHeadSha, getHeadCommitterTimestamp, getDirtyFiles) — a SEPARATE file from
// git.test.ts because that file `vi.mock`s node:child_process module-wide,
// which would silently break the real git subprocess calls these tests need.
// Every fixture here is a REAL temp git repository built through the
// deterministic git-fixture helpers (tests/support/git-fixture.ts): pinned
// author/committer dates, TZ=UTC, and GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, so a
// timestamp assertion is exact rather than merely "looks like an ISO string".

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initDeterministicGitFixture,
  runDeterministicGitFixture,
  runGitFixture,
} from '../../support/git-fixture.js';
import { getHeadSha, getHeadCommitterTimestamp, getDirtyFiles } from '../../../src/utils/git.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-roots-'));
  dirs.push(dir);
  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);
  return dir;
}

function nonRepoDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-not-a-repo-'));
  dirs.push(dir);
  return dir;
}

/** Writes `files` and commits them at `commitIndex`'s pinned deterministic date. */
function commitAt(dir: string, commitIndex: number, files: Record<string, string>, message: string): void {
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(dir, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  const add = runDeterministicGitFixture(dir, ['add', '-A'], commitIndex);
  if (add.status !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr}${add.stdout}`);
  const commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', message], commitIndex);
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}${commit.stdout}`);
}

describe('utils/git — roots model header helpers', () => {
  describe('getHeadSha', () => {
    it('returns the same sha as `git rev-parse HEAD` in a real repo', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      const rev = runGitFixture(dir, ['rev-parse', 'HEAD']);
      expect(rev.status).toBe(0);
      expect(getHeadSha(dir)).toBe(rev.stdout.trim());
      expect(getHeadSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns null in a directory that is not a git repository (fail-soft, never throws)', () => {
      expect(getHeadSha(nonRepoDir())).toBeNull();
    });

    it('returns null in a freshly-initialized repo with zero commits (no HEAD yet)', () => {
      expect(getHeadSha(freshRepo())).toBeNull();
    });
  });

  describe('getHeadCommitterTimestamp', () => {
    it('returns HEAD\'s committer date as strict ISO-8601, matching the fixture\'s pinned date exactly', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      expect(getHeadCommitterTimestamp(dir)).toBe('2024-01-01T00:00:00+00:00');
    });

    it('a later commit index yields a later timestamp, 60s apart per the fixture\'s own spacing', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      commitAt(dir, 1, { 'a.txt': 'y' }, 'second');
      expect(getHeadCommitterTimestamp(dir)).toBe('2024-01-01T00:01:00+00:00');
    });

    it('returns null in a directory that is not a git repository', () => {
      expect(getHeadCommitterTimestamp(nonRepoDir())).toBeNull();
    });

    it('returns null in a freshly-initialized repo with zero commits', () => {
      expect(getHeadCommitterTimestamp(freshRepo())).toBeNull();
    });
  });

  describe('getDirtyFiles', () => {
    it('returns an empty array on a clean worktree', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      expect(getDirtyFiles(dir)).toEqual([]);
    });

    it('reports a modified tracked file', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      writeFileSync(path.join(dir, 'a.txt'), 'changed', 'utf-8');
      expect(getDirtyFiles(dir)).toEqual(['a.txt']);
    });

    it('reports an untracked file inside a new directory itself, not collapsed to the directory (the -uall flag)', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      mkdirSync(path.join(dir, 'sub'), { recursive: true });
      writeFileSync(path.join(dir, 'sub', 'b.txt'), 'new', 'utf-8');
      expect(getDirtyFiles(dir)).toEqual(['sub/b.txt']);
    });

    it('returns paths sorted', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x', 'b.txt': 'x', 'c.txt': 'x' }, 'init');
      writeFileSync(path.join(dir, 'c.txt'), 'z', 'utf-8');
      writeFileSync(path.join(dir, 'a.txt'), 'z', 'utf-8');
      expect(getDirtyFiles(dir)).toEqual(['a.txt', 'c.txt']);
    });

    it('returns null in a directory that is not a git repository', () => {
      expect(getDirtyFiles(nonRepoDir())).toBeNull();
    });

    it('normalizes every returned path through the canonical POSIX helper (posix-paths-output) — no backslash, no trailing slash, forward-slashed subdirectories', () => {
      const dir = freshRepo();
      commitAt(dir, 0, { 'a.txt': 'x' }, 'init');
      mkdirSync(path.join(dir, 'nested', 'sub'), { recursive: true });
      writeFileSync(path.join(dir, 'nested', 'sub', 'c.txt'), 'new', 'utf-8');

      const files = getDirtyFiles(dir);
      expect(files).toEqual(['nested/sub/c.txt']);
      // Pins the POSTCONDITION `posix-paths-output` requires (no backslash,
      // no trailing slash) rather than the mechanism. Honest caveat: git's
      // own porcelain output is already forward-slashed on every platform
      // (including Windows), so this assertion cannot distinguish
      // getDirtyFiles routing its output through toPosixPath from git simply
      // never emitting a backslash in the first place — on THIS platform it
      // documents the contract rather than proving the call site exists.
      // Verified directly by mutation: removing the `.map(toPosixPath)` call
      // at the source does NOT change this test's outcome on Linux (see
      // task8-fixes.md, ROUND 2, mutation ii).
      for (const f of files ?? []) {
        expect(f).not.toContain('\\');
        expect(f.endsWith('/')).toBe(false);
      }
    });
  });
});
