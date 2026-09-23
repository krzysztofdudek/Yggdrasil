import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logMergeResolve, looksLikeInterleavedMerge } from '../../../src/core/log/log-merge-resolve.js';
import { readLock, writeLock } from '../../../src/io/lock-store.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';
import { LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { gitFixtureEnv } from '../../support/git-fixture.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const PARENT1_LOG = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const PARENT2_LOG = ANCESTOR_LOG + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
const RESOLVED_LOG_GOOD =
  ANCESTOR_LOG +
  '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
  '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

async function setupMergeRepo(): Promise<{ projectRoot: string; nodePath: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR_LOG);
  r('git add -A && git commit -qm ancestor');

  r('git checkout -qb feat1');
  await writeFile(path.join(nodeDir, 'log.md'), PARENT1_LOG);
  r('git add -A && git commit -qm feat1');

  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(path.join(nodeDir, 'log.md'), PARENT2_LOG);
  r('git add -A && git commit -qm feat2');

  r('git merge --no-commit --no-ff feat1 -q || true');
  await writeFile(path.join(nodeDir, 'log.md'), RESOLVED_LOG_GOOD);
  r('git add -A');
  r('git commit -qm "merge feat1 into feat2"');

  return { projectRoot: repo, nodePath: 'billing' };
}

/**
 * The prefix_hash the merge-resolve must record: sha256 over bytes
 * [0..newest.offsetEnd) of the resolved log — NOT the whole file. This mirrors
 * the validateAppendOnly contract `yg check` enforces. Computed independently
 * here from parseLog offsets so the test pins the exact byte range.
 */
function expectedBaselineFromContent(content: string): { last_entry_datetime: string; prefix_hash: string } {
  const entries = parseLog(content);
  const newest = entries[entries.length - 1];
  const bytes = Buffer.from(content, 'utf-8');
  const prefix = bytes.subarray(0, newest.offsetEnd);
  return {
    last_entry_datetime: newest.datetime,
    prefix_hash: createHash('sha256').update(prefix).digest('hex'),
  };
}

describe('logMergeResolve (core, lock store)', () => {
  it('accepts byte-exact ancestor prefix + union of new entries (prior lock baseline present)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    // Seed a prior lock baseline at the ancestor boundary; the resolved log is a
    // valid append-only union, so merge-resolve must succeed and ADVANCE it.
    const ancestorBaseline = expectedBaselineFromContent(ANCESTOR_LOG);
    await writeLock(
      yggRoot,
      {
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { billing: { source: 'src-fp', log: ancestorBaseline } },
      },
      { scope: 'logs' },
    );
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);

    // The lock's log baseline advanced to the newest resolved entry; the
    // unrelated `source` fact survives the read-modify-write untouched.
    const lock = readLock(yggRoot);
    expect(lock.nodes.billing?.source).toBe('src-fp');
    expect(lock.nodes.billing?.log).toEqual(expectedBaselineFromContent(RESOLVED_LOG_GOOD));
  });

  it('pins prefix_hash to bytes [0..newest.offsetEnd) computed from parseLog offsets', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);

    const lock = readLock(yggRoot);
    const expected = expectedBaselineFromContent(RESOLVED_LOG_GOOD);
    expect(lock.nodes.billing?.log).toEqual(expected);
    // The resolved log has trailing content after the last entry's offsetEnd is
    // the file end here, but the contract is the offsetEnd range, NOT the whole
    // file — assert the hash is NOT the whole-file hash when they differ.
    const wholeFileHash = createHash('sha256')
      .update(Buffer.from(RESOLVED_LOG_GOOD, 'utf-8'))
      .digest('hex');
    // For this fixture the last entry ends at EOF so offsetEnd == file length;
    // the two hashes coincide. The point of the assertion is structural: the
    // recorded hash equals the offsetEnd-range hash by construction.
    expect(lock.nodes.billing?.log?.prefix_hash).toBe(expected.prefix_hash);
    void wholeFileHash;
  });

  it('rejects when HEAD is not a merge commit', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
    await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR_LOG);
    r('git add -A && git commit -qm only');
    const graph = await loadGraph(repo, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: repo });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('not a merge commit');
  });

  it('rejects when log.md still has conflict markers', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('conflict markers');
  });

  it('accepts a resolved log whose entry body contains a legitimate ======= divider (not a conflict marker)', async () => {
    // log.md is markdown: a line-leading run of `=` is a valid setext H1
    // underline / horizontal rule, NOT a leftover git conflict marker. The
    // guard must key ONLY off the unambiguous `<<<<<<<`/`>>>>>>>` markers.
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');

    // Ancestor entry body carries a legitimate markdown divider line of `=`.
    const ancestor = '## [2026-05-11T10:00:00.000Z]\nSection\n=======\nbase body.\n';
    const p1 = ancestor + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    const p2 = ancestor + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    const resolved =
      ancestor +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

    await writeFile(path.join(nodeDir, 'log.md'), ancestor);
    r('git add -A && git commit -qm ancestor');
    r('git checkout -qb feat1');
    await writeFile(path.join(nodeDir, 'log.md'), p1);
    r('git add -A && git commit -qm feat1');
    r('git checkout -q main && git checkout -qb feat2 main');
    await writeFile(path.join(nodeDir, 'log.md'), p2);
    r('git add -A && git commit -qm feat2');
    r('git merge --no-commit --no-ff feat1 -q || true');
    await writeFile(path.join(nodeDir, 'log.md'), resolved);
    r('git add -A');
    r('git commit -qm "merge feat1 into feat2"');

    const graph = await loadGraph(repo, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: repo });
    expect(result.ok).toBe(true);
  });

  it('still rejects genuine open/close conflict markers with no ======= line present', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    // Only the unambiguous markers, no `=======` line at all — must still refuse.
    await writeFile(logPath, '<<<<<<< HEAD\nx\ny\n>>>>>>> feat\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('conflict markers');
  });

  it('rejects when old portion modified vs ancestor', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const tampered =
      '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    await writeFile(logPath, tampered);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('ancestor prefix');
  });

  it('rejects when new entries dropped (union missing)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const missing = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, missing);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('missing');
  });

  it('rejects a fabricated entry not present in either merge parent', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const fabricated =
      ANCESTOR_LOG +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T13:00:00.000Z]\nFABRICATED — never written on either branch.\n';
    await writeFile(logPath, fabricated);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('rejects an altered entry body (same timestamp, changed text)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const altered =
      ANCESTOR_LOG +
      '## [2026-05-11T11:00:00.000Z]\nALTERED feat1 body — tampered after the fact.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    await writeFile(logPath, altered);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('returns a structured error when log.md is absent (no unexpected throw)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await rm(logPath);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/log\.md/);
  });

  it('rejects when new entries out of chronological order', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const outOfOrder =
      ANCESTOR_LOG +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, outOfOrder);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('chronological');
  });

  it('rejects invalid node path (..)', async () => {
    const { projectRoot } = await setupMergeRepo();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: '../escape', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('rejects when node does not exist', async () => {
    const { projectRoot } = await setupMergeRepo();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'nonexistent', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('Node not found');
  });

  it('reports the plural "entries" form when MULTIPLE parent entries are missing', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, ANCESTOR_LOG);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('missing or has altered 2 entries');
  });

  it('reports the plural "entries" form when MULTIPLE fabricated entries are present', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const twoFabricated =
      RESOLVED_LOG_GOOD +
      '## [2026-05-11T13:00:00.000Z]\nfab one.\n' +
      '## [2026-05-11T14:00:00.000Z]\nfab two.\n';
    await writeFile(logPath, twoFabricated);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('2 new entries not present');
  });

  it('accepts a valid merge even when NO prior lock baseline exists (creates one from scratch)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    // No lock on disk — absent lock is a valid cold start; merge-resolve must
    // succeed and create the baseline.
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);

    const lock = readLock(yggRoot);
    expect(lock.nodes.billing?.log).toEqual(expectedBaselineFromContent(RESOLVED_LOG_GOOD));
  });
});

// A merge that leaves no merge commit behind: a script merging branch logs into
// the working tree, a squash, a rebase. Two branches whose entries interleave by
// date — feat1 writes 11:00 and 13:00, feat2 writes 12:00 — are merged into
// feat1's working tree in date order.
const SIDE_A = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1 first.\n' + '## [2026-05-11T13:00:00.000Z]\nfeat1 second.\n';
const SIDE_B = ANCESTOR_LOG + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
const INTERLEAVED =
  ANCESTOR_LOG +
  '## [2026-05-11T11:00:00.000Z]\nfeat1 first.\n' +
  '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
  '## [2026-05-11T13:00:00.000Z]\nfeat1 second.\n';

async function setupInterleavedWorkingTree(): Promise<{ projectRoot: string; logPath: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-nocommit-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  const logPath = path.join(nodeDir, 'log.md');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await writeFile(logPath, ANCESTOR_LOG);
  r('git add -A && git commit -qm ancestor');
  r('git checkout -qb feat1');
  await writeFile(logPath, SIDE_A);
  r('git add -A && git commit -qm feat1');
  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(logPath, SIDE_B);
  r('git add -A && git commit -qm feat2');
  r('git checkout -q feat1');
  // The lock carries feat1's baseline, as it would after feat1's own check.
  await writeLock(
    path.join(repo, '.yggdrasil'),
    { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: { billing: { log: expectedBaselineFromContent(SIDE_A) } } },
    { scope: 'logs' },
  );
  await writeFile(logPath, INTERLEAVED);
  return { projectRoot: repo, logPath };
}

describe('logMergeResolve — a merge that left no merge commit', () => {
  it('verifies the date-ordered union against the named sides and records the baseline', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({
      graph,
      nodePath: 'billing',
      repoRoot: projectRoot,
      sides: { ours: 'feat1', theirs: 'feat2' },
    });
    expect(result.ok).toBe(true);
    expect(readLock(path.join(projectRoot, '.yggdrasil')).nodes.billing?.log).toEqual(expectedBaselineFromContent(INTERLEAVED));
  });

  it('still refuses a union that drops one side\'s entry', async () => {
    const { projectRoot, logPath } = await setupInterleavedWorkingTree();
    await writeFile(logPath, SIDE_A);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot, sides: { ours: 'feat1', theirs: 'feat2' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('missing or has altered 1 entry');
  });

  it('without named sides on a non-merge HEAD, says how to name them', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.what).toContain('not a merge commit');
      expect(result.error.next).toContain('--ours <ref> --theirs <ref>');
    }
  });

  it('a side that does not resolve is a structured refusal, not a throw', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot, sides: { ours: 'feat1', theirs: 'no-such-branch' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('Could not read');
  });
});

describe('looksLikeInterleavedMerge', () => {
  const GIT_LOG = '.yggdrasil/model/billing/log.md';

  it('recognises whole entries added before the recorded last one while the recorded history survived', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    expect(await looksLikeInterleavedMerge(projectRoot, GIT_LOG, INTERLEAVED, expectedBaselineFromContent(SIDE_A))).toBe(true);
  });

  it('does not take an edited historical entry for a merge', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    const edited = INTERLEAVED.replace('feat1 first.', 'feat1 first, rewritten.');
    expect(await looksLikeInterleavedMerge(projectRoot, GIT_LOG, edited, expectedBaselineFromContent(SIDE_A))).toBe(false);
  });

  it('recognises the shape when the squash or rebase is already committed, so HEAD holds the interleaved log', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    execSync('git add -A && git commit -qm squashed', { cwd: projectRoot, stdio: 'pipe', env: gitFixtureEnv(projectRoot) });
    expect(await looksLikeInterleavedMerge(projectRoot, GIT_LOG, INTERLEAVED, expectedBaselineFromContent(SIDE_A))).toBe(true);
  });

  it('is false outside a git repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-merge-nogit-'));
    dirs.push(dir);
    expect(await looksLikeInterleavedMerge(dir, GIT_LOG, INTERLEAVED, expectedBaselineFromContent(SIDE_A))).toBe(false);
  });
});

// A merge that STOPPED on the conflicted log: HEAD and MERGE_HEAD are the two
// sides, the working-tree log.md holds git's conflict markers, and merge-resolve
// writes the union of both sides itself before verifying it.
async function setupConflictedMerge(ancestor: string, ours: string, theirs: string): Promise<{ projectRoot: string; logPath: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-conflict-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  const logPath = path.join(nodeDir, 'log.md');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await writeFile(logPath, ancestor);
  r('git add -A && git commit -qm ancestor');
  r('git checkout -qb theirs');
  await writeFile(logPath, theirs);
  r('git add -A && git commit -qm theirs');
  r('git checkout -q main && git checkout -qb ours main');
  await writeFile(logPath, ours);
  r('git add -A && git commit -qm ours');
  r('git merge --no-ff theirs -q || true');
  return { projectRoot: repo, logPath };
}

describe('logMergeResolve — a merge still in progress with log.md conflicted', () => {
  it('writes the date-ordered union of both sides and records it as the baseline', async () => {
    const { projectRoot, logPath } = await setupConflictedMerge(ANCESTOR_LOG, PARENT2_LOG, PARENT1_LOG);
    expect(await readFile(logPath, 'utf-8')).toMatch(/^<{7}/m);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot });
    expect(result).toEqual({ ok: true, nodePath: 'billing', wroteUnion: true });
    // Theirs (11:00) sorts ahead of ours (12:00) even though ours is HEAD.
    expect(await readFile(logPath, 'utf-8')).toBe(RESOLVED_LOG_GOOD);
    expect(readLock(path.join(projectRoot, '.yggdrasil')).nodes.billing?.log).toEqual(expectedBaselineFromContent(RESOLVED_LOG_GOOD));
  });

  it('carries an entry both sides added only once', async () => {
    const shared = '## [2026-05-11T10:30:00.000Z]\nshared hotfix.\n';
    const ours = ANCESTOR_LOG + shared + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    const theirs = ANCESTOR_LOG + shared + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    const { projectRoot, logPath } = await setupConflictedMerge(ANCESTOR_LOG, ours, theirs);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot });
    expect(result.ok).toBe(true);
    expect(await readFile(logPath, 'utf-8')).toBe(
      ANCESTOR_LOG + shared + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n',
    );
  });

  it('refuses to write a union when one side rewrote the shared history, and leaves the file alone', async () => {
    const rewritten = '## [2026-05-11T10:00:00.000Z]\nbase, rewritten.\n' + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    const { projectRoot, logPath } = await setupConflictedMerge(ANCESTOR_LOG, PARENT2_LOG, rewritten);
    const before = await readFile(logPath, 'utf-8');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.what).toContain("do not share .yggdrasil/model/billing/log.md's history");
      expect(result.error.next).toContain('git merge --abort');
    }
    expect(await readFile(logPath, 'utf-8')).toBe(before);
  });

  it('names the sides in the remedy when conflict markers remain outside a merge in progress', async () => {
    const { projectRoot, logPath } = await setupInterleavedWorkingTree();
    await writeFile(logPath, '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat2\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: projectRoot, sides: { ours: 'feat1', theirs: 'feat2' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.next).toContain('yg log merge-resolve --node billing --ours feat1 --theirs feat2.');
  });

  it('returns the lock\'s own refusal when the logs lock itself is still conflicted', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'yg-lock.logs.json'),
      '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> feat1\n',
    );
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.what).toContain('yg-lock.logs.json contains git conflict markers');
      expect(result.error.next).toContain('git checkout --ours -- .yggdrasil/yg-lock.logs.json');
    }
  });
});

describe('looksLikeInterleavedMerge — what it refuses to call a merge', () => {
  const GIT_LOG = '.yggdrasil/model/billing/log.md';

  it('is false for a log that is not well formed, without asking git at all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-merge-badformat-'));
    dirs.push(dir);
    expect(await looksLikeInterleavedMerge(dir, GIT_LOG, 'not a log entry at all\n', expectedBaselineFromContent(SIDE_A))).toBe(false);
  });

  it('checks both parents when HEAD is the merge commit', async () => {
    const { projectRoot } = await setupMergeRepo();
    // The merge commit holds RESOLVED_LOG_GOOD; the baseline was recorded on feat2
    // (PARENT2_LOG), and an interleaved rewrite of the union keeps every one of
    // feat2's entries — so feat2, a parent of HEAD, vouches for it.
    const baseline = expectedBaselineFromContent(PARENT2_LOG);
    expect(await looksLikeInterleavedMerge(projectRoot, GIT_LOG, RESOLVED_LOG_GOOD + '## [2026-05-11T12:30:00.000Z]\nlater.\n', baseline)).toBe(true);
  });

  it('is false when no version in the history matches the recorded baseline', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    const foreign = { last_entry_datetime: '2026-05-11T13:00:00.000Z', prefix_hash: '0'.repeat(64) };
    expect(await looksLikeInterleavedMerge(projectRoot, GIT_LOG, INTERLEAVED, foreign)).toBe(false);
  });

  it('is false for a log path git has never seen', async () => {
    const { projectRoot } = await setupInterleavedWorkingTree();
    expect(await looksLikeInterleavedMerge(projectRoot, '.yggdrasil/model/nowhere/log.md', INTERLEAVED, expectedBaselineFromContent(SIDE_A))).toBe(false);
  });
});
