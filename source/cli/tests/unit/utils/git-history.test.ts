// =============================================================================
// tests/unit/utils/git-history.test.ts — the git-plumbing pins for
// src/utils/git-history.ts: the raw `--raw -z` walk framing, the ordering
// git actually delivers (never assumed), rename/typechange detection, author
// and fix classification, resume-range byte-identity, and the
// `cat-file --batch` blob reader's chunking and byte-counted framing.
//
// Every fixture here is built through the deterministic primitives in
// tests/support/git-fixture.ts (GIT_CONFIG_GLOBAL/SYSTEM pinned to /dev/null,
// an explicit GIT_DIR so no fixture git op can ever discover this
// repository's own real .git) — no fabricated git output anywhere; every
// assertion runs against a REAL git spawned against a REAL throwaway repo.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { runGitFixture, initDeterministicGitFixture } from '../../support/git-fixture.js';
import {
  walkHistory,
  readHead,
  openBlobReader,
  readBlobs,
  isShallowRepository,
  isCommitReachable,
  GitLogError,
} from '../../../src/utils/git-history.js';
import type { WalkOptions, HistoryCommitRecord } from '../../../src/utils/git-history.js';

// -----------------------------------------------------------------------------
// A spawn spy that ALWAYS delegates to the real `node:child_process.spawn` —
// every child this file's tests ever produce is a real git process; the spy
// only counts calls and, for exactly one test (the git-unavailable degrade),
// can redirect a single call's binary name to something that genuinely does
// not exist, producing a REAL ENOENT rather than a fabricated one.
// -----------------------------------------------------------------------------
const spawnCalls: unknown[][] = [];
let forceNextSpawnBinaryMissing = false;
// Every REAL child returned by `spawn` (never a fake), captured in spawn
// order — lets a test reach into a specific `cat-file --batch` child (e.g.
// to `.kill()` it, proving a mid-stream death degrades cleanly rather than
// hanging) without the module under test exposing any child-process detail
// itself.
const spawnedChildren: import('node:child_process').ChildProcess[] = [];
// Aligned index-for-index with spawnedChildren: for a child with a stdin
// pipe (the blob-reader child; walkHistory's child has none — `stdio:
// ['ignore', ...]`), the SHA-count of every write() call made into it, in
// call order — e.g. `[400, 400, 100]` for a 900-SHA readBlobs. Populated by
// wrapping `stdin.write` right where the child is created, never by
// reaching into the module under test.
const stdinWriteLineCounts: number[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnCalls.push(args);
      if (forceNextSpawnBinaryMissing) {
        forceNextSpawnBinaryMissing = false;
        const [, cmdArgs, opts] = args as unknown as [string, string[] | undefined, object | undefined];
        return actual.spawn('yg-git-history-test-definitely-missing-binary', cmdArgs, opts);
      }
      const child = actual.spawn(...args);
      spawnedChildren.push(child);
      const counts: number[] = [];
      stdinWriteLineCounts.push(counts);
      if (child.stdin) {
        const originalWrite = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
          const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8');
          counts.push(text.length === 0 ? 0 : text.split('\n').filter((l) => l.length > 0).length);
          return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof child.stdin.write;
      }
      return child;
    },
  };
});

beforeEach(() => {
  spawnCalls.length = 0;
  spawnedChildren.length = 0;
  stdinWriteLineCounts.length = 0;
  forceNextSpawnBinaryMissing = false;
});

// -----------------------------------------------------------------------------
// Fixture plumbing
// -----------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkFixtureDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-git-history-${label}-`));
  dirsToCleanup.push(dir);
  initDeterministicGitFixture(dir);
  return dir;
}

/** The fixed epoch every `dayIso` offset counts from — 2024-01-01T00:00:00Z. */
const EPOCH_MS = Date.parse('2024-01-01T00:00:00Z');
/** ISO-8601 instant `n` days after the fixed epoch — used to script exact committer dates. */
function dayIso(n: number): string {
  return new Date(EPOCH_MS + n * 86_400_000).toISOString();
}

/**
 * A git op inside a fixture at an EXPLICIT ISO date (not the `commitIndex`-
 * derived spacing `runDeterministicGitFixture` fixes internally) — needed for
 * every ordering test below, which must script SPECIFIC committer dates (day
 * 0, day 50, day 121, …) to reproduce D16's empirically-verified ordering
 * claims. Isolated exactly like `deterministicGitFixtureEnv` (`GIT_DIR`
 * pinned, `GIT_CONFIG_GLOBAL`/`SYSTEM` scrubbed to `/dev/null`, `TZ=UTC`) —
 * this is that same isolation with the date parameterized instead of derived
 * from a commit index.
 */
function gitAt(dir: string, args: string[], isoDate: string, extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return runGitFixture(dir, args, {
    extraEnv: {
      TZ: 'UTC',
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...extraEnv,
    },
  });
}

function gitAtOk(dir: string, args: string[], isoDate: string, extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  const r = gitAt(dir, args, isoDate, extraEnv);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r;
}

function readCommitted(dir: string, args: string[]): string {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

function headSha(dir: string): string {
  return readCommitted(dir, ['rev-parse', 'HEAD']).trim();
}

function writeFile(dir: string, relPath: string, content: string): void {
  const target = path.join(dir, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
}

/** Standard test defaults compiling a `claude`/`bot` agent-identity set, matching `history.agentIdentities`'s spec default shape. */
const AGENT_PATTERNS = ['claude', 'copilot', '\\bbot\\b'];

async function walkAll(dir: string, opts: Partial<WalkOptions> = {}): Promise<HistoryCommitRecord[]> {
  const commits: HistoryCommitRecord[] = [];
  await walkHistory(dir, { agentIdentities: AGENT_PATTERNS, ...opts }, (c) => commits.push(c));
  return commits;
}

// -----------------------------------------------------------------------------
// Step 1 — literal captured-output pin: this file's own read of what git
// ACTUALLY emits, independent of anything walkHistory itself computes, so a
// future git version that changes the `-z` framing fails this test loudly
// rather than silently mis-parsing inside the walk.
// -----------------------------------------------------------------------------

describe('raw log framing — literal pin against real git output', () => {
  it('captures the exact NUL-delimited token structure for a single-file commit', () => {
    const dir = mkFixtureDir('literal-framing');
    writeFile(dir, 'a.ts', 'hello\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));

    const sha = headSha(dir);
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    const format = ['%H', '%ct', '%an', '%ae', '%B'].join('%x00');
    const raw = runGitFixture(dir, [
      'log', '--reverse', '--date-order', '--raw', '--no-abbrev', '--no-merges', '-M', '-z', `--format=${format}`,
    ]);
    if (raw.status !== 0) throw new Error(`git log failed: ${raw.stderr}`);
    const buf = Buffer.from(raw.stdout, 'utf-8');
    const tokens = buf.toString('utf-8').split('\0');
    // trailing empty token from the final NUL terminator
    expect(tokens[tokens.length - 1]).toBe('');
    const real = tokens.slice(0, -1);

    // Exactly 5 header fields + 1 raw-record status line + 1 path = 7 tokens.
    expect(real).toHaveLength(7);
    expect(real[0]).toBe(sha);
    expect(Number(real[1])).toBeGreaterThan(0);
    expect(real[2]).toBe('yg-test');
    expect(real[3]).toBe('yg-test@fixture.test');
    expect(real[4]).toBe('seed\n');
    // The blank separator line: a literal leading '\n' on the FIRST record
    // token of a commit's diff section, and ONLY there.
    expect(real[5].startsWith('\n:')).toBe(true);
    expect(real[5]).toBe(`\n:000000 100644 0000000000000000000000000000000000000000 ${blobSha} A`);
    expect(real[6]).toBe('a.ts');
  });

  it('captures a path containing a space, including through a rename — the shape DECISION #2 (NUL framing, never whitespace splitting) exists for', () => {
    const dir = mkFixtureDir('literal-framing-spaced-path');
    writeFile(dir, 'a path with spaces.ts', 'hello\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed spaced path'], dayIso(0));
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a path with spaces.ts']).trim();

    gitAtOk(dir, ['mv', 'a path with spaces.ts', 'renamed path with spaces.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename spaced path'], dayIso(1));

    const format = ['%H', '%ct', '%an', '%ae', '%B'].join('%x00');
    const raw = runGitFixture(dir, [
      'log', '--reverse', '--date-order', '--raw', '--no-abbrev', '--no-merges', '-M', '-z', `--format=${format}`,
    ]);
    if (raw.status !== 0) throw new Error(`git log failed: ${raw.stderr}`);
    const tokens = Buffer.from(raw.stdout, 'utf-8').toString('utf-8').split('\0');
    expect(tokens[tokens.length - 1]).toBe('');
    const real = tokens.slice(0, -1);

    // Commit 1 (seed): 5 header fields + 1 record line + 1 spaced path = 7 tokens.
    // Commit 2 (rename): 5 header fields + 1 record line + 2 spaced paths = 8 tokens.
    expect(real).toHaveLength(15);
    // The spaced path is a single, WHOLE token — never broken at its internal
    // space by -z's NUL framing, which is exactly the property that would
    // fail silently under a whitespace-splitting parser instead of this
    // module's NUL-only tokenization.
    expect(real[6]).toBe('a path with spaces.ts');
    // The rename record line still carries a similarity-scored status token
    // (Step 1's other pin), even though both its paths contain spaces.
    expect(real[12]).toBe(
      `\n:100644 100644 ${blobSha} ${blobSha} R100`,
    );
    expect(real[13]).toBe('a path with spaces.ts');
    expect(real[14]).toBe('renamed path with spaces.ts');
  });

  it('walkHistory parses a spaced-path rename identically to the literal capture: one R record, both paths intact', async () => {
    const dir = mkFixtureDir('literal-framing-spaced-path-cross-check');
    writeFile(dir, 'a path with spaces.ts', 'hello\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed spaced path'], dayIso(0));
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a path with spaces.ts']).trim();
    gitAtOk(dir, ['mv', 'a path with spaces.ts', 'renamed path with spaces.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename spaced path'], dayIso(1));

    const commits = await walkAll(dir);
    expect(commits).toHaveLength(2);
    expect(commits[1].files).toEqual([
      {
        status: 'R',
        path: 'a path with spaces.ts',
        newPath: 'renamed path with spaces.ts',
        preSha: blobSha,
        postSha: blobSha,
      },
    ]);
  });

  it('walkHistory parses that exact same fixture identically to the literal capture', async () => {
    const dir = mkFixtureDir('literal-framing-cross-check');
    writeFile(dir, 'a.ts', 'hello\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    const commits = await walkAll(dir);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual([
      { status: 'A', path: 'a.ts', preSha: null, postSha: blobSha },
    ]);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 1 — ordering: never before a parent, date decides between
// unrelated commits. Also pins Step 6's `--max-count` truncation claim and
// backs MR-3 (dropping `--no-merges`).
// -----------------------------------------------------------------------------

describe('walkHistory — ordering (D16)', () => {
  it('a dipping linear chain (day 60 -> day 0 -> day 121) walks in exactly that order, never ascending', async () => {
    const dir = mkFixtureDir('dip-order');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(60));
    gitAtOk(dir, ['commit', '-q', '-m', 'c60'], dayIso(60));
    const c60 = headSha(dir);
    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'c0'], dayIso(0));
    const c0 = headSha(dir);
    writeFile(dir, 'f.ts', 'v3\n');
    gitAtOk(dir, ['commit', '-qam', 'c121'], dayIso(121));
    const c121 = headSha(dir);

    const commits = await walkAll(dir);
    // Literal sequence — NOT ascending by committer date: day 60 -> day 0 -> day 121.
    expect(commits.map((c) => c.sha)).toEqual([c60, c0, c121]);
  });

  it('5 commits, one a merge, walk to exactly 4 records, matching a real `git log` capture', async () => {
    const dir = mkFixtureDir('five-commits-one-merge');
    writeFile(dir, 'base.ts', 'base\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'base'], dayIso(0));

    gitAtOk(dir, ['checkout', '-qb', 'side'], dayIso(0));
    writeFile(dir, 'side.ts', 's1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(50));
    gitAtOk(dir, ['commit', '-q', '-m', 'side1'], dayIso(50));

    gitAtOk(dir, ['checkout', '-q', 'main'], dayIso(50));
    writeFile(dir, 'main.ts', 'm1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(100));
    gitAtOk(dir, ['commit', '-q', '-m', 'main1'], dayIso(100));

    gitAtOk(dir, ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], dayIso(110));

    writeFile(dir, 'tail.ts', 't1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(200));
    gitAtOk(dir, ['commit', '-q', '-m', 'tail'], dayIso(200));

    // Independently captured expected order, straight from real git.
    const expectedShas = readCommitted(dir, ['log', '--reverse', '--date-order', '--no-merges', '--format=%H'])
      .trim()
      .split('\n');
    expect(expectedShas).toHaveLength(4);

    const commits = await walkAll(dir);
    expect(commits).toHaveLength(4);
    expect(commits.map((c) => c.sha)).toEqual(expectedShas);
  });

  it('--max-count truncates the TRAVERSAL, not "the newest N by date": excludes day 60, the newer commit', async () => {
    const dir = mkFixtureDir('max-count-dip');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(60));
    gitAtOk(dir, ['commit', '-q', '-m', 'c60'], dayIso(60));
    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'c0'], dayIso(0));
    const c0 = headSha(dir);
    writeFile(dir, 'f.ts', 'v3\n');
    gitAtOk(dir, ['commit', '-qam', 'c121'], dayIso(121));
    const c121 = headSha(dir);

    const commits = await walkAll(dir, { maxCommits: 2 });
    expect(commits.map((c) => c.sha)).toEqual([c0, c121]);
  });

  it('MR-3 backer: without --no-merges the walk would include the merge commit — a killer case for that flag', () => {
    // This test does not toggle the flag (walkHistory always passes
    // --no-merges); it independently proves the flag is load-bearing by
    // showing what git emits WITHOUT it on the exact fixture acceptance 1
    // uses, so the mutation round-trip (removing --no-merges from
    // buildLogArgs) has a concrete, pre-verified failure to point at.
    const dir = mkFixtureDir('mr3-no-merges-backer');
    writeFile(dir, 'base.ts', 'base\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'base'], dayIso(0));
    gitAtOk(dir, ['checkout', '-qb', 'side'], dayIso(0));
    writeFile(dir, 'side.ts', 's1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(50));
    gitAtOk(dir, ['commit', '-q', '-m', 'side1'], dayIso(50));
    gitAtOk(dir, ['checkout', '-q', 'main'], dayIso(50));
    gitAtOk(dir, ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], dayIso(110));

    const withNoMerges = readCommitted(dir, ['log', '--reverse', '--no-merges', '--format=%H']).trim().split('\n');
    const withoutNoMerges = readCommitted(dir, ['log', '--reverse', '--format=%H']).trim().split('\n');
    expect(withoutNoMerges.length).toBeGreaterThan(withNoMerges.length);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 2 and 8 — the branch-and-merge fixture. Built LOCALLY: the
// shared tests/support/branch-merge-fixture.ts a later increment adds does
// not exist yet, so this file constructs the same commit shape on its own.
// -----------------------------------------------------------------------------

interface BranchMergeFixture {
  dir: string;
  base: string;
  side1: string;
  main1: string;
  merge: string;
  tail?: string;
}

/**
 * base(day0) -> side branch: side1(day50) -> main: main1(day100) ->
 * merge(day110) -> optional tail(day200). Mirrors D16's own worked example:
 * the side branch starts before the mainline tip it eventually merges into,
 * which is exactly the shape that makes a full walk deliver the side-branch
 * commit before `main1` — the ordering property acceptance 2 depends on.
 */
function buildBranchMergeFixture(label: string, opts: { trailingMainCommit: boolean }): BranchMergeFixture {
  const dir = mkFixtureDir(label);
  writeFile(dir, 'base.ts', 'base\n');
  gitAtOk(dir, ['add', '-A'], dayIso(0));
  gitAtOk(dir, ['commit', '-q', '-m', 'base'], dayIso(0));
  const base = headSha(dir);

  gitAtOk(dir, ['checkout', '-qb', 'side'], dayIso(0));
  writeFile(dir, 'side.ts', 's1\n');
  gitAtOk(dir, ['add', '-A'], dayIso(50));
  gitAtOk(dir, ['commit', '-q', '-m', 'side1'], dayIso(50));
  const side1 = headSha(dir);

  gitAtOk(dir, ['checkout', '-q', 'main'], dayIso(50));
  writeFile(dir, 'main.ts', 'm1\n');
  gitAtOk(dir, ['add', '-A'], dayIso(100));
  gitAtOk(dir, ['commit', '-q', '-m', 'main1'], dayIso(100));
  const main1 = headSha(dir);

  gitAtOk(dir, ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], dayIso(110));
  const merge = headSha(dir);

  let tail: string | undefined;
  if (opts.trailingMainCommit) {
    writeFile(dir, 'tail.ts', 't1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(200));
    gitAtOk(dir, ['commit', '-q', '-m', 'tail'], dayIso(200));
    tail = headSha(dir);
  }

  return { dir, base, side1, main1, merge, tail };
}

describe('walkHistory — resume range (D16, R4-I2 foundation)', () => {
  it('a resume from the pre-merge mainline commit yields a strict subset whose shared records are byte-identical to the full walk', async () => {
    const fx = buildBranchMergeFixture('resume-range', { trailingMainCommit: true });

    const full = await walkAll(fx.dir);
    const fullShas = full.map((c) => c.sha);
    expect(fullShas).toEqual([fx.base, fx.side1, fx.main1, fx.tail]);

    const resumed = await walkAll(fx.dir, { sinceSha: fx.main1 });
    const resumedShas = resumed.map((c) => c.sha);
    // Strict subset of the full walk's commit set.
    expect(resumedShas.length).toBeLessThan(fullShas.length);
    for (const sha of resumedShas) expect(fullShas).toContain(sha);
    // The side-branch commit is genuinely in this subset — the interesting
    // case D16 is about: the full walk placed it BEFORE main1, the resumed
    // walk necessarily delivers it AFTER (main1 is excluded from the range).
    expect(resumedShas).toContain(fx.side1);

    const byShaFull = new Map(full.map((c) => [c.sha, c]));
    const byShaResumed = new Map(resumed.map((c) => [c.sha, c]));
    for (const sha of resumedShas) {
      const a = byShaFull.get(sha)!;
      const b = byShaResumed.get(sha)!;
      expect(b.files).toEqual(a.files);
    }
  });

  it('acceptance 8: HEAD is a merge commit — the walk emits no record for it, while readHead reports its sha and timestamp independently', async () => {
    const fx = buildBranchMergeFixture('head-is-merge', { trailingMainCommit: false });

    const commits = await walkAll(fx.dir);
    expect(commits.map((c) => c.sha)).not.toContain(fx.merge);
    expect(commits.map((c) => c.sha)).toEqual([fx.base, fx.side1, fx.main1]);

    const head = readHead(fx.dir);
    expect(head.sha).toBe(fx.merge);
    // The VALUE, not merely its non-nullness: the merge is committed at
    // dayIso(110) while the last-walked (non-merge) commit, main1, is
    // committed at dayIso(100) — a `readHead` that (wrongly) read the
    // main-line tip's timestamp instead of HEAD's own would still pass a
    // not-null check while returning day 100's timestamp. Pinning the exact
    // value is what a merge-blind `readHead` (`git log -1 --no-merges
    // --format=%cI`) fails, which is the entire reason this reader exists
    // separately from the walk (`git-history.ts:111-123`).
    expect(head.committerTs).toBe(Math.floor(Date.parse(dayIso(110)) / 1000));
    expect(head.committerIso).toBe(readCommitted(fx.dir, ['log', '-1', '--format=%cI']).trim());
  });
});

// -----------------------------------------------------------------------------
// Acceptance 3 and 9 — rename / whole-directory rename / typechange.
// -----------------------------------------------------------------------------

describe('walkHistory — rename and typechange detection', () => {
  it('acceptance 3: `git mv a.ts b.ts` yields exactly one R record, score digits stripped', async () => {
    const dir = mkFixtureDir('rename-single');
    writeFile(dir, 'a.ts', 'content\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    gitAtOk(dir, ['mv', 'a.ts', 'b.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename'], dayIso(1));

    const commits = await walkAll(dir);
    const renameCommit = commits[commits.length - 1];
    expect(renameCommit.files).toEqual([
      { status: 'R', path: 'a.ts', newPath: 'b.ts', preSha: blobSha, postSha: blobSha },
    ]);
  });

  it('a whole-directory `git mv` of six files yields six R records', async () => {
    const dir = mkFixtureDir('rename-whole-dir');
    for (let i = 1; i <= 6; i++) writeFile(dir, `olddir/f${i}.ts`, `content ${i}\n`);
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));

    gitAtOk(dir, ['mv', 'olddir', 'newdir'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename dir'], dayIso(1));

    const commits = await walkAll(dir);
    const renameCommit = commits[commits.length - 1];
    expect(renameCommit.files).toHaveLength(6);
    for (const f of renameCommit.files) {
      expect(f.status).toBe('R');
      expect(f.path.startsWith('olddir/')).toBe(true);
      expect(f.newPath?.startsWith('newdir/')).toBe(true);
      expect(f.preSha).toBe(f.postSha);
    }
  });

  it('acceptance 9: a typechange (regular file -> symlink) yields exactly one T record, no newPath, both shas non-null', async () => {
    const dir = mkFixtureDir('typechange');
    writeFile(dir, 'a.ts', 'content\n');
    writeFile(dir, 'target.txt', 'target\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    const preSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    unlinkSync(path.join(dir, 'a.ts'));
    symlinkSync('target.txt', path.join(dir, 'a.ts'));
    gitAtOk(dir, ['add', '-A'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'typechange a'], dayIso(1));
    const postSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    const commits = await walkAll(dir);
    const typechangeCommit = commits[commits.length - 1];
    const tRecord = typechangeCommit.files.find((f) => f.path === 'a.ts');
    expect(tRecord).toEqual({ status: 'T', path: 'a.ts', preSha, postSha });
    expect(tRecord?.newPath).toBeUndefined();
    expect(preSha).not.toBe(postSha);
  });

  it('MR-4 backer: -M forces rename detection even when the repository config disables it, which no default relies on', () => {
    // A clean, /dev/null-config fixture ALONE cannot exercise this: git 2.43's
    // OWN default already turns rename detection on, so `-M`'s absence is
    // invisible against a config-free repo (verified — dropping `-M` on a
    // repo with no `diff.renames` setting still yields an R record). The
    // property `-M` is actually pinned against is a REPOSITORY that has
    // explicitly turned rename detection off (`diff.renames = false`, e.g. a
    // real adopter's own local or global config) — `-M` overrides that
    // config; its absence does not.
    const dir = mkFixtureDir('mr4-backer');
    writeFile(dir, 'a.ts', 'content\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    gitAtOk(dir, ['mv', 'a.ts', 'b.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename'], dayIso(1));

    const setConfig = runGitFixture(dir, ['config', 'diff.renames', 'false']);
    if (setConfig.status !== 0) throw new Error(`git config failed: ${setConfig.stderr}`);

    const withM = readCommitted(dir, ['log', '-1', '--raw', '--no-abbrev', '-M', '--format=']).trim();
    const withoutM = readCommitted(dir, ['log', '-1', '--raw', '--no-abbrev', '--format=']).trim();
    expect(withM).toMatch(/ R\d{3}\t/);
    expect(withoutM).not.toMatch(/ R\d{3}\t/);
  });

  it('MR-4 killer: walkHistory still yields an R record on a repository whose own config disables rename detection', async () => {
    // The load-bearing test through the PRODUCTION path: unlike the two
    // tests above (which read raw git output directly and are unaffected by
    // any change to buildLogArgs), this one calls walkHistory itself, so
    // dropping `-M` from its argument vector fails THIS test — on a repo
    // with `diff.renames=false`, exactly where the plain acceptance-3 test
    // above cannot distinguish "-M present" from "-M absent" (both already
    // detect the rename via git's own default).
    const dir = mkFixtureDir('mr4-killer');
    writeFile(dir, 'a.ts', 'content\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    const blobSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();
    const setConfig = runGitFixture(dir, ['config', 'diff.renames', 'false']);
    if (setConfig.status !== 0) throw new Error(`git config failed: ${setConfig.stderr}`);
    gitAtOk(dir, ['mv', 'a.ts', 'b.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'rename'], dayIso(1));

    const commits = await walkAll(dir);
    const renameCommit = commits[commits.length - 1];
    expect(renameCommit.files).toEqual([
      { status: 'R', path: 'a.ts', newPath: 'b.ts', preSha: blobSha, postSha: blobSha },
    ]);
  });
});

describe('walkHistory — WalkOptions branches', () => {
  it('a D (delete) record carries a non-null preSha and a null postSha', async () => {
    const dir = mkFixtureDir('delete-record');
    writeFile(dir, 'a.ts', 'content\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));
    const preSha = readCommitted(dir, ['rev-parse', 'HEAD:a.ts']).trim();

    gitAtOk(dir, ['rm', '-q', 'a.ts'], dayIso(1));
    gitAtOk(dir, ['commit', '-q', '-m', 'delete a'], dayIso(1));

    const commits = await walkAll(dir);
    const deleteCommit = commits[commits.length - 1];
    expect(deleteCommit.files).toEqual([{ status: 'D', path: 'a.ts', preSha, postSha: null }]);
  });

  it('maxCommits: 0 behaves identically to leaving it unset (uncapped)', async () => {
    const dir = mkFixtureDir('max-commits-zero');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'c0'], dayIso(0));
    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'c1'], dayIso(1));

    const uncapped = await walkAll(dir);
    const zeroCapped = await walkAll(dir, { maxCommits: 0 });
    expect(zeroCapped.map((c) => c.sha)).toEqual(uncapped.map((c) => c.sha));
  });

  it('sinceMonths filters out commits older than the window, measured against wall-clock now', async () => {
    // The fixture's dates are fixed at 2024-01-01 + small offsets — however
    // long after that this suite happens to run, a 1-month window excludes
    // every one of them, while an effectively-unbounded window includes all.
    const dir = mkFixtureDir('since-months');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'c0'], dayIso(0));
    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'c1'], dayIso(1));

    const narrow = await walkAll(dir, { sinceMonths: 1 });
    expect(narrow).toHaveLength(0);

    // git's own `approxidate` parser breaks down well before 1000 "months
    // ago" (empirically verified: it returns nothing past ~500) — 400 stays
    // safely under that while still covering the fixture's 2024 dates for
    // decades of real-world test runs.
    const wide = await walkAll(dir, { sinceMonths: 400 });
    expect(wide).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 4 and 5 — author-kind and fix classification.
// -----------------------------------------------------------------------------

describe('walkHistory — author-kind classification (G.2)', () => {
  it('acceptance 4: an agent author, a Co-Authored-By trailer, and a plain human commit classify correctly', async () => {
    const dir = mkFixtureDir('author-kind');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0), { GIT_AUTHOR_NAME: 'claude', GIT_AUTHOR_EMAIL: 'claude@example.test', GIT_COMMITTER_NAME: 'claude', GIT_COMMITTER_EMAIL: 'claude@example.test' });
    gitAtOk(dir, ['commit', '-q', '-m', 'agent commit'], dayIso(0), { GIT_AUTHOR_NAME: 'claude', GIT_AUTHOR_EMAIL: 'claude@example.test', GIT_COMMITTER_NAME: 'claude', GIT_COMMITTER_EMAIL: 'claude@example.test' });

    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'human commit with a trailer', '-m', 'Co-Authored-By: Claude <claude@example.test>'], dayIso(1));

    writeFile(dir, 'f.ts', 'v3\n');
    gitAtOk(dir, ['commit', '-qam', 'plain human commit'], dayIso(2));

    const commits = await walkAll(dir);
    expect(commits[0].authorKind).toBe('agent');
    expect(commits[1].authorKind).toBe('agent');
    expect(commits[2].authorKind).toBe('human');
  });

  it('MR-5 backer: without the Co-Authored-By scan, the trailer-only commit would classify human', () => {
    const dir = mkFixtureDir('mr5-backer');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-qam', 'human commit with a trailer', '-m', 'Co-Authored-By: Claude <claude@example.test>'], dayIso(0));
    const body = readCommitted(dir, ['log', '-1', '--format=%B']);
    // The author identity itself carries no agent pattern — only the trailer does.
    expect(body).toMatch(/Co-Authored-By: Claude <claude@example\.test>/i);
    const authorLine = readCommitted(dir, ['log', '-1', '--format=%an %ae']).trim();
    expect(authorLine).toBe('yg-test yg-test@fixture.test');
  });
});

describe('walkHistory — fix classification (G.1)', () => {
  it('acceptance 5: fix:, Revert "x", and a body containing "This reverts commit" classify isFix true; refactor: does not', async () => {
    const dir = mkFixtureDir('fix-classification');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'fix: handle empty input'], dayIso(0));

    writeFile(dir, 'f.ts', 'v2\n');
    gitAtOk(dir, ['commit', '-qam', 'Revert "x"'], dayIso(1));

    writeFile(dir, 'f.ts', 'v3\n');
    gitAtOk(dir, ['commit', '-qam', 'tweak something unrelated', '-m', 'This reverts commit abc123.'], dayIso(2));

    writeFile(dir, 'f.ts', 'v4\n');
    gitAtOk(dir, ['commit', '-qam', 'refactor: prefix handling'], dayIso(3));

    const commits = await walkAll(dir);
    expect(commits[0].isFix).toBe(true);
    expect(commits[1].isFix).toBe(true);
    expect(commits[2].isFix).toBe(true);
    expect(commits[3].isFix).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Degraded modes (R4-I10): git unavailable -> an empty walk, never a
// rejection; a genuine command failure (spawned, but exits non-zero) -> a
// typed GitLogError the caller must interpret.
// -----------------------------------------------------------------------------

describe('walkHistory — degraded modes', () => {
  it('git unavailable (spawn ENOENT) resolves an empty walk rather than rejecting', async () => {
    const dir = mkFixtureDir('git-unavailable');
    forceNextSpawnBinaryMissing = true;
    const result = await walkHistory(dir, { agentIdentities: [] }, () => {
      throw new Error('onCommit must not be called on an empty walk');
    });
    expect(result).toEqual({ commits: 0 });
  });

  it('a spawned git that exits non-zero (an unreachable sinceSha) rejects with a typed GitLogError carrying the stderr tail', async () => {
    const dir = mkFixtureDir('nonzero-exit');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));

    const badSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await expect(walkAll(dir, { sinceSha: badSha })).rejects.toBeInstanceOf(GitLogError);
    try {
      await walkAll(dir, { sinceSha: badSha });
      expect.fail('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(GitLogError);
      expect((e as InstanceType<typeof GitLogError>).stderrTail.length).toBeGreaterThan(0);
    }
  });

  it('a non-git directory resolves an empty walk (git spawns, exits non-zero — same GitLogError path)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-history-not-a-repo-'));
    dirsToCleanup.push(dir);
    await expect(walkAll(dir)).rejects.toBeInstanceOf(GitLogError);
  });
});

// -----------------------------------------------------------------------------
// readHead
// -----------------------------------------------------------------------------

describe('readHead', () => {
  it('reads HEAD sha and both timestamp representations for an ordinary repo', () => {
    const dir = mkFixtureDir('read-head-ordinary');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(5));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(5));

    const head = readHead(dir);
    expect(head.sha).toBe(headSha(dir));
    expect(head.committerIso).not.toBeNull();
    expect(head.committerTs).toBe(Math.floor(Date.parse(head.committerIso!) / 1000));
  });

  it('returns all-null for a directory with no git repository at all', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-history-readhead-norepo-'));
    dirsToCleanup.push(dir);
    const head = readHead(dir);
    expect(head).toEqual({ sha: null, committerTs: null, committerIso: null });
  });
});

// -----------------------------------------------------------------------------
// Acceptance 7 — shallow-clone detection, plus commit reachability.
// -----------------------------------------------------------------------------

describe('isShallowRepository / isCommitReachable', () => {
  it('acceptance 7: a --depth 1 clone reports isShallowRepository() === true; the source repo does not', () => {
    const source = mkFixtureDir('shallow-source');
    writeFile(source, 'f.ts', 'v1\n');
    gitAtOk(source, ['add', '-A'], dayIso(0));
    gitAtOk(source, ['commit', '-q', '-m', 'c0'], dayIso(0));
    writeFile(source, 'f.ts', 'v2\n');
    gitAtOk(source, ['commit', '-qam', 'c1'], dayIso(1));

    expect(isShallowRepository(source)).toBe(false);

    // A plain scrubbed env, deliberately WITHOUT gitFixtureEnv's GIT_DIR/
    // GIT_WORK_TREE pins: `git clone` creates its OWN repository at the
    // destination, and a pre-set GIT_DIR/GIT_WORK_TREE pointing at that same
    // destination makes clone think a working tree already exists there.
    // tests/setup.ts already scrubs the inherited discovery vars process-wide
    // for this worker, so no GIT_DIR leak reaches this call either way.
    const clone = mkdtempSync(path.join(tmpdir(), 'yg-git-history-shallow-clone-'));
    dirsToCleanup.push(clone);
    const cloneEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    delete cloneEnv.GIT_DIR;
    delete cloneEnv.GIT_WORK_TREE;
    const r = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, '.'], {
      cwd: clone,
      env: cloneEnv,
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
    expect(isShallowRepository(clone)).toBe(true);
  });

  it('a real commit sha is reachable; a plausible-but-nonexistent one is not', () => {
    const dir = mkFixtureDir('reachability');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'c0'], dayIso(0));
    const sha = headSha(dir);

    expect(isCommitReachable(dir, sha)).toBe(true);
    expect(isCommitReachable(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  it('both fail soft to false on a non-git directory (degrade branch)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-history-norepo-probes-'));
    dirsToCleanup.push(dir);
    expect(isShallowRepository(dir)).toBe(false);
    expect(isCommitReachable(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 6 — the blob reader: one child per handle, chunked writes,
// byte-exact content across many read() calls. Plus MR-6 and the missing-
// object / closed-reader / error-propagation edge cases coverage needs.
// -----------------------------------------------------------------------------

function commitManyDistinctFiles(dir: string, count: number): string[] {
  for (let i = 0; i < count; i++) writeFile(dir, `blobs/f${i}.txt`, `distinct content #${i}\n`);
  gitAtOk(dir, ['add', '-A'], dayIso(0));
  gitAtOk(dir, ['commit', '-q', '-m', `${count} distinct blobs`], dayIso(0));
  const lsTree = readCommitted(dir, ['ls-tree', '-r', 'HEAD', '--', 'blobs']);
  // Parsed as (index, sha) pairs and re-sorted into NUMERIC index order.
  // `ls-tree`'s own order is LEXICOGRAPHIC by path (f0, f1, f10, f100, ...,
  // f2, f20, ...), which would silently desync `shas[i]` from
  // `"distinct content #<i>\n"` for any caller correlating the two by array
  // position (acceptance 6a's byte-exactness check).
  const entries = lsTree
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.split(/\s+/);
      const sha = parts[2];
      const filePath = parts[3];
      const m = /f(\d+)\.txt$/.exec(filePath);
      if (!m) throw new Error(`unexpected ls-tree path: ${filePath}`);
      return { index: Number(m[1]), sha };
    })
    .sort((a, b) => a.index - b.index)
    .map((e) => e.sha);
  expect(new Set(entries).size).toBe(count);
  return entries;
}

describe('blob reader — readBlobs / openBlobReader', () => {
  it('acceptance 6a: readBlobs over 900 distinct SHAs spawns exactly one child, writes three request batches (400+400+100), and delivers byte-exact content 900 times', async () => {
    const dir = mkFixtureDir('blob-900');
    const shas = commitManyDistinctFiles(dir, 900);

    const seen = new Map<string, Buffer>();
    let invocationCount = 0;
    await readBlobs(dir, shas, (sha, content) => {
      invocationCount++;
      seen.set(sha, content);
    });

    // 900 CALLBACK INVOCATIONS — not merely 900 distinct keys, which a
    // double-dispatch of the same sha would also satisfy.
    expect(invocationCount).toBe(900);
    expect(seen.size).toBe(900);
    // BYTE-EXACT CONTENT per blob, not merely presence: each file's content
    // is `distinct content #<i>\n`, keyed by its own sha.
    for (let i = 0; i < 900; i++) {
      const sha = shas[i];
      expect(Buffer.compare(seen.get(sha)!, Buffer.from(`distinct content #${i}\n`))).toBe(0);
    }

    const catFileSpawns = spawnCalls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'cat-file');
    expect(catFileSpawns).toHaveLength(1);

    // THREE REQUEST BATCHES INTO THAT SINGLE CHILD (400 + 400 + 100 — Step
    // 4's chunk size): "at most 3 children" or "the right SHAs came back"
    // pins nothing here, since a single write of all 900 satisfies both — the
    // batch BOUNDARY is only visible by counting each write() call's own
    // line count. (`BLOB_BATCH_SIZE` 400 -> 1000 would collapse this to a
    // single write of 900 and survive every other assertion in this test.)
    const catFileChildIndex = spawnCalls.findIndex((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'cat-file');
    expect(catFileChildIndex).toBeGreaterThanOrEqual(0);
    expect(stdinWriteLineCounts[catFileChildIndex]).toEqual([400, 400, 100]);
  });

  it('acceptance 6b: a handle driven through three separate 10-SHA read() calls still spawns exactly one child in total', async () => {
    const dir = mkFixtureDir('blob-handle-reuse');
    const shas = commitManyDistinctFiles(dir, 30);

    const reader = openBlobReader(dir);
    const seen = new Map<string, Buffer>();
    try {
      for (let i = 0; i < 3; i++) {
        const batch = shas.slice(i * 10, i * 10 + 10);
        await reader.read(batch, (sha, content) => {
          seen.set(sha, content);
        });
      }
    } finally {
      reader.close();
    }

    expect(seen.size).toBe(30);
    const catFileSpawns = spawnCalls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'cat-file');
    expect(catFileSpawns).toHaveLength(1);
  });

  it('MR-6 backer: byte-exact content for a blob containing an embedded blank line (would break under newline-scanning framing)', async () => {
    const dir = mkFixtureDir('blob-embedded-blank-line');
    const content = 'line1\n\nline3\nlast-no-newline';
    writeFile(dir, 'weird.txt', content);
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'weird blob'], dayIso(0));
    const sha = readCommitted(dir, ['rev-parse', 'HEAD:weird.txt']).trim();

    let got: Buffer | undefined;
    await readBlobs(dir, [sha], (s, c) => {
      if (s === sha) got = c;
    });
    expect(got?.toString('utf-8')).toBe(content);
  });

  it('a missing object dispatches an empty buffer rather than crashing', async () => {
    const dir = mkFixtureDir('blob-missing');
    writeFile(dir, 'f.ts', 'v1\n');
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'seed'], dayIso(0));

    const missingSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    let called = false;
    await readBlobs(dir, [missingSha], (sha, content) => {
      called = true;
      expect(sha).toBe(missingSha);
      expect(content.length).toBe(0);
    });
    expect(called).toBe(true);
  });

  it('reading zero SHAs resolves immediately without writing a request batch', async () => {
    const dir = mkFixtureDir('blob-empty-read');
    const reader = openBlobReader(dir);
    try {
      await reader.read([], () => {
        throw new Error('must not be called');
      });
    } finally {
      reader.close();
    }
    // The handle itself spawns exactly one child at open time (unconditionally,
    // per §13.2) — the assertion here is that an EMPTY read adds no SECOND
    // spawn and no request batch, not that opening the handle spawned nothing.
    const catFileSpawns = spawnCalls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'cat-file');
    expect(catFileSpawns).toHaveLength(1);
  });

  it('a read() after close() rejects rather than hanging or crashing', async () => {
    const dir = mkFixtureDir('blob-read-after-close');
    const shas = commitManyDistinctFiles(dir, 1);
    const reader = openBlobReader(dir);
    reader.close();
    await expect(reader.read(shas, () => {})).rejects.toThrow(/closed/i);
  });

  it('an onBlob callback that throws propagates as a rejection of read()', async () => {
    const dir = mkFixtureDir('blob-onblob-throws');
    const shas = commitManyDistinctFiles(dir, 1);
    const boom = new Error('boom from onBlob');
    await expect(readBlobs(dir, shas, () => { throw boom; })).rejects.toBe(boom);
  });

  it('an onBlob callback that returns a REJECTED promise also propagates as a rejection of read()', async () => {
    const dir = mkFixtureDir('blob-onblob-rejects');
    const shas = commitManyDistinctFiles(dir, 1);
    const boom = new Error('boom from async onBlob');
    await expect(readBlobs(dir, shas, async () => { throw boom; })).rejects.toBe(boom);
  });

  it('git cat-file --batch unavailable (spawn ENOENT) rejects the in-flight read()', async () => {
    const dir = mkFixtureDir('blob-git-unavailable');
    const shas = commitManyDistinctFiles(dir, 1);
    forceNextSpawnBinaryMissing = true;
    await expect(readBlobs(dir, shas, () => {})).rejects.toBeTruthy();
  });

  it('readBlobs against a non-git directory rejects (a real EPIPE) rather than crashing the process — R4-I4/R4-I10', async () => {
    // `cat-file --batch` spawns successfully (git IS on PATH) but, given a
    // directory that is not a repository, exits immediately with a fatal
    // error BEFORE ever reading stdin. The queued request-batch write is
    // issued as soon as the handle opens — the SAME timing a real caller
    // uses — so it genuinely races the child's own exit at the OS level
    // (confirmed live: a throwaway probe of this exact scenario against the
    // unfixed module produced `UNCAUGHT: Error: write EPIPE`, exit code 3;
    // waiting for Node's own 'exit' event first would instead land on an
    // already-`destroyed` stream, whose writes silently no-op — the
    // opposite of what this finding is about). Absent an 'error' listener on
    // `child.stdin`, that EPIPE is an UNCAUGHT EXCEPTION that aborts the
    // whole process; this test only passes if it instead surfaces as an
    // ordinary rejection the caller can degrade on, per R4-I10 ("no git" is
    // R4-I4's own planned degraded mode) — the same shape a corrupt object
    // store or an OOM-killed child would also produce.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-git-history-blob-not-a-repo-'));
    dirsToCleanup.push(dir);
    // The request must exceed a pipe's kernel buffer (~64 KB), so the write
    // physically cannot be absorbed before the already-doomed child exits:
    // that turns the EPIPE from a race into a certainty. A single-SHA request
    // is small enough that the write usually wins, and the test then passes
    // through the close handler's own rejection without ever exercising the
    // stdin 'error' listener this test exists to pin.
    const manyShas = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(40, '0'));
    await expect(
      readBlobs(dir, manyShas, () => {
        throw new Error('onBlob must not be called: the child never reaches a response');
      }),
    ).rejects.toThrow(/EPIPE/);
  });

  it('a mid-stream child death (killed by signal, after it has already started responding) rejects the in-flight read() rather than hanging forever', async () => {
    // Distinct from EPIPE above: there, the write itself never lands because
    // the child is already dead. Here the write succeeds and the child
    // begins streaming a REAL response — killed only once at least one byte
    // of it has actually arrived, so this is a genuine mid-flight death, not
    // a race against read()'s own (microtask-deferred) write. A large blob
    // (far bigger than a pipe's kernel buffer) is used so "the first byte
    // has arrived" cannot also mean "the whole response has arrived".
    // `close`'s (code, signal) pair reports `code: null` for BOTH a
    // signal-killed child and a clean `stdin.end()`-driven exit — `signal`
    // is what tells them apart, and only the fix threads it through.
    const dir = mkFixtureDir('blob-mid-stream-kill');
    writeFile(dir, 'big.bin', 'x'.repeat(4 * 1024 * 1024));
    gitAtOk(dir, ['add', '-A'], dayIso(0));
    gitAtOk(dir, ['commit', '-q', '-m', 'big blob'], dayIso(0));
    const sha = readCommitted(dir, ['rev-parse', 'HEAD:big.bin']).trim();

    const reader = openBlobReader(dir);
    try {
      const catFileChildIndex = spawnCalls.findIndex((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'cat-file');
      expect(catFileChildIndex).toBeGreaterThanOrEqual(0);
      const catFileChild = spawnedChildren[catFileChildIndex];

      const firstByteArrived = new Promise<void>((resolve) => {
        catFileChild.stdout!.once('data', () => resolve());
      });
      const readPromise = reader.read([sha], () => {
        throw new Error('onBlob must not be called: the response is killed before it completes');
      });
      await firstByteArrived;
      catFileChild.kill('SIGKILL');

      await expect(readPromise).rejects.toThrow(/signal|SIGKILL/i);
    } finally {
      reader.close();
    }
  });
});
