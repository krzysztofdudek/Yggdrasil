import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Wrap the REAL relation pass so a single portal render's pass count can be measured — the
// ≤2-pass invariant (runCheck's relation-conformance pass + the boundary pass, and NO third).
// `vi.fn(actual.runRelationPass)` still runs the genuine parse (no fabricated data): this is a
// COUNTER around the real function, not a stand-in for it.
vi.mock('../../src/relations/pass.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/relations/pass.js')>();
  return { ...actual, runRelationPass: vi.fn(actual.runRelationPass) };
});

import { runRelationPass } from '../../src/relations/pass.js';
import { extractPortalData } from '../../src/portal/extract.js';
import { deriveStructure, REACH_CAPTION_MIN_NODES } from '../../src/portal/derive-metrics.js';
import type { PortalData, PortalStructure } from '../../src/portal/contract.js';
import type { Graph } from '../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** A minimal Graph carrying only what deriveStructure reads: node ids + declared relations. */
function graphOf(
  nodeIds: string[],
  relations: Record<string, Array<{ target: string; type: string; consumes?: string[] }>> = {},
): Graph {
  const nodes = new Map<string, unknown>();
  for (const id of nodeIds) nodes.set(id, { meta: { relations: relations[id] ?? [] } });
  return { nodes } as unknown as Graph;
}

// ── deriveStructure — pure, hand-built plain-data fixtures (no repo, no I/O) ─────────────────

describe('deriveStructure — honest UNKNOWN on a null (thrown) relation parse', () => {
  it('renders an explicit unknown state, never a fabricated zero graph', () => {
    // A 3-node graph WITH declared relations is available, but the detected half is null (parse
    // threw). The panel must say "unknown", not fabricate an all-declared graph.
    const graph = graphOf(['a', 'a/x', 'b'], { 'a/x': [{ target: 'b', type: 'uses' }] });
    const s = deriveStructure(graph, null);
    expect(s.unknown).toBe(true);
    expect(s.edgeCount).toBe(0);
    expect(s.tunnels).toEqual([]);
    expect(s.layers).toEqual([]);
    expect(s.reachMean).toBe(0);
  });
});

describe('deriveStructure — small-N floor suppresses the interpretive caption (raw numbers stay)', () => {
  it('flags smallGraph below the node-count floor while still reporting the raw figures', () => {
    // 3 nodes < REACH_CAPTION_MIN_NODES → the "average component" sentence is not meaningful,
    // so smallGraph is true; the raw edge count and reach fraction are still present.
    const graph = graphOf(['a', 'a/x', 'b'], { 'a/x': [{ target: 'b', type: 'calls' }] });
    const s = deriveStructure(graph, []);
    expect(REACH_CAPTION_MIN_NODES).toBeGreaterThan(3);
    expect(s.unknown).toBe(false);
    expect(s.smallGraph).toBe(true);
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(1); // a/x → b (declared, structural)
    expect(typeof s.reachMean).toBe('number');
    expect(s.reachMean).toBeGreaterThan(0); // a/x reaches b
  });
});

describe('deriveStructure — a normal (above-floor) graph with a cross-tree dependency', () => {
  // 11 nodes (≥ floor). Two declared structural edges reach across distant subtrees; one detected
  // edge lives elsewhere. The widest span must rank first.
  const nodeIds = ['a', 'a/x', 'a/x/y', 'b', 'b/p', 'b/p/q', 'c', 'd', 'e', 'f', 'g'];
  const graph = graphOf(nodeIds, {
    'a/x/y': [{ target: 'b/p/q', type: 'uses' }], // span 6 — the deepest cross-tree tunnel
    'a/x': [{ target: 'b/p', type: 'calls', consumes: ['port'] }], // span 4, via a declared contract
  });
  // Detected-only edge (the flattened seam shape): c → d.
  const detected = [{ from: 'c', targets: ['d'] }];
  const s: PortalStructure = deriveStructure(graph, detected);

  it('is not unknown and not small-N', () => {
    expect(s.unknown).toBe(false);
    expect(s.smallGraph).toBe(false);
    expect(s.nodeCount).toBe(11);
  });

  it('ranks tunnels widest-span first, in plain-data form', () => {
    expect(s.edgeCount).toBe(3);
    expect(s.tunnels.length).toBe(3);
    expect(s.tunnels[0].from).toBe('a/x/y');
    expect(s.tunnels[0].to).toBe('b/p/q');
    expect(s.tunnels[0].span).toBe(6);
    expect(s.tunnels[0].origin).toBe('declared');
    expect(s.tunnels[0].viaContract).toBe(false);
    // Spans are non-increasing down the list (the ranking the panel reads).
    for (let i = 1; i < s.tunnels.length; i++) {
      expect(s.tunnels[i].span).toBeLessThanOrEqual(s.tunnels[i - 1].span);
    }
    // The port-contract-backed edge is flagged as such.
    const contractEdge = s.tunnels.find((t) => t.from === 'a/x' && t.to === 'b/p');
    expect(contractEdge?.viaContract).toBe(true);
    // The detected-only edge carries the detected origin.
    const detectedEdge = s.tunnels.find((t) => t.from === 'c' && t.to === 'd');
    expect(detectedEdge?.origin).toBe('detected');
  });

  it('reports module-group layers per depth (only depths with 2+ groups)', () => {
    expect(s.layers.length).toBeGreaterThan(0);
    for (const layer of s.layers) {
      expect(layer.groups.length).toBeGreaterThanOrEqual(2);
      expect(layer.crossings).toBeGreaterThan(0);
      expect(layer.loopShare).toBeGreaterThanOrEqual(0);
      expect(layer.loopShare).toBeLessThanOrEqual(1);
    }
  });

  it('reports a mean forward-reach fraction in [0, 1]', () => {
    expect(s.reachMean).toBeGreaterThan(0);
    expect(s.reachMean).toBeLessThanOrEqual(1);
  });

  it('is fully JSON-flat: no Map/Set survives a JSON round-trip (deep-equal)', () => {
    // The JSON seam is safeJsonForScript(JSON.stringify). A Map/Set would serialize to `{}` and
    // break this deep-equal — so the structure must already be plain arrays/objects.
    const roundTripped = JSON.parse(JSON.stringify(s));
    expect(roundTripped).toEqual(s);
  });
});

// ── extractPortalData on the REAL repo — the ≤2-pass invariant + the live structure panel ────

describe('portal structure panel — real repo, ≤2 relation passes, JSON-flat seam', () => {
  let data: PortalData;
  let passCalls: number;

  beforeAll(async () => {
    vi.mocked(runRelationPass).mockClear();
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });
    passCalls = vi.mocked(runRelationPass).mock.calls.length;
  }, 180_000);

  it('runs the relation pass AT MOST twice across one full render (reuses the boundary pass)', () => {
    // runCheck's live relation-conformance pass + the boundary pass = 2. The structure panel
    // reuses the boundary pass's detected-edge set, so it adds NO third pass.
    expect(passCalls).toBeGreaterThanOrEqual(1); // the pass really ran (not a silent no-op)
    expect(passCalls).toBeLessThanOrEqual(2);
  });

  it('carries a live structure panel (not unknown) on the real repo', () => {
    expect(data.structure.unknown).toBe(false);
    expect(data.structure.nodeCount).toBe(data.meta.counts.nodes);
    expect(data.structure.smallGraph).toBe(false); // the real repo is well above the floor
    expect(data.structure.edgeCount).toBeGreaterThan(0);
    expect(data.structure.tunnels.length).toBeGreaterThan(0);
    expect(data.structure.layers.length).toBeGreaterThan(0);
    expect(data.structure.reachMean).toBeGreaterThan(0);
    expect(data.structure.reachMean).toBeLessThanOrEqual(1);
  });

  it('the structure panel round-trips through JSON.stringify losslessly (no Map/Set at the seam)', () => {
    const roundTripped = JSON.parse(JSON.stringify(data.structure));
    expect(roundTripped).toEqual(data.structure);
  });

  it('tunnels are ranked widest-span first and name real graph nodes', () => {
    const paths = new Set(data.nodes.map((n) => n.path));
    for (let i = 0; i < data.structure.tunnels.length; i++) {
      const t = data.structure.tunnels[i];
      expect(paths.has(t.from)).toBe(true);
      expect(paths.has(t.to)).toBe(true);
      if (i > 0) expect(t.span).toBeLessThanOrEqual(data.structure.tunnels[i - 1].span);
    }
  });
});
