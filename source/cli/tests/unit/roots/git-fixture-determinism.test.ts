import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initDeterministicGitFixture,
  runDeterministicGitFixture,
  runGitFixture,
  deterministicCommitDate,
} from '../../support/git-fixture.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/git-fixture-determinism.test.ts — the real determinism
// proof for the deterministic-history exports added to
// tests/support/git-fixture.ts (spec §20.2's named prerequisite for golden
// git repositories): scripting the SAME commit history twice, in two
// independent temp directories, must produce byte-identical commit SHAs at
// every step — not just at HEAD. A pinned author/committer date with no
// pinned identity or default branch would still drift the tree hash's
// dependent commit hash across two runs on hosts with different global git
// identities or git-version default branches, so this test pins all three
// and then actually checks per-commit equality, not only the final one.
//
// A same-run self-comparison alone is NOT sufficient proof: if the date pin
// were silently broken (e.g. `GIT_AUTHOR_DATE` failing to apply), both builds
// in the SAME test run would still fall inside the same one-second git
// timestamp granularity often enough to match each other by coincidence,
// passing a test that proves nothing about determinism across machines or
// runs. The dedicated test below closes that gap: it asserts each commit's
// author AND committer date, read back with `git log --date=iso-strict`,
// equals `deterministicCommitDate(index)` EXACTLY — an absolute pin against
// the function under test, not a comparison between two live builds that
// could coincidentally agree.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run a git command in a deterministic-history fixture, throwing on failure. */
function git(dir: string, args: string[], commitIndex: number, extraEnv: NodeJS.ProcessEnv = {}): void {
  const r = runDeterministicGitFixture(dir, args, commitIndex, { extraEnv });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

/**
 * Script a small three-commit history with two different author identities
 * into a fresh temp directory, entirely through the deterministic-history
 * exports, and return the directory.
 */
function buildScriptedHistory(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-git-fixture-det-${label}-`));
  dirsToCleanup.push(dir);

  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);

  const commits = [
    { path: 'a.txt', content: 'first\n', author: 'alice' },
    { path: 'b/c.txt', content: 'second\n', author: 'bob' },
    { path: 'a.txt', content: 'first, revised\n', author: 'alice' },
  ];
  commits.forEach((commit, index) => {
    const target = path.join(dir, commit.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, commit.content, 'utf-8');
    git(dir, ['add', '-A'], index);
    git(dir, ['commit', '-q', '-m', `commit ${index}`], index, {
      GIT_AUTHOR_NAME: commit.author,
      GIT_AUTHOR_EMAIL: `${commit.author}@golden.test`,
      GIT_COMMITTER_NAME: commit.author,
      GIT_COMMITTER_EMAIL: `${commit.author}@golden.test`,
    });
  });

  return dir;
}

/** Every commit SHA in `dir`'s history, oldest first. */
function commitShas(dir: string): string[] {
  const r = runGitFixture(dir, ['log', '--format=%H', '--reverse']);
  if (r.status !== 0) throw new Error(`git log failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r.stdout.split('\n').filter((line) => line.length > 0);
}

/** This commit's author date and committer date, in ISO-8601 strict form (`git log --date=iso-strict`). */
function commitDates(dir: string, ref: string): { author: string; committer: string } {
  const r = runGitFixture(dir, ['log', '-1', '--format=%ad%n%cd', '--date=iso-strict', ref]);
  if (r.status !== 0) throw new Error(`git log failed in ${dir}: ${r.stderr}${r.stdout}`);
  const [author, committer] = r.stdout.trim().split('\n');
  return { author, committer };
}

describe('deterministic git-fixture history — two builds of the same script produce identical commit SHAs', () => {
  it('every commit SHA matches, not just HEAD', () => {
    const first = buildScriptedHistory('a');
    const second = buildScriptedHistory('b');

    const firstShas = commitShas(first);
    const secondShas = commitShas(second);

    expect(firstShas).toHaveLength(3);
    expect(secondShas).toEqual(firstShas);
  });

  it('each commit is pinned to deterministicCommitDate(index) EXACTLY — not just self-consistent across two builds', () => {
    // A same-run self-comparison (the test above) is not proof on its own: if
    // the date pin silently failed, two builds made moments apart in the SAME
    // test run could still land in the same one-second git timestamp
    // granularity and match each other by coincidence. This test instead
    // checks each commit's recorded author/committer date against the FIXED
    // output of deterministicCommitDate(index) — the function under test —
    // so a broken pin fails here even when a self-comparison would not catch
    // it. Parsed to epoch ms rather than string-compared, since
    // `git log --date=iso-strict` renders as "…+00:00" (no milliseconds)
    // while `deterministicCommitDate` renders as "…000Z" — both name the
    // same instant, so comparing what they resolve to is the correct check,
    // not a coincidence of formatting.
    const dir = buildScriptedHistory('pin');
    const shas = commitShas(dir);
    expect(shas).toHaveLength(3);

    shas.forEach((sha, index) => {
      const { author, committer } = commitDates(dir, sha);
      const expectedMs = new Date(deterministicCommitDate(index)).getTime();
      expect(new Date(author).getTime()).toBe(expectedMs);
      expect(new Date(committer).getTime()).toBe(expectedMs);
    });
  });

  it('deterministicCommitDate is a pure function of the commit index alone', () => {
    expect(deterministicCommitDate(0)).toBe(deterministicCommitDate(0));
    expect(deterministicCommitDate(0)).not.toBe(deterministicCommitDate(1));
    // ISO-8601 "…Z" form, per spec §20.2.
    expect(deterministicCommitDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('deterministic git-fixture history — existing exports stay unaffected', () => {
  it('runGitFixture (undated) still produces a working, ordinary commit', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-fixture-det-plain-'));
    dirsToCleanup.push(dir);

    const init = runGitFixture(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
    expect(init.status).toBe(0);

    writeFileSync(path.join(dir, 'x.txt'), 'x\n', 'utf-8');
    const add = runGitFixture(dir, ['add', '-A']);
    expect(add.status).toBe(0);
    const commit = runGitFixture(dir, ['commit', '-q', '-m', 'plain commit']);
    expect(commit.status).toBe(0);

    // No GIT_AUTHOR_DATE/GIT_COMMITTER_DATE pin: the commit's own date is
    // whatever git derives itself, never the deterministic exports' fixed
    // 2024-01-01 epoch — proving the shared runGitFixture path was never
    // touched by the new exports. Compared against that FIXED epoch string
    // (a constant that never changes), not against "today" — so this
    // assertion's outcome depends only on the code under test, on any day
    // the suite runs.
    const show = runGitFixture(dir, ['show', '-s', '--format=%ad', '--date=format:%Y-%m-%d']);
    expect(show.status).toBe(0);
    const authorDate = show.stdout.trim();
    expect(authorDate).not.toBe('');
    expect(authorDate).not.toBe('2024-01-01');
  });
});
