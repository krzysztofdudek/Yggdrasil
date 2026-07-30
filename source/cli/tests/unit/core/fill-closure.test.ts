import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock, writeLock } from '../../../src/io/lock-store.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Positive-closure unit tests for the log_required-gated source fingerprint and
// the minimal logs lock (spec §7.5 / §9). These exercise core/fill-closure.ts
// (reconcileNonLogRequiredEntry, closeLogBaselineOnly, the FileUnreadableError
// hold-back) over a deterministic-only node, so the harness is self-contained:
// the real structure runner executes the check.mjs and no LLM provider is needed.
// (The all-enforced-approved / advisory / unverified closure cases that involve an
// LLM aspect live in fill-det.test.ts alongside the provider mock.)
// ─────────────────────────────────────────────────────────────────────────────

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Build a single deterministic-aspect node `svc` (type `service`). */
async function setupDetNode(opts: {
  logRequired?: boolean;
  logContent?: string;
  mapping?: string[];
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-closure-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  const nodeDir = path.join(ygg, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(ygg, 'yg-config.yaml'), REVIEWER_CONFIG);
  await writeFile(
    path.join(ygg, 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: s\n    log_required: ${opts.logRequired ?? false}\n`,
  );
  const mapping = opts.mapping ?? ['src/svc.ts'];
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n${mapping.map((m) => `  - ${m}`).join('\n')}\naspects:\n  - det-a\n`,
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  if (opts.logContent !== undefined) await writeFile(path.join(nodeDir, 'log.md'), opts.logContent);
  const aspDir = path.join(ygg, 'aspects', 'det-a');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: det-a\ndescription: det-a rule\nreviewer:\n  type: deterministic\nstatus: enforced\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
  return root;
}

describe('positive closure — log_required source fingerprint + minimal logs lock', () => {
  it('a non-log_required node with a log.md records its log baseline but NO source fingerprint', async () => {
    const projectRoot = await setupDetNode({
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n', // logRequired defaults to false
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    // The append-only log baseline is recorded (integrity is independent of log_required)…
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
    // …but a non-log_required node never carries a source fingerprint.
    expect(lock.nodes['svc']?.source).toBeUndefined();
  });

  it('a non-log_required node with no log.md gets no nodes[] entry at all', async () => {
    const projectRoot = await setupDetNode({});
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).nodes['svc']).toBeUndefined();
  });

  it('a mapping-less log_required node records its log baseline at closure, with no source', async () => {
    const projectRoot = await setupDetNode({
      mapping: [], // mapping-less → undefined source fingerprint
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.source).toBeUndefined();
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('a log_required node with an unreadable mapped file is held back at closure (no false-green)', async () => {
    const projectRoot = await setupDetNode({
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const run1Source = readLock(graph.rootPath).nodes['svc']?.source;
    expect(run1Source).toBeDefined();

    const svc = path.join(projectRoot, 'src', 'svc.ts');
    await chmod(svc, 0o000); // unreadable (EACCES as the non-root test user)
    try {
      graph = await loadGraph(projectRoot);
      // Closure computes the source fingerprint, hits FileUnreadableError, and
      // declines to advance — the run completes and the prior fingerprint is intact.
      await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
      expect(readLock(graph.rootPath).nodes['svc']?.source).toBe(run1Source);
    } finally {
      await chmod(svc, 0o644); // restore so the temp dir can be cleaned up
    }
  });

  it('closure NEVER launders a tampered log history green — the stored baseline survives --approve', async () => {
    // Two-entry log so the append-only baseline boundary is the SECOND entry and
    // the FIRST entry lives strictly inside the hashed prefix. Editing the first
    // entry's body is a historical tamper the read-path integrity check refuses.
    const logMd =
      '## [2026-05-11T10:00:00.000Z]\nfirst entry body\n## [2026-05-11T11:00:00.000Z]\nsecond entry body\n';
    const projectRoot = await setupDetNode({ logContent: logMd }); // non-log_required
    const nodeLog = path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'log.md');

    let graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const sealed = readLock(graph.rootPath).nodes['svc']?.log;
    expect(sealed?.last_entry_datetime).toBe('2026-05-11T11:00:00.000Z');
    expect(sealed?.prefix_hash).toBeDefined();

    // Tamper the FIRST (pre-baseline) entry's body in place — the boundary entry's
    // datetime is untouched, so the break is a prefix modification inside the seal.
    await writeFile(
      nodeLog,
      logMd.replace('first entry body', 'TAMPERED HISTORY'),
    );

    // Re-fill (the standard end-of-work path). Closure must NOT recompute the
    // baseline over the tampered bytes and overwrite the committed anchor.
    graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const afterTamper = readLock(graph.rootPath).nodes['svc']?.log;
    expect(afterTamper?.prefix_hash).toBe(sealed?.prefix_hash);
    expect(afterTamper?.last_entry_datetime).toBe(sealed?.last_entry_datetime);
    // Sanity: the tamper is real on disk (so a passing assertion is not vacuous).
    expect(await readFile(nodeLog, 'utf-8')).toContain('TAMPERED HISTORY');
  });

  it('closure DOES advance the baseline for a legitimate pure append (no false hold-back)', async () => {
    const logMd = '## [2026-05-11T10:00:00.000Z]\nfirst entry body\n';
    const projectRoot = await setupDetNode({ logContent: logMd }); // non-log_required
    const nodeLog = path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'log.md');

    let graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const first = readLock(graph.rootPath).nodes['svc']?.log;
    expect(first?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');

    // Append a NEW entry the way `yg log add` does — header directly after the
    // trailing newline, no blank-line separator — leaving historical bytes intact.
    await writeFile(nodeLog, logMd + '## [2026-05-11T12:00:00.000Z]\nsecond entry body\n');
    graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const advanced = readLock(graph.rootPath).nodes['svc']?.log;
    expect(advanced?.last_entry_datetime).toBe('2026-05-11T12:00:00.000Z');
    expect(advanced?.prefix_hash).not.toBe(first?.prefix_hash);
  });

  it('a non-log_required node strips a stale source-only entry left by an earlier CLI', async () => {
    const projectRoot = await setupDetNode({}); // non-log_required, no log.md
    const graph = await loadGraph(projectRoot);
    // Seed a stale source-only entry (the shape an older CLI wrote for every node).
    const seeded = readLock(graph.rootPath);
    seeded.nodes['svc'] = { source: 'stale-fingerprint' };
    await writeLock(graph.rootPath, seeded, { scope: 'logs' });
    expect(readLock(graph.rootPath).nodes['svc']?.source).toBe('stale-fingerprint');
    // Re-fill: closure reconciles the non-log_required node → strips the dead
    // source; with no log.md the whole entry is removed.
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).nodes['svc']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Closure byte-identity with a nodeless (type-covered, componentless) pair
// present in the SAME run. fill-closure.ts's byNode grouping explicitly skips a
// pair with no owning component ("a file with no component has no fingerprint
// and no log baseline to close") — this pins that the skip is TOTAL: a
// log_required node's own closure outcome does not change by one byte whether
// or not an unrelated componentless file shares the run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `svc` (log_required, one deterministic aspect) plus, optionally, a second
 * file (src/leaf.ts) mapped by no node. With coverage.type_level on and an
 * architecture type matching it, that file becomes a nodeless pair. Its own
 * attached rule need not succeed for this test — a nodeless deterministic
 * check infra-errors today (structure/hook-loader.ts resolves node identity
 * before the check body runs, a known, separately-owned limitation) — which is
 * itself part of what this test proves svc's own closure is indifferent to.
 */
async function setupSvcWithOptionalLeaf(withLeaf: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-closure-nodeless-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  const nodeDir = path.join(ygg, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(ygg, 'yg-config.yaml'), REVIEWER_CONFIG + 'coverage:\n  type_level: true\n');
  const leafType = withLeaf
    ? '\n  leaf:\n    description: a type-classified leaf file\n    when:\n      path: "src/leaf.ts"\n    aspects:\n      - own-file-rule\n'
    : '';
  await writeFile(
    path.join(ygg, 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: s\n    log_required: true${leafType}\n`,
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-a\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  // log_required needs a fresh log entry before the FIRST fill (the all-or-
  // nothing gate); a fixed timestamp keeps both twin runs' entries byte-equal.
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nfirst.\n');
  const aspDir = path.join(ygg, 'aspects', 'det-a');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: det-a\ndescription: det-a rule\nreviewer:\n  type: deterministic\nstatus: enforced\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
  if (withLeaf) {
    await writeFile(path.join(root, 'src', 'leaf.ts'), 'export const y = 1;\n');
    const leafAspDir = path.join(ygg, 'aspects', 'own-file-rule');
    await mkdir(leafAspDir, { recursive: true });
    await writeFile(
      path.join(leafAspDir, 'yg-aspect.yaml'),
      'name: own-file-rule\ndescription: a per-file rule attached to the leaf type\nreviewer:\n  type: deterministic\nstatus: enforced\nscope:\n  per: file\n',
    );
    await writeFile(path.join(leafAspDir, 'check.mjs'), DET_PASS);
  }
  return root;
}

describe('positive closure — byte-identical with a nodeless pair present', () => {
  it("a log_required node's closure entry is identical whether or not a componentless file shares the run", async () => {
    const withLeafRoot = await setupSvcWithOptionalLeaf(true);
    const withoutLeafRoot = await setupSvcWithOptionalLeaf(false);

    const withLeafGraph = await loadGraph(withLeafRoot);
    await runFill(withLeafGraph, {
      coverageVisibleFiles: await walkRepoFiles(withLeafRoot),
      write: () => {},
    });
    const withLeafEntry = readLock(withLeafGraph.rootPath).nodes['svc'];

    const withoutLeafGraph = await loadGraph(withoutLeafRoot);
    await runFill(withoutLeafGraph, {
      coverageVisibleFiles: await walkRepoFiles(withoutLeafRoot),
      write: () => {},
    });
    const withoutLeafEntry = readLock(withoutLeafGraph.rootPath).nodes['svc'];

    // Sanity: svc actually closed (recorded a fingerprint) in both runs — a
    // false pass below would otherwise be comparing two undefineds.
    expect(withLeafEntry?.source).toBeDefined();
    expect(withoutLeafEntry?.source).toBeDefined();
    expect(withLeafEntry).toEqual(withoutLeafEntry);
  });
});
