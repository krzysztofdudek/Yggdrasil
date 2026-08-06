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

import { runDetTask } from '../../../src/structure/det-worker-core.js';
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
