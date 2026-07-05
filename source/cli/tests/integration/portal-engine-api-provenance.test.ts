import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import {
  readGitCommitRef,
  computePortalLockHash,
  computePortalFreshness,
} from '../../src/portal/engine-api.js';
import type { LockFile } from '../../src/model/lock.js';

/**
 * Branch coverage for the Phase-5 facade provenance + freshness readers, against REAL on-disk
 * `.git` layouts and a REAL fixture graph (no mocking). The git-ref reader is a pure read over a
 * real `.git` directory we build on disk — every resolution path (detached HEAD / loose ref /
 * packed-refs / non-git / malformed / dangling ref) is exercised by a real directory shape. The
 * freshness reader is driven against the real portal-basic graph with a hand-built lock that
 * pins the baseline branches (no committed baseline, a stale baseline, a mapping-less baseline).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC_FIXTURE = path.resolve(__dirname, '../fixtures/portal-basic');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('readGitCommitRef — every .git resolution path (real on-disk layouts)', () => {
  it('reads a detached HEAD (the sha held directly in HEAD)', () => {
    const root = tmp('yg-git-detached-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), SHA + '\n');
    expect(readGitCommitRef(root)).toBe(SHA);
  });

  it('follows a symbolic HEAD to a loose ref file', () => {
    const root = tmp('yg-git-loose-');
    mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), SHA2 + '\n');
    expect(readGitCommitRef(root)).toBe(SHA2);
  });

  it('falls back to packed-refs when the loose ref is absent', () => {
    const root = tmp('yg-git-packed-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      path.join(root, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n${SHA2} refs/heads/other\n`,
    );
    expect(readGitCommitRef(root)).toBe(SHA);
  });

  it('returns null for a non-git directory (no fabrication)', () => {
    const root = tmp('yg-git-none-');
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('returns null for a malformed HEAD (neither a sha nor a ref:)', () => {
    const root = tmp('yg-git-bad-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'garbage not a ref\n');
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('returns null for a symbolic HEAD whose ref resolves nowhere (no loose, no packed match)', () => {
    const root = tmp('yg-git-dangling-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    // A packed-refs that does NOT list the wanted ref — the reader exhausts it and returns null.
    writeFileSync(path.join(root, '.git', 'packed-refs'), `${SHA} refs/heads/elsewhere\n`);
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('resolves a LINKED WORKTREE — `.git` is a `gitdir:` pointer FILE, HEAD is private, refs are shared via `commondir`', () => {
    // Real git worktree layout: <mainRepo>/.git is the real dir; the worktree's own <root>/.git
    // is a one-line pointer file to <mainRepo>/.git/worktrees/<name>/, which holds its OWN HEAD
    // (can differ from the main checkout's branch) plus a `commondir` pointing back to
    // <mainRepo>/.git for the refs/heads and packed-refs the worktree shares with the main repo.
    const mainRepo = tmp('yg-git-wt-main-');
    const worktreeRoot = tmp('yg-git-wt-linked-');
    const privateGitDir = path.join(mainRepo, '.git', 'worktrees', 'feature-x');
    mkdirSync(path.join(mainRepo, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(privateGitDir, { recursive: true });
    writeFileSync(path.join(mainRepo, '.git', 'refs', 'heads', 'feature-x'), SHA + '\n');
    writeFileSync(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n');
    writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    expect(readGitCommitRef(worktreeRoot)).toBe(SHA);
  });

  it('a linked worktree falls back to the main repo\'s packed-refs via `commondir`', () => {
    const mainRepo = tmp('yg-git-wt-main-packed-');
    const worktreeRoot = tmp('yg-git-wt-linked-packed-');
    const privateGitDir = path.join(mainRepo, '.git', 'worktrees', 'feature-y');
    mkdirSync(path.join(mainRepo, '.git'), { recursive: true });
    mkdirSync(privateGitDir, { recursive: true });
    writeFileSync(path.join(mainRepo, '.git', 'packed-refs'), `${SHA2} refs/heads/feature-y\n`);
    writeFileSync(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature-y\n');
    writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    expect(readGitCommitRef(worktreeRoot)).toBe(SHA2);
  });

  it('returns null for a malformed `.git` pointer file (no `gitdir:` line)', () => {
    const root = tmp('yg-git-bad-pointer-');
    writeFileSync(path.join(root, '.git'), 'not a gitdir pointer\n');
    expect(readGitCommitRef(root)).toBeNull();
  });
});

describe('computePortalLockHash — committed-lock content fold', () => {
  it('hashes the committed lock on the real repo-basic-like fixture, stable across calls', async () => {
    // A temp copy with a committed lock written by hand (real bytes on disk).
    const root = tmp('yg-lockhash-');
    cpSync(BASIC_FIXTURE, root, { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-lock.nondeterministic.json'),
      JSON.stringify({ version: 1, verdicts: {}, nodes: {} }),
    );
    const graph = await loadGraph(root);
    const h1 = computePortalLockHash(graph);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computePortalLockHash(graph)).toBe(h1); // stable
  });

  it("returns '' when no committed lock exists (greenfield)", async () => {
    const root = tmp('yg-lockhash-empty-');
    cpSync(BASIC_FIXTURE, root, { recursive: true });
    const graph = await loadGraph(root);
    // portal-basic ships no committed lock files → empty hash, never fabricated.
    expect(computePortalLockHash(graph)).toBe('');
  });
});

describe('computePortalFreshness — the baseline branches (real graph)', () => {
  it('reports not-changed for nodes with NO committed baseline (the common case)', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    const emptyLock: LockFile = { version: 1, verdicts: {}, nodes: {} };
    const fresh = await computePortalFreshness(graph, emptyLock);
    // Every node has no baseline → none reported changed (never over-fires).
    expect(fresh.every((f) => f.sourceChanged === false)).toBe(true);
    expect(fresh.some((f) => f.nodePath === 'api/orders')).toBe(true);
  });

  it('reports changed when a stored baseline differs from the live fingerprint', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    // A baseline that cannot match the real current bytes (a deliberately wrong fingerprint).
    const lock: LockFile = {
      version: 1,
      verdicts: {},
      nodes: { 'api/orders': { source: 'deadbeef-not-the-real-fingerprint' } },
    };
    const fresh = await computePortalFreshness(graph, lock);
    const orders = fresh.find((f) => f.nodePath === 'api/orders')!;
    expect(orders.sourceChanged).toBe(true);
    // A sibling with no baseline stays not-changed.
    const users = fresh.find((f) => f.nodePath === 'api/users')!;
    expect(users.sourceChanged).toBe(false);
  });

  it('a mapping-less node with a stored baseline is never marked changed (undefined fingerprint)', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    // The 'api' module node has no mapping → an undefined fingerprint. Even with a stale stored
    // baseline it can never be "fresh" (no source to be stale about).
    const lock: LockFile = {
      version: 1,
      verdicts: {},
      nodes: { api: { source: 'stale-baseline-on-a-mappingless-node' } },
    };
    const fresh = await computePortalFreshness(graph, lock);
    const apiNode = fresh.find((f) => f.nodePath === 'api')!;
    expect(apiNode.sourceChanged).toBe(false);
  });
});
