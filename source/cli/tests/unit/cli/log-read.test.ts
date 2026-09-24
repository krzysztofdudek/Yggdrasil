import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logRead } from '../../../src/core/log/log-read.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupNode(
  name: string,
  logContent?: string,
): Promise<{ projectRoot: string; nodePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-logread-'));
  dirs.push(root);
  const nodeDir = path.join(root, '.yggdrasil', 'model', name);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), `name: ${name}\ntype: module\ndescription: x\n`);
  if (logContent !== undefined) {
    await writeFile(path.join(nodeDir, 'log.md'), logContent);
  }
  return { projectRoot: root, nodePath: name };
}

describe('logRead (core)', () => {
  it('returns empty entries when log file missing', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(0);
  });

  it('default --top is 10', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(10);
  });

  it('--top 3 returns 3 newest first', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath, top: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].body).toContain('entry 4');
      expect(result.entries[2].body).toContain('entry 2');
    }
  });

  it('--all returns all entries', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath, all: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(15);
  });

  it('rejects --top with --all', async () => {
    const { projectRoot, nodePath } = await setupNode('billing', '## [2026-05-11T14:23:00.000Z]\nx\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath, top: 5, all: true });
    expect(result.ok).toBe(false);
  });

  it('--top N > total returns all', async () => {
    const entries = '## [2026-05-11T14:23:00.000Z]\nonly.\n';
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath, top: 99 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
  });

  it('rejects --top 0', async () => {
    const { projectRoot, nodePath } = await setupNode('billing', '## [2026-05-11T14:23:00.000Z]\nx\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const r0 = await logRead({ graph, nodePath, top: 0 });
    expect(r0.ok).toBe(false);
    const rn = await logRead({ graph, nodePath, top: -3 });
    expect(rn.ok).toBe(false);
  });

  it('returns error on format violation', async () => {
    const bad = 'garbage\n## [bad]\ncontent\n';
    const { projectRoot, nodePath } = await setupNode('billing', bad);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath, top: 10 });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid node path (..)', async () => {
    const { projectRoot } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath: '../escape' });
    expect(result.ok).toBe(false);
  });

  it('rejects when node does not exist', async () => {
    const { projectRoot } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logRead({ graph, nodePath: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('is not in the graph');
  });
});
