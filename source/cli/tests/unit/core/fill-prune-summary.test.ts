/**
 * Tests for the GC prune summary — the text `--approve` and
 * `--dry-run` print whenever entries are pruned, split into billed (LLM) vs
 * free (deterministic) with a reason per entry, and print NOTHING when
 * nothing is pruned.
 *
 * Real on-disk project (mkdtemp), real runFill — mirrors fill-closure.test.ts's
 * own setup convention. The prune scenario itself does not need a real
 * type-covered file: any positively-detached verdict entry (here, a stale
 * entry for an aspect id that no longer exists) exercises the SAME
 * garbageCollectAndRewrite → writePruneSummary code path type-coverage input
 * is threaded through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock, writeLock, nondetLockPath } from '../../../src/io/lock-store.js';
import { readFileSync, existsSync } from 'node:fs';

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

describe('GC prune summary — wording', () => {
  it('prints "Pruned N stale verdict(s) — B billed, F free:" plus one [kind] line per entry, when something is pruned', async () => {
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);
    // Seed a stale entry for an aspect id that no longer exists at all — a
    // genuinely detached verdict, positively prunable. Written via writeLock
    // with 'ghost-aspect' absent from deterministicAspectIds, so it lands in
    // the COMMITTED (LLM) file, not the gitignored deterministic one — real
    // committed/gitignored partitioning, not a hand-picked kind.
    const lock = readLock(graph.rootPath);
    lock.verdicts['ghost-aspect'] = { 'node:svc': { verdict: 'approved', hash: 'stale-hash' } };
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds: new Set(['det-a']) });

    let out = '';
    await runFill(graph, { coverageVisibleFiles: null, write: (s) => { out += s; } });

    // The aspect no longer exists in the graph, so its kind cannot be read off
    // reviewer.type — but its verdicts live in the COMMITTED file, so the
    // summary correctly reports it billed, never silently free.
    expect(out).toContain('Pruned 1 stale verdict(s) — 1 billed, 0 free:');
    expect(out).toContain('[llm] ghost-aspect on node:svc — aspect removed');
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

    expect(out).toContain('Pruned 1 stale verdict(s) — 1 billed, 0 free:');
    // The REAL committed lock is untouched — the stale entry is still there.
    const stillThere = readLock(graph.rootPath);
    expect(stillThere.verdicts['ghost-aspect']?.['node:svc']).toBeDefined();
  });

  it('reports an entry it cannot classify at all (no on-disk lock partition to consult) as "unknown", never silently "free"', async () => {
    // garbageCollectAndRewrite called directly (the engine seam, not through
    // runFill): an aspect absent from the graph, no detAspectIdsOnDisk opt
    // passed. The old behavior defaulted this straight to 'deterministic'
    // (free) — under-reporting a possibly-billed entry. The fix must neither
    // guess nor drop it: 'unknown', counted in neither billedCount nor
    // freeCount.
    const { garbageCollectAndRewrite } = await import('../../../src/core/fill-gc.js');
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);
    const lock = readLock(graph.rootPath);
    lock.verdicts['ghost-aspect'] = { 'node:svc': { verdict: 'approved', hash: 'stale-hash' } };

    const summary = await garbageCollectAndRewrite(graph, lock, async () => {});

    expect(summary.entries).toEqual([
      { aspectId: 'ghost-aspect', unitKey: 'node:svc', kind: 'unknown', reason: 'aspect removed' },
    ]);
    expect(summary.billedCount).toBe(0);
    expect(summary.freeCount).toBe(0);
    expect(summary.unknownCount).toBe(1);
  });

  it('--only-deterministic only claims to prune what it actually writes: the stale deterministic entry is gone, the stale LLM entry is untouched and unmentioned', async () => {
    const projectRoot = await setupProject();
    const graph = await loadGraph(projectRoot);
    // Two stale entries, one of each kind, both genuinely detached (their
    // aspect id no longer exists in the graph at all).
    const lock = readLock(graph.rootPath);
    lock.verdicts['ghost-det'] = { 'node:svc': { verdict: 'approved', hash: 'stale-det-hash' } };
    lock.verdicts['ghost-llm'] = { 'node:svc': { verdict: 'approved', hash: 'stale-llm-hash' } };
    await writeLock(graph.rootPath, lock, {
      scope: 'all',
      // 'ghost-det' partitions to the gitignored deterministic file, 'ghost-llm'
      // to the committed one — real committed/gitignored partitioning.
      deterministicAspectIds: new Set(['det-a', 'ghost-det']),
    });
    const nondetBefore = readFileSync(nondetLockPath(graph.rootPath), 'utf-8');
    expect(nondetBefore).toContain('ghost-llm');

    let out = '';
    await runFill(graph, { coverageVisibleFiles: null, onlyDeterministic: true, write: (s) => { out += s; } });

    // Only the entry actually removed from disk is reported — the stale LLM
    // entry was never written away (scope: 'deterministic' never touches the
    // committed nondeterministic file), so claiming it as pruned would say a
    // write happened that did not.
    expect(out).toContain('Pruned 1 stale verdict(s) — 0 billed, 1 free:');
    expect(out).toContain('[deterministic] ghost-det on node:svc');
    expect(out).not.toContain('ghost-llm');

    // The committed nondeterministic file is BYTE-IDENTICAL to before — the
    // stale LLM entry genuinely never left it.
    const nondetAfter = readFileSync(nondetLockPath(graph.rootPath), 'utf-8');
    expect(nondetAfter).toBe(nondetBefore);
    expect(nondetAfter).toContain('ghost-llm');

    // A full `--approve` afterward actually prunes both, and says so.
    let out2 = '';
    await runFill(graph, { coverageVisibleFiles: null, write: (s) => { out2 += s; } });
    expect(out2).toContain('Pruned 1 stale verdict(s) — 1 billed, 0 free:');
    expect(out2).toContain('[llm] ghost-llm on node:svc');
    // ghost-llm was the committed file's only entry — pruning it away leaves
    // nothing to persist, so the file is removed rather than rewritten empty
    // (io/lock-store.ts's writeOrRemoveSplitFile); its absence IS the proof.
    expect(existsSync(nondetLockPath(graph.rootPath))).toBe(false);
  });
});
