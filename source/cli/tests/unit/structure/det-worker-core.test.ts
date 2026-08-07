/**
 * Unit tests for det-worker-core.ts — the pure body of a deterministic worker
 * task, run IN-PROCESS here (no threads) against real on-disk check.mjs files and
 * a real test graph. Validates the lowering of runStructureAspect's result and
 * thrown errors to the plain-data reply that crosses the worker boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runDetTask,
  createDetWorkerCacheSlot,
  releaseDetWorkerCacheSlot,
} from '../../../src/structure/det-worker-core.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runDetTask', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-det-worker-core-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;\n');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function writeCheck(aspectId: string, body: string): string {
    const dir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), body);
    return dir;
  }

  const graph = () =>
    buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }] });

  it('lowers a clean run to ok:true with the structure result', async () => {
    const dir = writeCheck('a1', 'export function check(ctx) { void ctx; return []; }\n');
    const reply = await runDetTask({ id: 7, aspectDir: dir, aspectId: 'a1', unit: { kind: 'node', nodePath: 'N' } }, graph(), projectRoot);
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result.violations).toHaveLength(0);
      expect(reply.result.succeeded).toBe(true);
    }
  });

  it('carries violations through unchanged', async () => {
    const dir = writeCheck('a2', `export function check(ctx) { void ctx; return [{ message: 'bad', file: 'src/a.ts', line: 1 }]; }\n`);
    const reply = await runDetTask({ id: 1, aspectDir: dir, aspectId: 'a2', unit: { kind: 'node', nodePath: 'N' } }, graph(), projectRoot);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result.violations).toHaveLength(1);
      expect(reply.result.violations[0].message).toBe('bad');
    }
  });

  it('lowers a StructureRunnerError to ok:false with its code + messageData', async () => {
    // An async check is a structural error (STRUCTURE_CHECK_ASYNC) thrown as a
    // StructureRunnerError — the reply must carry the code so the parent can
    // reconstruct the class.
    const dir = writeCheck('a3', 'export async function check(ctx) { void ctx; return []; }\n');
    const reply = await runDetTask({ id: 2, aspectDir: dir, aspectId: 'a3', unit: { kind: 'node', nodePath: 'N' } }, graph(), projectRoot);
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBeDefined();
      expect(reply.error.message).toContain('STRUCTURE_CHECK_ASYNC');
      expect(reply.error.messageData).toBeDefined();
    }
  });

  it('lowers a missing-export validation failure to ok:false with a usable message', async () => {
    const dir = writeCheck('a4', 'export const notCheck = 1;\n');
    const reply = await runDetTask({ id: 3, aspectDir: dir, aspectId: 'a4', unit: { kind: 'node', nodePath: 'N' } }, graph(), projectRoot);
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.message.length).toBeGreaterThan(0);
    }
  });

  it('fails closed with a structural code when the node is unknown', async () => {
    // A nodePath absent from the graph is a structural failure — runStructureAspect
    // wraps it as a StructureRunnerError, so the reply carries the code and the
    // parent can reconstruct the class. (runStructureAspect wraps essentially every
    // failure this way; the bare-message branch is a defensive fallback for a
    // non-StructureRunnerError throw, which no real input reaches — it is marked
    // with a coverage-ignore in det-worker-core.ts.)
    const dir = writeCheck('a5', 'export function check(ctx) { void ctx; return []; }\n');
    const reply = await runDetTask({ id: 4, aspectDir: dir, aspectId: 'a5', unit: { kind: 'node', nodePath: 'does/not/exist' } }, graph(), projectRoot);
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBeDefined();
      expect(reply.error.messageData).toBeDefined();
    }
  });
});

/**
 * The per-worker parse-cache slot. A worker holds the trees for ONE bucket at a
 * time and reuses them across consecutive tasks carrying the same bucket key,
 * which is what stops a rule that judges one file at a time from re-parsing its
 * whole component once per subject. Rotating on a new key is what keeps a
 * worker's tree footprint bounded by its single largest unit rather than growing
 * with every bucket that passes through it.
 */
describe('DetWorkerCacheSlot', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-det-worker-slot-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;\n');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function writeCheck(aspectId: string, body: string): string {
    const dir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), body);
    return dir;
  }
  const graph = (): ReturnType<typeof buildTestGraphForStructure> =>
    buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }] });

  const OK_CHECK = 'export function check(ctx) { void ctx; return []; }\n';

  it('holds one bucket at a time, reusing it for the same key and rotating on a new one', async () => {
    const dir = writeCheck('slot', OK_CHECK);
    const slot = createDetWorkerCacheSlot();
    const task = (id: number, bucketKey?: string): Parameters<typeof runDetTask>[0] =>
      ({ id, aspectDir: dir, aspectId: 'slot', unit: { kind: 'node', nodePath: 'N' }, bucketKey });

    const first = await runDetTask(task(1, 'slot\u0000N'), graph(), projectRoot, slot);
    expect(first.ok).toBe(true);
    const held = slot.cache;
    expect(slot.bucketKey).toBe('slot\u0000N');
    expect(held).toBeDefined();

    // Same bucket ⇒ the SAME cache object, so its parsed trees are reused.
    const second = await runDetTask(task(2, 'slot\u0000N'), graph(), projectRoot, slot);
    expect(second.ok).toBe(true);
    expect(slot.cache).toBe(held);

    // Different bucket ⇒ a fresh cache; the previous one is not kept alongside.
    const third = await runDetTask(task(3, 'other\u0000N'), graph(), projectRoot, slot);
    expect(third.ok).toBe(true);
    expect(slot.bucketKey).toBe('other\u0000N');
    expect(slot.cache).not.toBe(held);

    releaseDetWorkerCacheSlot(slot);
    expect(slot.cache).toBeUndefined();
    expect(slot.bucketKey).toBeUndefined();
  });

  it('holds nothing for a task with no bucket key — the runner then owns its own cache', async () => {
    const dir = writeCheck('nokey', OK_CHECK);
    const slot = createDetWorkerCacheSlot();
    const reply = await runDetTask(
      { id: 1, aspectDir: dir, aspectId: 'nokey', unit: { kind: 'node', nodePath: 'N' } },
      graph(), projectRoot, slot,
    );
    expect(reply.ok).toBe(true);
    expect(slot.cache).toBeUndefined();
  });

  it('produces the same reply with a slot as without one — the slot changes parsing, never a verdict', async () => {
    const dir = writeCheck('parity', 'export function check(ctx) { void ctx; return [{ file: "src/a.ts", line: 1, message: "v" }]; }\n');
    const unit = { kind: 'node' as const, nodePath: 'N' };
    const withoutSlot = await runDetTask({ id: 1, aspectDir: dir, aspectId: 'parity', unit }, graph(), projectRoot);
    const slot = createDetWorkerCacheSlot();
    const withSlot = await runDetTask({ id: 1, aspectDir: dir, aspectId: 'parity', unit, bucketKey: 'parity\u0000N' }, graph(), projectRoot, slot);
    releaseDetWorkerCacheSlot(slot);
    expect(withSlot).toEqual(withoutSlot);
  });

  it('releasing an empty slot is a no-op, so a worker that never ran a task shuts down cleanly', () => {
    const slot = createDetWorkerCacheSlot();
    expect(() => releaseDetWorkerCacheSlot(slot)).not.toThrow();
    expect(slot.cache).toBeUndefined();
  });
});
