/**
 * Tests for the GC prune summary (Task 6, Step 5) — the text `--approve` and
 * `--dry-run` print whenever entries are pruned, split into billed (LLM) vs
 * free (deterministic) with a reason per entry, and print NOTHING when
 * nothing is pruned. This wording is the contract Task 10's end-to-end
 * graduation pin asserts against.
 *
 * Real on-disk project (mkdtemp), real runFill — mirrors fill-closure.test.ts's
 * own setup convention. The prune scenario itself does not need a real
 * type-covered file: any positively-detached verdict entry (here, a stale
 * entry for an aspect id that no longer exists) exercises the SAME
 * garbageCollectAndRewrite → writePruneSummary code path Task 6 threads
 * type-coverage input through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock, writeLock } from '../../../src/io/lock-store.js';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** One deterministic-aspect node `svc` (type `service`), reviewer configured. */
async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-prune-summary-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  const nodeDir = path.join(ygg, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(ygg, 'yg-config.yaml'),
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
  );
  await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-a\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  const aspDir = path.join(ygg, 'aspects', 'det-a');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: det-a\ndescription: det-a rule\nreviewer:\n  type: deterministic\nstatus: enforced\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
  return root;
}

describe('GC prune summary — Step 5 wording', () => {
  it('prints "Pruned N stale verdict(s) — B billed, F free:" plus one [kind] line per entry, when something is pruned', async () => {
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);
    // Seed a stale entry for an aspect id that no longer exists at all — a
    // genuinely detached verdict, positively prunable.
    const lock = readLock(graph.rootPath);
    lock.verdicts['ghost-aspect'] = { 'node:svc': { verdict: 'approved', hash: 'stale-hash' } };
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds: new Set(['det-a']) });

    let out = '';
    await runFill(graph, { coverageVisibleFiles: null, write: (s) => { out += s; } });

    expect(out).toContain('Pruned 1 stale verdict(s) — 0 billed, 1 free:');
    expect(out).toContain('[deterministic] ghost-aspect on node:svc — aspect removed');
  });

  it('prints NOTHING about pruning when nothing was pruned', async () => {
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);

    let out = '';
    await runFill(graph, { coverageVisibleFiles: null, write: (s) => { out += s; } });

    expect(out).not.toContain('Pruned');
    expect(out).not.toContain('stale verdict');
  });

  it('--dry-run PREVIEWS the same summary text without mutating or persisting the real lock', async () => {
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);
    const lock = readLock(graph.rootPath);
    lock.verdicts['ghost-aspect'] = { 'node:svc': { verdict: 'approved', hash: 'stale-hash' } };
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds: new Set(['det-a']) });

    let out = '';
    await runFill(graph, { coverageVisibleFiles: null, dryRun: true, write: (s) => { out += s; } });

    expect(out).toContain('Pruned 1 stale verdict(s) — 0 billed, 1 free:');
    // The REAL committed lock is untouched — the stale entry is still there.
    const stillThere = readLock(graph.rootPath);
    expect(stillThere.verdicts['ghost-aspect']?.['node:svc']).toBeDefined();
  });
});
