import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode, commitApproval } from '../../src/core/approve.js';
import { writeNodeDriftState } from '../../src/io/drift-state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../fixtures/sample-project');

// ── Helpers ──────────────────────────────────────────────────

async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-approve-pipeline-'));
  await cp(FIXTURE_PROJECT, root, { recursive: true });
  return root;
}

/** Remove drift state for a specific node so the next approve is treated as "initial" */
async function clearNodeDriftState(root: string, nodePath: string): Promise<void> {
  const stateFile = path.join(root, '.yggdrasil', '.drift-state', `${nodePath}.json`);
  await rm(stateFile, { force: true });
}

async function touchFile(absPath: string, content?: string): Promise<void> {
  const existing = await readFile(absPath, 'utf-8').catch(() => '');
  await writeFile(absPath, content ?? existing + '\n// touched');
}

// ── Tests ────────────────────────────────────────────────────

describe('approve-pipeline', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const p of cleanupPaths.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });

  it('full lifecycle: initial → modify → approve → no-change', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const nodePath = 'orders/order-service';

    // Clear existing fixture drift state so this starts as a fresh node
    await clearNodeDriftState(root, nodePath);

    const graph = await loadGraph(root);

    const yggRoot = path.join(root, '.yggdrasil');

    // Step 1: First approve — no baseline yet → initial
    const init = await approveNode(graph, nodePath);
    expect(init.action).toBe('initial');
    expect(init.previousHash).toBeUndefined();
    expect(init.currentHash).toBeTruthy();
    expect(init.currentHash.length).toBeGreaterThan(8);
    await commitApproval(yggRoot, init);

    // Step 2: No changes → no-change
    const graph2 = await loadGraph(root);
    const noChange = await approveNode(graph2, nodePath);
    expect(noChange.action).toBe('no-change');
    expect(noChange.previousHash).toBe(init.currentHash);
    expect(noChange.currentHash).toBe(init.currentHash);

    // Step 3: Modify source → approved (binary model: any change → approved)
    const srcFile = path.join(root, 'src', 'orders', 'order.service.ts');
    await touchFile(srcFile);
    const graph3 = await loadGraph(root);
    const approved = await approveNode(graph3, nodePath);
    expect(approved.action).toBe('approved');
    expect(approved.changedSource).toBeDefined();
    expect(approved.changedSource!.length).toBeGreaterThan(0);
    expect(approved.previousHash).toBe(init.currentHash);
    expect(approved.currentHash).not.toBe(init.currentHash);
    await commitApproval(yggRoot, approved);

    // Step 4: No more changes → no-change
    const graph4 = await loadGraph(root);
    const stable = await approveNode(graph4, nodePath);
    expect(stable.action).toBe('no-change');
    expect(stable.currentHash).toBe(approved.currentHash);
  });

  it('source-only change → approved in binary model', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    const nodePath = 'orders/order-service';

    const yggRoot = path.join(root, '.yggdrasil');

    // Establish baseline
    const baseline = await approveNode(graph, nodePath);
    await commitApproval(yggRoot, baseline);

    // Modify source only → approved (binary model)
    const srcFile = path.join(root, 'src', 'orders', 'order.service.ts');
    await touchFile(srcFile);

    const graph2 = await loadGraph(root);
    const approved = await approveNode(graph2, nodePath);
    expect(approved.action).toBe('approved');
    expect(approved.changedSource!.length).toBeGreaterThan(0);
    await commitApproval(yggRoot, approved);

    // After approve, next run → no-change
    const graph3 = await loadGraph(root);
    const noChange = await approveNode(graph3, nodePath);
    expect(noChange.action).toBe('no-change');
  });

  it('compound drift: source + aspect cascade → one approve clears all', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const nodePath = 'auth/auth-api';
    await clearNodeDriftState(root, nodePath);

    const yggRoot = path.join(root, '.yggdrasil');
    const graph = await loadGraph(root);
    const init = await approveNode(graph, nodePath);
    expect(init.action).toBe('initial');
    await commitApproval(yggRoot, init);

    // Modify source + aspect file
    const srcFile = path.join(root, 'src', 'auth', 'auth.controller.ts');
    const aspectFile = path.join(root, '.yggdrasil', 'aspects', 'requires-logging', 'content.md');
    await touchFile(srcFile);
    await touchFile(aspectFile);

    // Binary model: any change → approved
    const graph2 = await loadGraph(root);
    const approved = await approveNode(graph2, nodePath);
    expect(approved.action).toBe('approved');
    await commitApproval(yggRoot, approved);

    // All drift cleared
    const graph3 = await loadGraph(root);
    const noChange = await approveNode(graph3, nodePath);
    expect(noChange.action).toBe('no-change');
  });

  it('initial approve on node with no mapping throws', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    // 'orders' parent module has no mapping.paths
    await expect(approveNode(graph, 'orders')).rejects.toThrow(
      /no mapping/,
    );
  });

  it('approve on nonexistent node throws', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    await expect(approveNode(graph, 'does/not/exist')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('commitApproval is no-op when no pending drift state', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);
    const yggRoot = path.join(root, '.yggdrasil');

    // No pendingDriftState — should be a no-op
    await commitApproval(yggRoot, {
      action: 'no-change',
      currentHash: 'abc',
    });
  });

  it('GC removes orphaned drift state entries during approve', async () => {
    const root = await setupProject();
    cleanupPaths.push(root);

    const yggRoot = path.join(root, '.yggdrasil');

    // Write a drift state entry for a nonexistent node (ghost)
    // Uses writeNodeDriftState which writes to .drift-state/<nodePath>.json
    await writeNodeDriftState(yggRoot, 'ghost/nonexistent-node', {
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      files: {},
    });

    const graph = await loadGraph(root);
    const result = await approveNode(graph, 'orders/order-service');

    // GC should have removed the ghost entry and returned its node path
    expect(result.gcPaths).toBeDefined();
    expect(result.gcPaths!.some((p) => p.includes('ghost') || p.includes('nonexistent'))).toBe(
      true,
    );
  });

});
