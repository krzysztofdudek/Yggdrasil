/**
 * Concurrent log writers never silently drop an entry: each add is a read →
 * compose → replace, serialized by the repository's log-write lock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logAdd } from '../../../src/core/log/log-add.js';
import { appendAspectLogEntry, aspectLogPath } from '../../../src/core/log/aspect-log.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-lograce-'));
  dirs.push(root);
  const nodeDir = path.join(root, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await mkdir(path.join(root, '.yggdrasil', 'aspects', 'rule-a'), { recursive: true });
  return root;
}

describe('log-write lock', () => {
  it('8 concurrent `log add` on one node yield 8 entries, all reported ok', async () => {
    const root = await setup();
    const graph = await loadGraph(root, { tolerateInvalidConfig: true });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => logAdd({ graph, nodePath: 'billing', reasonText: `Entry number ${i}`, nowMs: 1000 + i })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const content = await readFile(path.join(root, '.yggdrasil', 'model', 'billing', 'log.md'), 'utf-8');
    const bodies = parseLog(content).map((e) => e.body.trim()).sort();
    expect(bodies).toEqual(Array.from({ length: 8 }, (_, i) => `Entry number ${i}`).sort());
  });

  it('8 concurrent entries on one rule\'s own log are all kept', async () => {
    const root = await setup();
    const ygg = path.join(root, '.yggdrasil');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendAspectLogEntry({ yggRootPath: ygg, aspectId: 'rule-a', reasonText: `Rule entry ${i}`, nowMs: 1000 + i })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const content = await readFile(aspectLogPath(ygg, 'rule-a'), 'utf-8');
    expect(parseLog(content)).toHaveLength(8);
  });
});
