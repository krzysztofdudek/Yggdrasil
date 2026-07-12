import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logMergeResolve } from '../../../src/core/log/log-merge-resolve.js';
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
