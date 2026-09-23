import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../src/core/graph-loader.js';
import { readLock } from '../../src/io/lock-store.js';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';
import {
  computePortalLockHash,
  readGitCommitRef,
  computePortalFreshness,
} from '../../src/portal/engine-api.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

/**
 * Phase-5 backend (5.1 attestation provenance + 5.2 file-aware loop) — real fixtures, real
 * CLI, no mocking.
 *
 * 5.1: the lock hash + git commit ref enter PortalData.meta through the facade. The lock hash
 * is a content fold over the COMMITTED lock triad (it changes when the committed lock changes,
 * is stable across repeated extraction, and excludes the gitignored deterministic cache); the
 * commit ref is read read-only from .git (the real repo HAS one; a non-git dir reports null).
 *
 * 5.2: per-node source freshness. We copy a REAL fixture (a log_required service graph) to a
 * temp dir, establish a closed baseline via the PUBLIC CLI (yg check --approve writes the
 * committed source fingerprint), confirm every node reads not-fresh, then edit a mapped source
 * file and re-extract — that node's source is `changed` and its node reads `unverified`, never
 * green, and an UNTOUCHED node stays clean.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FRESH_FIXTURE = path.resolve(__dirname, '../fixtures/portal-fresh');
const CLI_BIN = path.resolve(__dirname, '../../dist/bin.js');

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, FIXTURE_RM_OPTIONS)));
});

describe('5.1 — attestation provenance enters meta via the facade (real repo)', () => {
  // Every extraction here walks the whole real repository, so the tests share one and only
  // the stability test runs a second, independent one. Three of them overran the per-test
  // budget when the full gate ran this file beside everything else.
  let data: PortalData;
  beforeAll(async () => {
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });
  }, 120_000);

  it('the lock hash folds the committed lock and is stable across extractions', async () => {
    // A non-empty content hash over the committed lock triad.
    expect(data.meta.lockHash).toMatch(/^[0-9a-f]{64}$/);
    // The same facade fold over the same committed lock reproduces the hash (stable).
    const graph = await loadGraph(REPO_ROOT);
    expect(computePortalLockHash(graph)).toBe(data.meta.lockHash);
    // Independent re-extraction reproduces the same hash (nothing time-dependent in it).
    const again = await extractPortalData(REPO_ROOT, { writeEnabled: false });
    expect(again.meta.lockHash).toBe(data.meta.lockHash);
  }, 120_000);

  it('the commit ref is the real git HEAD (the digest pins it)', () => {
    // The real repo is a git repo — a full 40-char sha read read-only from .git.
    expect(data.meta.commitRef).toMatch(/^[0-9a-f]{40}$/);
    // Cross-check against the engine-api reader directly and the git CLI (read-only).
    expect(readGitCommitRef(REPO_ROOT)).toBe(data.meta.commitRef);
    const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (gitHead.status === 0) {
      expect(data.meta.commitRef).toBe((gitHead.stdout ?? '').trim());
    }
  }, 120_000);

  it('a non-git directory reports a null commit ref (no fabrication)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-portal-nogit-'));
    tmpDirs.push(dir);
    // A bare directory (no .git) — the reader returns null rather than inventing a ref.
    expect(readGitCommitRef(dir)).toBeNull();
  });
});

describe('5.2 — file-aware loop: a touched file reads unverified everywhere (real CLI)', () => {
  let baseDir: string;

  beforeAll(async () => {
    // Copy the real fixture to a temp dir and establish a closed baseline through the PUBLIC
    // CLI surface — yg check --approve writes the committed source fingerprint at closure.
    baseDir = await mkdtemp(path.join(tmpdir(), 'yg-portal-fresh-'));
    tmpDirs.push(baseDir);
    await cp(FRESH_FIXTURE, baseDir, { recursive: true });
    const run = spawnSync('node', [CLI_BIN, 'check', '--approve'], { cwd: baseDir, encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 120_000);

  it('with the baseline closed, no node is fresh and the touched node is verified', async () => {
    const data = await extractPortalData(baseDir, { writeEnabled: false });
    const orders = data.nodes.find((n) => n.path === 'api/orders')!;
    const users = data.nodes.find((n) => n.path === 'api/users')!;
    // Both service nodes closed against current bytes → not fresh, verified.
    expect(orders.fresh).toBe(false);
    expect(users.fresh).toBe(false);
    expect(orders.state).toBe('verified');
    expect(users.state).toBe('verified');
  }, 120_000);

  it('after editing a mapped file, ONLY that node is fresh + unverified everywhere; others stay clean', async () => {
    // Edit one mapped source file (a real byte change) — no re-approve.
    const editedFile = path.join(baseDir, 'src/orders/orders.service.ts');
    const original = await readFile(editedFile, 'utf-8');
    await writeFile(editedFile, original + '\n// a manual edit since the last reviewer pass\n', 'utf-8');

    // The facade freshness signal fires for exactly the touched node.
    const graph = await loadGraph(baseDir);
    const lock = readLock(graph.rootPath);
    const freshness = await computePortalFreshness(graph, lock);
    const ordersFresh = freshness.find((f) => f.nodePath === 'api/orders')!;
    const usersFresh = freshness.find((f) => f.nodePath === 'api/users')!;
    expect(ordersFresh.sourceChanged).toBe(true);
    expect(usersFresh.sourceChanged).toBe(false);

    // Re-extract: the touched node reads unverified, the untouched one stays verified, and the
    // whole-repo cached green never overrides the touched file.
    const data = await extractPortalData(baseDir, { writeEnabled: false });
    const orders = data.nodes.find((n) => n.path === 'api/orders')!;
    const users = data.nodes.find((n) => n.path === 'api/users')!;
    expect(orders.fresh).toBe(true);
    expect(orders.state).toBe('unverified');
    expect(orders.state).not.toBe('verified');
    // The rollup over its parent reflects the touched descendant (never falsely green).
    const apiModule = data.nodes.find((n) => n.path === 'api')!;
    expect(apiModule.rollupState).toBe('unverified');
    // The untouched node is undisturbed.
    expect(users.fresh).toBe(false);
    expect(users.state).toBe('verified');
  }, 120_000);
});
