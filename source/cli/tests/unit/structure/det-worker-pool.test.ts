/**
 * Integration tests for det-worker-pool.ts — spawns REAL worker_threads running
 * the built dist/det-worker.js bundle against a real test graph + real on-disk
 * check.mjs files. No mocking. Validates that a deterministic check produces the
 * SAME result in a worker as in-process (parity), that failures fail closed, that
 * a crashing worker is replaced, and that destroy tears the pool down.
 *
 * These tests require the built worker bundle (dist/det-worker.js). repo-check
 * builds before it tests; for a bare `vitest run`, build first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DetWorkerPool } from '../../../src/structure/det-worker-pool.js';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('DetWorkerPool', () => {
  let projectRoot: string;
  const pools: DetWorkerPool[] = [];

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-det-pool-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;\n');
  });
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.destroy();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeCheck(aspectId: string, body: string): string {
    const dir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), body);
    return dir;
  }
  const graph = () =>
    buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }] });
  function newPool(size: number): DetWorkerPool {
    const p = new DetWorkerPool(graph(), projectRoot, size);
    pools.push(p);
    return p;
  }

  it('spawns the requested number of workers', () => {
    const pool = newPool(3);
    expect(pool.workerCount).toBe(3);
  });

  it('runs a check on a worker and matches the in-process result exactly', async () => {
    const dir = writeCheck('a1', `export function check(ctx) { void ctx; return [{ message: 'bad', file: 'src/a.ts', line: 1 }]; }\n`);
    const task = { aspectDir: dir, aspectId: 'a1', nodePath: 'N' };
    const pool = newPool(2);
    const reply = await pool.run(task);
    expect(reply.ok).toBe(true);
    // Parity: the same params run in-process must yield the same verdict-bearing data.
    const local = await runStructureAspect({ ...task, graph: graph(), projectRoot });
    if (reply.ok) {
      expect(reply.result.violations).toEqual(local.violations);
      expect(reply.result.observations).toEqual(local.observations);
      expect(reply.result.succeeded).toEqual(local.succeeded);
    }
  });

  it('runs many tasks concurrently and returns a reply for each', async () => {
    const dir = writeCheck('a2', 'export function check(ctx) { void ctx; return []; }\n');
    const pool = newPool(3);
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => pool.run({ aspectDir: dir, aspectId: 'a2', nodePath: 'N' })),
    );
    expect(replies).toHaveLength(12);
    expect(replies.every((r) => r.ok)).toBe(true);
    // Correlation ids are unique across the batch.
    expect(new Set(replies.map((r) => r.id)).size).toBe(12);
  });

  it('fails closed when the check errors (ok:false, not a throw)', async () => {
    const dir = writeCheck('a3', 'export async function check(ctx) { void ctx; return []; }\n');
    const pool = newPool(1);
    const reply = await pool.run({ aspectDir: dir, aspectId: 'a3', nodePath: 'N' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.message).toContain('STRUCTURE_CHECK_ASYNC');
  });

  it('replaces a worker that crashes mid-task and keeps serving', async () => {
    // A check that kills its own thread. The pool must resolve the task as a
    // failure (fail closed) and respawn so later work still runs.
    const crashDir = writeCheck('crash', 'export function check(ctx) { void ctx; process.exit(1); }\n');
    const okDir = writeCheck('ok', 'export function check(ctx) { void ctx; return []; }\n');
    const pool = newPool(1);
    const crashed = await pool.run({ aspectDir: crashDir, aspectId: 'crash', nodePath: 'N' });
    expect(crashed.ok).toBe(false);
    if (!crashed.ok) expect(crashed.error.message).toContain('exited');
    expect(pool.workerCount).toBe(1); // respawned
    // The replacement worker serves the next task normally.
    const after = await pool.run({ aspectDir: okDir, aspectId: 'ok', nodePath: 'N' });
    expect(after.ok).toBe(true);
  });

  it('returns an error reply when run after destroy', async () => {
    const pool = newPool(1);
    await pool.destroy();
    const reply = await pool.run({ aspectDir: path.join(projectRoot, '.yggdrasil/aspects/x'), aspectId: 'x', nodePath: 'N' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.message).toContain('destroyed');
    expect(pool.workerCount).toBe(0);
  });

  it('destroy is idempotent', async () => {
    const pool = newPool(2);
    await pool.destroy();
    await expect(pool.destroy()).resolves.toBeUndefined();
  });
});
