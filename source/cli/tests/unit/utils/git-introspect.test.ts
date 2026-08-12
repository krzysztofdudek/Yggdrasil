import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, rm, writeFile, stat, unlink, mkdir, appendFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  getMergeParents,
  getMergeBase,
  getFileAtRef,
  isMergeCommit,
  changedFilesAgainst,
  parsePorcelainZ,
  parseDiffNameStatusZ,
  isAncestor,
  isShallowRepository,
  getToplevelAndPrefix,
  treesIdentical,
  hasCleanWorktree,
  gitlinkPaths,
} from '../../../src/utils/git-introspect.js';
import { gitFixtureEnv } from '../../support/git-fixture.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupRepoWithMerge(): Promise<{ repo: string; mergeSha: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-git-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  await writeFile(path.join(repo, 'log.md'), 'base\n');
  r('git add -A && git commit -qm base');
  r('git checkout -qb feat1');
  await writeFile(path.join(repo, 'log.md'), 'base\nfeat1 line\n');
  r('git add -A && git commit -qm feat1');
  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(path.join(repo, 'log.md'), 'base\nfeat2 line\n');
  r('git add -A && git commit -qm feat2');
  r('git checkout -q main && git merge --no-commit --no-ff -X ours feat1 -q');
  r('git commit -qm "merge feat1"');
  r('git merge --no-commit --no-ff -X ours feat2 -q || true');
  r('git commit -qm "merge feat2 over feat1" || true');
  const mergeSha = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  return { repo, mergeSha };
}

describe('git-introspect', () => {
  it('isMergeCommit detects merge commit', async () => {
    const { repo } = await setupRepoWithMerge();
    expect(await isMergeCommit(repo, 'HEAD')).toBe(true);
  });

  it('getMergeParents returns two parent SHAs', async () => {
    const { repo } = await setupRepoWithMerge();
    const parents = await getMergeParents(repo, 'HEAD');
    expect(parents).toHaveLength(2);
  });

  it('getMergeBase returns ancestor', async () => {
    const { repo } = await setupRepoWithMerge();
    const parents = await getMergeParents(repo, 'HEAD');
    const base = await getMergeBase(repo, parents[0], parents[1]);
    expect(base.length).toBeGreaterThan(0);
  });

  it('getFileAtRef returns file content', async () => {
    const { repo } = await setupRepoWithMerge();
    const content = await getFileAtRef(repo, 'HEAD', 'log.md');
    expect(content).toBeTypeOf('string');
  });

  it('getFileAtRef returns empty string when file missing at ref', async () => {
    const { repo } = await setupRepoWithMerge();
    const content = await getFileAtRef(repo, 'HEAD', 'nonexistent.txt');
    expect(content).toBe('');
  });

  it('getMergeParents throws on a non-merge ref (single-parent commit)', async () => {
    const { repo } = await setupRepoWithMerge();
    // The 'feat1' branch tip has exactly one parent (the base commit) — not a
    // merge — so the < 3 "ref + parents" token guard must reject it.
    await expect(getMergeParents(repo, 'feat1')).rejects.toThrow(/not a merge commit/);
  });

  it('getFileAtRef rethrows the original error when the path exists at ref but its object is unreadable', async () => {
    // A genuinely corrupted/incomplete object store (e.g. a partial fetch or GC
    // race): the tree still lists the path (`git ls-tree` succeeds, non-empty), but
    // the blob object itself is missing so `git show` fails. This is the "present
    // but unreadable" branch — a real error, never coerced to the documented
    // "absent at ref" empty string.
    const { repo } = await setupRepoWithMerge();
    const blobSha = execSync('git rev-parse HEAD:log.md', { cwd: repo, env: gitFixtureEnv(repo) })
      .toString()
      .trim();
    const objectPath = path.join(repo, '.git', 'objects', blobSha.slice(0, 2), blobSha.slice(2));
    await unlink(objectPath);
    await expect(getFileAtRef(repo, 'HEAD', 'log.md')).rejects.toThrow();
  });

  it('getFileAtRef does NOT execute shell metacharacters in the file path (no injection)', async () => {
    // The file path is built from a caller-supplied node path. With the argv form
    // (execFile, no shell) a metacharacter payload is a literal path git cannot
    // find, not a command to run. A regression to shell exec() would create the
    // sentinel file. This is the A2 injection guard.
    const { repo } = await setupRepoWithMerge();
    const sentinel = path.join(repo, 'INJECTED_PROOF.txt');
    const payload = '$(touch INJECTED_PROOF.txt).md';
    const content = await getFileAtRef(repo, 'HEAD', payload);
    expect(content).toBe('');
    await expect(stat(sentinel)).rejects.toThrow();
  });
});

// =============================================================================
// changedFilesAgainst / parsePorcelainZ / parseDiffNameStatusZ
//
// The touched-set reader unions two independent git views:
//   - `git status --porcelain=v1 -z -uall`  (worktree/index vs. HEAD — uncommitted)
//   - `git diff --name-status -z <mergeBase>..HEAD`  (HEAD vs. the merge-base — committed)
// Each source encodes a rename in a DIFFERENT NUL-record order (porcelain packs
// `R  <to>\0<from>`; diff emits `R<score>\0<from>\0<to>`), so the fixture below
// exercises one rename per source, each with a differing from/to basename, so a
// parser that swapped the two fields would fail loudly rather than silently
// passing on a same-name rename.
// =============================================================================

// Baseline body long enough that a one-line append after a rename still clears
// git's default 50% similarity threshold, so BOTH `git status` and `git diff`
// detect the rename with no --find-renames flag — matching the exact commands
// the implementation runs.
const RENAME_BASE_BODY = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

async function setupTouchedSetRepo(): Promise<{ repo: string; mergeBase: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-touched-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');

  await writeFile(path.join(repo, 'staged-edit.txt'), 'staged base\n');
  await writeFile(path.join(repo, 'unstaged-edit.txt'), 'unstaged base\n');
  await writeFile(path.join(repo, 'deleted.txt'), 'gone soon\n');
  await writeFile(path.join(repo, 'chmod-target.txt'), 'chmod me\n');
  await writeFile(path.join(repo, 'committed-edit.txt'), 'committed base\n');
  await writeFile(path.join(repo, 'committed-rename-alpha.txt'), RENAME_BASE_BODY);
  await writeFile(path.join(repo, 'worktree-rename-gamma.txt'), RENAME_BASE_BODY);
  r('git add -A && git commit -qm base');
  const mergeBase = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();

  // Committed side: one edit + one rename, landing in HEAD so
  // `git diff --name-status -z <mergeBase>..HEAD` reports them. from/to
  // basenames differ (alpha -> beta) to catch a swapped diff parser.
  await writeFile(path.join(repo, 'committed-edit.txt'), 'committed base\ncommitted change\n');
  r('git mv committed-rename-alpha.txt committed-rename-beta.txt');
  await appendFile(path.join(repo, 'committed-rename-beta.txt'), 'renamed on branch\n');
  r('git add -A && git commit -qm "committed edit + rename"');

  // Worktree side: uncommitted state only `git status --porcelain` sees.
  await writeFile(path.join(repo, 'staged-edit.txt'), 'staged base\nstaged change\n');
  r('git add staged-edit.txt');
  await writeFile(path.join(repo, 'unstaged-edit.txt'), 'unstaged base\nunstaged change\n');
  await writeFile(path.join(repo, 'new-top.txt'), 'brand new\n');
  await mkdir(path.join(repo, 'newdir'), { recursive: true });
  await writeFile(path.join(repo, 'newdir', 'nested.txt'), 'nested new\n');
  await unlink(path.join(repo, 'deleted.txt'));
  await chmod(path.join(repo, 'chmod-target.txt'), 0o755);
  r('git add chmod-target.txt');
  // from/to basenames differ (gamma -> delta) to catch a swapped porcelain parser.
  r('git mv worktree-rename-gamma.txt worktree-rename-delta.txt');
  await appendFile(path.join(repo, 'worktree-rename-delta.txt'), 'renamed in worktree\n');
  r('git add worktree-rename-delta.txt');

  return { repo, mergeBase };
}

describe('parsePorcelainZ', () => {
  it('parses ordinary staged/unstaged/untracked/deleted records and a rename (to before from)', () => {
    // Literal NUL-record bytes, matching `git status --porcelain=v1 -z` exactly:
    // ordinary records are "XY <path>"; a rename record is "XY <to>" followed by
    // a SEPARATE raw "<from>" record — no XY prefix on the second one. Includes a
    // backslash in one path to confirm toPosixPath normalization runs.
    const records = [
      'M  staged-edit.txt',
      ' M unstaged-edit.txt',
      '?? untracked.txt',
      '?? nested\\dir\\untracked.txt',
      ' D deleted.txt',
      'R  to-name.txt',
      'from-name.txt',
    ];
    const buf = Buffer.from(records.join('\0') + '\0', 'utf8');

    const result = parsePorcelainZ(buf);

    expect([...result.files].sort()).toEqual(
      [
        'staged-edit.txt',
        'unstaged-edit.txt',
        'untracked.txt',
        'nested/dir/untracked.txt',
        'deleted.txt',
        'to-name.txt',
        'from-name.txt',
      ].sort(),
    );
    expect(result.renames).toEqual([{ from: 'from-name.txt', to: 'to-name.txt' }]);
  });

  it('returns empty files/renames for empty input', () => {
    const result = parsePorcelainZ(Buffer.from('', 'utf8'));
    expect(result.files.size).toBe(0);
    expect(result.renames).toEqual([]);
  });

  it('throws a descriptive (not a bare TypeError) error on a rename record truncated mid-stream', () => {
    // "R  to-name.txt" with NO companion "from" record after it — the NUL
    // stream ends (or is otherwise malformed) exactly where a second record
    // was required. Regression pin for the low-level `TypeError` this used to
    // throw ("Cannot read properties of undefined (reading 'replace')") deep
    // inside `toPosixPath`, which named neither the parser nor what was
    // expected.
    const buf = Buffer.from('R  to-name.txt\0', 'utf8');
    expect(() => parsePorcelainZ(buf)).toThrow(/parsePorcelainZ.*truncated/i);
  });

  it('a real repo with status.renames=copies: a copy record is consumed correctly (both sides in files, no renames entry, no phantom path)', async () => {
    // `status.renames=copies` is a documented, NON-DEFAULT git config value —
    // reachable purely via an adopter's ambient config, no flag of ours
    // involved. Regression fixture for a Critical review finding: before the
    // fix, an unrecognized `C` status fell into the ordinary-record branch,
    // which read the copy's "from" companion record as if it were a bare
    // path — injecting a phantom entry and, on the diff side, desyncing every
    // record after it. Mirrors the review's own real-repo repro exactly:
    // `git -c status.renames=copies status --porcelain=v1 -z -uall` on a
    // file edited AND copied in the same pass produces
    // `M  a.txt\0C  b.txt\0a.txt\0` — confirmed against this environment's
    // git (2.54.0) before writing this assertion.
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-copy-status-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    await writeFile(path.join(repo, 'a.txt'), RENAME_BASE_BODY);
    r('git add -A && git commit -qm base');
    await appendFile(path.join(repo, 'a.txt'), 'line 21 edited\n');
    await copyFile(path.join(repo, 'a.txt'), path.join(repo, 'b.txt'));
    r('git add -A');

    const buf = execSync('git -c status.renames=copies status --porcelain=v1 -z -uall', {
      cwd: repo,
      env: gitFixtureEnv(repo),
    });

    const result = parsePorcelainZ(buf);

    expect([...result.files].sort()).toEqual(['a.txt', 'b.txt']);
    // A copy is not a rename: the source (a.txt) is untouched-but-still-valid,
    // not invalidated, so it must not appear as a `renames` edge.
    expect(result.renames).toEqual([]);
    // No phantom path from mis-slicing the companion "from" record as if it
    // carried its own "XY " status prefix (e.g. the bug's "xt" from
    // "a.txt".slice(3)).
    for (const f of result.files) {
      expect(f).not.toBe('xt');
    }
  });
});

describe('parseDiffNameStatusZ', () => {
  it('parses added/deleted/modified records and a rename (from before to)', () => {
    // Literal NUL-record bytes, matching `git diff --name-status -z` exactly:
    // ordinary records are "<STATUS>" then "<path>"; a rename record is
    // "R<score>" then "<from>" then "<to>" — the OPPOSITE field order from the
    // porcelain rename record above.
    const records = ['A', 'added.txt', 'D', 'deleted.txt', 'M', 'modified.txt', 'R087', 'old-name.txt', 'new-name.txt'];
    const buf = Buffer.from(records.join('\0') + '\0', 'utf8');

    const result = parseDiffNameStatusZ(buf);

    expect([...result.files].sort()).toEqual(
      ['added.txt', 'deleted.txt', 'modified.txt', 'old-name.txt', 'new-name.txt'].sort(),
    );
    expect(result.renames).toEqual([{ from: 'old-name.txt', to: 'new-name.txt' }]);
  });

  it('returns empty files/renames for empty input', () => {
    const result = parseDiffNameStatusZ(Buffer.from('', 'utf8'));
    expect(result.files.size).toBe(0);
    expect(result.renames).toEqual([]);
  });

  it('throws a descriptive (not a bare TypeError) error on an ordinary record truncated mid-stream', () => {
    // A bare status token "A" with NO path record after it.
    const buf = Buffer.from('A\0', 'utf8');
    expect(() => parseDiffNameStatusZ(buf)).toThrow(/parseDiffNameStatusZ.*truncated/i);
  });

  it('throws a descriptive (not a bare TypeError) error on a rename record truncated after only the "from" path', () => {
    const buf = Buffer.from('R087\0old-name.txt\0', 'utf8');
    expect(() => parseDiffNameStatusZ(buf)).toThrow(/parseDiffNameStatusZ.*truncated/i);
  });

  it('a real repo with diff.renames=copies: a copy record does NOT desync the rename record that follows it (both correct, no phantom path, exactly one renames entry)', async () => {
    // `diff.renames=copies` is a documented, NON-DEFAULT git config value —
    // reachable purely via an adopter's ambient config, no flag of ours
    // involved. This is the WORSE half of the Critical review finding: an
    // unrecognized `C` status used to fall into the ordinary-record branch,
    // which consumed only ONE of its two companion records as a bare path —
    // permanently losing the stream's 1-token alignment, so the genuine `R`
    // record immediately after it was misread too (a phantom path built from
    // the score token itself, e.g. "R096"). Mirrors the review's own
    // real-repo repro exactly: one base file renamed AND copied in the same
    // commit produces, with copies enabled,
    // `C100\0source-file.txt\0copied-file.txt\0R100\0source-file.txt\0renamed-file.txt\0`
    // — confirmed against this environment's git (2.54.0) before writing this
    // assertion. The copy record deliberately comes FIRST so a fix that only
    // "worked" for a copy at the end of the stream would still fail here.
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-copy-diff-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    await writeFile(path.join(repo, 'source-file.txt'), RENAME_BASE_BODY);
    r('git add -A && git commit -qm base');
    const mergeBase = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
      .toString()
      .trim();
    r('git mv source-file.txt renamed-file.txt');
    await copyFile(path.join(repo, 'renamed-file.txt'), path.join(repo, 'copied-file.txt'));
    r('git add -A && git commit -qm "rename + copy"');

    const buf = execSync(`git -c diff.renames=copies diff --name-status -z ${mergeBase}..HEAD`, {
      cwd: repo,
      env: gitFixtureEnv(repo),
    });

    const result = parseDiffNameStatusZ(buf);

    expect([...result.files].sort()).toEqual(
      ['copied-file.txt', 'renamed-file.txt', 'source-file.txt'].sort(),
    );
    // Exactly the genuine rename — the copy must NOT also appear as a
    // renames edge (its source persists, unlike a rename's).
    expect(result.renames).toEqual([{ from: 'source-file.txt', to: 'renamed-file.txt' }]);
    // No phantom path built from a misread score/status token.
    for (const f of result.files) {
      expect(f).not.toMatch(/^[RC]\d/);
    }
  });
});

describe('changedFilesAgainst', () => {
  it('unions worktree status and committed diff against a real repo, preserving correct rename order for both sources', async () => {
    const { repo, mergeBase } = await setupTouchedSetRepo();

    const result = await changedFilesAgainst(repo, mergeBase);

    expect(result).not.toBeNull();
    const files = result!.files;
    // Committed side (git diff mergeBase..HEAD).
    expect(files.has('committed-edit.txt')).toBe(true);
    expect(files.has('committed-rename-alpha.txt')).toBe(true);
    expect(files.has('committed-rename-beta.txt')).toBe(true);
    // Worktree side (git status --porcelain -uall).
    expect(files.has('staged-edit.txt')).toBe(true);
    expect(files.has('unstaged-edit.txt')).toBe(true);
    expect(files.has('deleted.txt')).toBe(true);
    expect(files.has('chmod-target.txt')).toBe(true);
    expect(files.has('worktree-rename-gamma.txt')).toBe(true);
    expect(files.has('worktree-rename-delta.txt')).toBe(true);
    // `-uall` must list the untracked file inside the new directory itself,
    // never collapse it to the directory (`?? newdir/`).
    expect(files.has('newdir/nested.txt')).toBe(true);
    expect(files.has('new-top.txt')).toBe(true);

    // Rename order must be correct for BOTH sources — a swapped parser on
    // either side would report the from/to basenames backwards.
    expect(result!.renames).toContainEqual({
      from: 'committed-rename-alpha.txt',
      to: 'committed-rename-beta.txt',
    });
    expect(result!.renames).toContainEqual({
      from: 'worktree-rename-gamma.txt',
      to: 'worktree-rename-delta.txt',
    });
  });

  it('returns null when the merge-base ref does not resolve', async () => {
    const { repo } = await setupTouchedSetRepo();
    const result = await changedFilesAgainst(repo, 'not-a-real-ref-0000');
    expect(result).toBeNull();
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-nogit-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    const result = await changedFilesAgainst(dir, 'HEAD');
    expect(result).toBeNull();
  });
});

// =============================================================================
// isAncestor / isShallowRepository / getToplevelAndPrefix / treesIdentical /
// hasCleanWorktree
//
// Each probe answers a narrow, orthogonal question a later scoping decision
// needs BEFORE trusting a diff between two refs is meaningful at all — and
// each must return null (never throw, never guess) on any git failure. The
// probes are tested against real on-disk temp repos, not mocks, matching the
// rest of this module.
// =============================================================================

async function makeNonGitDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-probe-nogit-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'a.txt'), 'a\n');
  return dir;
}

/**
 * Base commit A (file = "v1"), then commit B changes the file to "v2", then
 * commit C reverts it back to "v1" — a straight-line branch, no divergence.
 * This single fixture proves tree identity and ancestry are independent
 * facts: C's TREE is identical to A's (the revert undid the content
 * change), while ancestry stays ordinary and directional — A really is
 * reachable from C (forward), but C is NOT reachable from A (backward,
 * since A predates C). Neither probe may be inferred from the other.
 */
async function setupRevertRepo(): Promise<{ repo: string; base: string; tip: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-revert-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  await writeFile(path.join(repo, 'file.txt'), 'v1\n');
  r('git add -A && git commit -qm base');
  const base = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  await writeFile(path.join(repo, 'file.txt'), 'v2\n');
  r('git add -A && git commit -qm change');
  await writeFile(path.join(repo, 'file.txt'), 'v1\n');
  r('git add -A && git commit -qm revert');
  const tip = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  return { repo, base, tip };
}

describe('isAncestor', () => {
  it('true when maybeAncestor really precedes ref, false in the reverse direction', async () => {
    const { repo, base, tip } = await setupRevertRepo();
    expect(await isAncestor(repo, base, tip)).toBe(true);
    expect(await isAncestor(repo, tip, base)).toBe(false);
  });

  it('a commit-then-revert branch: trees identical, yet the reverse-direction ancestor check is false (tree identity does not imply ancestry)', async () => {
    const { repo, base, tip } = await setupRevertRepo();
    expect(await treesIdentical(repo, base, tip)).toBe(true);
    expect(await isAncestor(repo, tip, base)).toBe(false);
  });

  it('returns null (not false) when a ref does not resolve — "could not tell" is distinct from "not an ancestor"', async () => {
    const { repo, tip } = await setupRevertRepo();
    const result = await isAncestor(repo, 'not-a-real-ref-0000', tip);
    expect(result).toBeNull();
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    const result = await isAncestor(dir, 'HEAD', 'HEAD');
    expect(result).toBeNull();
  });
});

describe('treesIdentical', () => {
  it('false when the two refs carry different content', async () => {
    const { repo, base } = await setupRevertRepo();
    // base (v1) vs. the intermediate "change" commit (v2): genuinely different trees.
    const changeSha = execSync('git rev-parse HEAD~1', { cwd: repo, env: gitFixtureEnv(repo) })
      .toString()
      .trim();
    expect(await treesIdentical(repo, base, changeSha)).toBe(false);
  });

  it('returns null when a ref does not resolve', async () => {
    const { repo, base } = await setupRevertRepo();
    expect(await treesIdentical(repo, base, 'not-a-real-ref-0000')).toBeNull();
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    expect(await treesIdentical(dir, 'HEAD', 'HEAD')).toBeNull();
  });
});

describe('isShallowRepository', () => {
  it('false for an ordinary full-history repo', async () => {
    const { repo } = await setupRevertRepo();
    expect(await isShallowRepository(repo)).toBe(false);
  });

  it('true for a shallow clone (--depth 1)', async () => {
    const { repo } = await setupRevertRepo();
    const shallow = await mkdtemp(path.join(tmpdir(), 'yg-shallow-'));
    dirs.push(shallow);
    // `git clone` creates its own .git layout at the destination, so (unlike
    // every other fixture op in this file) it must NOT run under a
    // pre-pinned GIT_DIR/GIT_WORK_TREE — those would point clone at a
    // work tree it didn't create and it refuses with "already exists".
    // Still scrub the inherited discovery vars (same isolation concern
    // {@link gitFixtureEnv} exists for) so this clone cannot wander into the
    // real repo through a leaked env.
    const cloneEnv = gitFixtureEnv(shallow);
    delete cloneEnv.GIT_DIR;
    delete cloneEnv.GIT_WORK_TREE;
    execSync(`git clone -q --depth 1 "file://${repo}" "${shallow}"`, {
      stdio: 'pipe',
      env: cloneEnv,
    });
    expect(await isShallowRepository(shallow)).toBe(true);
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    expect(await isShallowRepository(dir)).toBeNull();
  });
});

describe('getToplevelAndPrefix', () => {
  it('empty prefix at the repo root — a legitimate value, not an error', async () => {
    const { repo } = await setupRevertRepo();
    const result = await getToplevelAndPrefix(repo);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('');
    // Resolve both sides through fs.realpath-equivalent comparison isn't
    // needed here: git prints an absolute, symlink-resolved toplevel, so
    // comparing basenames avoids any /tmp vs /private/tmp (or similar)
    // symlink mismatch across platforms while still proving it found the
    // right repo.
    expect(path.basename(result!.toplevel)).toBe(path.basename(repo));
  });

  it('non-empty POSIX prefix when run from a subdirectory', async () => {
    const { repo } = await setupRevertRepo();
    const sub = path.join(repo, 'sub', 'dir');
    await mkdir(sub, { recursive: true });
    const result = await getToplevelAndPrefix(sub);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('sub/dir');
  });

  it('resolves in a repo with no commits at all', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-nocommits-'));
    dirs.push(repo);
    execSync('git init -q -b main', { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    const result = await getToplevelAndPrefix(repo);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('');
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    expect(await getToplevelAndPrefix(dir)).toBeNull();
  });
});

describe('hasCleanWorktree', () => {
  it('true immediately after a commit (nothing staged, unstaged, or untracked)', async () => {
    const { repo } = await setupRevertRepo();
    expect(await hasCleanWorktree(repo)).toBe(true);
  });

  it('true for a repo with no commits and nothing untracked (vacuously clean)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-nocommits-clean-'));
    dirs.push(repo);
    execSync('git init -q -b main', { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    expect(await hasCleanWorktree(repo)).toBe(true);
  });

  it('false when a tracked file has an unstaged edit', async () => {
    const { repo } = await setupRevertRepo();
    await writeFile(path.join(repo, 'file.txt'), 'v1\ndirty\n');
    expect(await hasCleanWorktree(repo)).toBe(false);
  });

  it('false when dirty ONLY because of an untracked file (the -uall case)', async () => {
    const { repo } = await setupRevertRepo();
    await writeFile(path.join(repo, 'untracked-only.txt'), 'new\n');
    expect(await hasCleanWorktree(repo)).toBe(false);
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    expect(await hasCleanWorktree(dir)).toBeNull();
  });
});

/**
 * A repo carrying a REAL submodule gitlink (git mode 160000) without needing a
 * second repository to clone from: `update-index --cacheinfo` writes the index
 * entry directly, which is exactly the on-disk shape `git submodule add`
 * produces. `vendor/sub` is added at the base commit and REMOVED at the tip, so
 * the same fixture proves both halves of the probe — the tip's index no longer
 * knows about it, and only the base tree does.
 */
async function setupGitlinkRepo(): Promise<{ repo: string; base: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-gitlink-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  await writeFile(path.join(repo, 'plain.txt'), 'ordinary\n');
  r('git add -A && git commit -qm base');
  const someSha = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  r(`git update-index --add --cacheinfo 160000,${someSha},vendor/sub`);
  r('git commit -qm "add gitlink"');
  const base = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  r('git rm -q --cached vendor/sub');
  r('git commit -qm "drop gitlink"');
  return { repo, base };
}

describe('gitlinkPaths', () => {
  it('finds a gitlink, and never an ordinary file', async () => {
    const { repo, base } = await setupGitlinkRepo();
    const paths = await gitlinkPaths(repo, base);
    expect(paths).not.toBeNull();
    expect(paths!.has('vendor/sub')).toBe(true);
    expect(paths!.has('plain.txt')).toBe(false);
  });

  it('still finds a gitlink the change DELETED — the current index alone would miss it', async () => {
    const { repo, base } = await setupGitlinkRepo();
    // HEAD no longer carries the entry at all; only the base tree does. A
    // probe that read only `git ls-files` would answer "no gitlinks" for a
    // change whose entire content is the removal of one.
    const indexOnly = execSync('git ls-files --stage', { cwd: repo, env: gitFixtureEnv(repo) }).toString();
    expect(indexOnly).not.toContain('vendor/sub');
    const paths = await gitlinkPaths(repo, base);
    expect(paths!.has('vendor/sub')).toBe(true);
  });

  it('finds a gitlink this change ADDED but never committed — the ref tree alone would miss it', async () => {
    const { repo, base } = await setupRevertRepo();
    const someSha = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
      .toString()
      .trim();
    execSync(`git update-index --add --cacheinfo 160000,${someSha},vendor/new-sub`, {
      cwd: repo,
      stdio: 'pipe',
      env: gitFixtureEnv(repo),
    });
    // `base` predates the entry entirely, so nothing in that tree mentions it —
    // only the staged index does, which is the whole point of reading both.
    const paths = await gitlinkPaths(repo, base);
    expect(paths!.has('vendor/new-sub')).toBe(true);
  });

  it('returns an empty set for a repo with no submodules at all', async () => {
    const { repo, base } = await setupRevertRepo();
    const paths = await gitlinkPaths(repo, base);
    expect(paths).not.toBeNull();
    expect(paths!.size).toBe(0);
  });

  it('returns null when repoCwd is not a git repository', async () => {
    const dir = await makeNonGitDir();
    expect(await gitlinkPaths(dir, 'HEAD')).toBeNull();
  });

  it('returns null when the ref does not resolve', async () => {
    const { repo } = await setupRevertRepo();
    expect(await gitlinkPaths(repo, 'no-such-ref')).toBeNull();
  });
});
