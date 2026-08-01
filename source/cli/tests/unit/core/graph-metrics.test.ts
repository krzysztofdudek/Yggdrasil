import { describe, it, expect } from 'vitest';
import {
  edgeUniverse,
  tunnelSpans,
  quotientAtDepth,
  changeReach,
  depthOfPath,
  lcaDepthOfPaths,
  ancestorAtDepth,
  widenedTunnelMetrics,
  rankTunnels,
  type StructEdge,
} from '../../../src/core/graph-metrics.js';

// ---------------------------------------------------------------------------
// Hand-built pure-data fixture: a 4-node tree
//
//   a
//   ├── a/x
//   b
//   └── b/y
//
// Declared relations (as loaded from the graph model — plain data):
//   a/x → a     uses    (structural, consumes: [])              → origin 'declared'
//   a   → b     emits   (EVENT type — EXCLUDED from the universe)
//   b/y → b     calls   (structural, consumes: ['port'])        → viaContract, and
//                        also statically detected               → origin 'both'
//
// Detected edges (shape from relations/pass.ts: Map<fromId, Set<toId>>):
//   a/x → b/y   (detected only)                                 → origin 'detected'
//   b/y → b     (also declared-with-consumes)                   → origin 'both'
// ---------------------------------------------------------------------------

const NODE_IDS = ['a', 'a/x', 'b', 'b/y'];

const DECLARED = [
  { from: 'a/x', to: 'a', type: 'uses', consumes: [] as string[] },
  { from: 'a', to: 'b', type: 'emits', consumes: [] as string[] }, // event — excluded
  { from: 'b/y', to: 'b', type: 'calls', consumes: ['port'] }, // structural + viaContract
];

const DETECTED = new Map<string, Set<string>>([
  ['a/x', new Set(['b/y'])],
  ['b/y', new Set(['b'])],
]);

describe('graph-metrics hierarchy helpers (pure path-segment math)', () => {
  it('depthOfPath counts path segments', () => {
    expect(depthOfPath('a')).toBe(1);
    expect(depthOfPath('a/x')).toBe(2);
    expect(depthOfPath('a/b/c')).toBe(3);
  });

  it('lcaDepthOfPaths counts the common path prefix in whole segments', () => {
    expect(lcaDepthOfPaths('a/x', 'a')).toBe(1); // shared prefix "a"
    expect(lcaDepthOfPaths('a/x', 'b/y')).toBe(0); // nothing shared
    expect(lcaDepthOfPaths('a/x', 'a/y')).toBe(1); // shared "a", not "x"/"y"
    expect(lcaDepthOfPaths('a/x/y', 'a/x/z')).toBe(2); // shared "a/x"
    // whole-segment only: "ab" must not count as a prefix of "abc"
    expect(lcaDepthOfPaths('ab/x', 'abc/y')).toBe(0);
  });

  it('ancestorAtDepth truncates to the first d segments', () => {
    expect(ancestorAtDepth('a/x', 1)).toBe('a');
    expect(ancestorAtDepth('a/x/y', 2)).toBe('a/x');
    expect(ancestorAtDepth('a', 1)).toBe('a');
    // depth beyond the node's own depth returns the whole id
    expect(ancestorAtDepth('a', 3)).toBe('a');
  });
});

describe('edgeUniverse', () => {
  it('merges structural-declared and detected edges, deduped per node pair', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    expect(universe).toEqual<StructEdge[]>([
      { from: 'a/x', to: 'a', viaContract: false, origin: 'declared' },
      { from: 'a/x', to: 'b/y', viaContract: false, origin: 'detected' },
      { from: 'b/y', to: 'b', viaContract: true, origin: 'both' },
    ]);
  });

  it('excludes event relation types (emits / listens) from the universe', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    // the a → b emits edge must NOT appear
    expect(universe.some((e) => e.from === 'a' && e.to === 'b')).toBe(false);
    expect(universe).toHaveLength(3);
  });

  it('sorts two same-`from` edges into ascending `to` order regardless of insertion order', () => {
    // Both edges share from='z'; the Set below iterates 'b' before 'a', so the
    // pre-sort array is [z->b, z->a] — the comparator must actually reorder by
    // `to` (not just by `from`, which is identical for this pair) to produce the
    // documented ascending-(from,to) contract.
    const detected = new Map<string, Set<string>>([['z', new Set(['b', 'a'])]]);
    const universe = edgeUniverse([], detected);
    expect(universe.map((e) => `${e.from}->${e.to}`)).toEqual(['z->a', 'z->b']);
  });

  it('viaContract is true iff some declared relation for the pair carries non-empty consumes', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const withContract = universe.find((e) => e.from === 'b/y' && e.to === 'b');
    expect(withContract?.viaContract).toBe(true);
    const noContract = universe.find((e) => e.from === 'a/x' && e.to === 'a');
    expect(noContract?.viaContract).toBe(false);
  });

  it('is deterministically sorted by (from, to) regardless of input order', () => {
    const shuffledDeclared = [...DECLARED].reverse();
    const shuffledDetected = new Map<string, Set<string>>([
      ['b/y', new Set(['b'])],
      ['a/x', new Set(['b/y'])],
    ]);
    const universe = edgeUniverse(shuffledDeclared, shuffledDetected);
    expect(universe.map((e) => `${e.from}->${e.to}`)).toEqual([
      'a/x->a',
      'a/x->b/y',
      'b/y->b',
    ]);
  });
});

describe('tunnelSpans', () => {
  it('computes span = depth(from) + depth(to) − 2·lcaDepth(from,to)', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const spanned = tunnelSpans(universe, depthOfPath, lcaDepthOfPaths);
    const byPair = new Map(spanned.map((e) => [`${e.from}->${e.to}`, e.span]));
    expect(byPair.get('a/x->a')).toBe(1); // 2 + 1 − 2·1
    expect(byPair.get('a/x->b/y')).toBe(4); // 2 + 2 − 2·0
    expect(byPair.get('b/y->b')).toBe(1); // 2 + 1 − 2·1
  });

  it('preserves the edge fields and stays sorted by (from, to)', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const spanned = tunnelSpans(universe, depthOfPath, lcaDepthOfPaths);
    expect(spanned.map((e) => `${e.from}->${e.to}`)).toEqual([
      'a/x->a',
      'a/x->b/y',
      'b/y->b',
    ]);
    expect(spanned[2]).toMatchObject({
      from: 'b/y',
      to: 'b',
      viaContract: true,
      origin: 'both',
      span: 1,
    });
  });
});

describe('widenedTunnelMetrics / rankTunnels — a type-covered file compares in the SAME unit as a real node, never its own raw directory nesting', () => {
  const REAL_NODE_IDS: ReadonlySet<string> = new Set(NODE_IDS); // 'a', 'a/x', 'b', 'b/y'

  it('reduces to depthOfPath / lcaDepthOfPaths exactly when every id is a real node — byte-identical spans', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const { depthOf, lcaDepth } = widenedTunnelMetrics(REAL_NODE_IDS);
    expect(tunnelSpans(universe, depthOf, lcaDepth)).toEqual(tunnelSpans(universe, depthOfPath, lcaDepthOfPaths));
  });

  it('fixes a non-node id (a type-covered file) at depth 1, never its raw directory-segment count', () => {
    const { depthOf } = widenedTunnelMetrics(REAL_NODE_IDS);
    expect(depthOf('a/x')).toBe(2); // a real node — unchanged
    expect(depthOf('src/a/b/c/d/e/p.ts')).toBe(1); // deep on disk, shallow in the metric
    expect(depthOf('lib/q.ts')).toBe(1);
  });

  it('caps a file id\'s LCA at its own (fixed) depth, so a span can never go negative even when it textually nests under a real node', () => {
    const { depthOf, lcaDepth } = widenedTunnelMetrics(REAL_NODE_IDS);
    // 'a/x/typed.ts' shares two raw segments with the real node 'a/x' (lcaDepthOfPaths = 2),
    // but the file's own fixed depth is 1 — the LCA can never exceed that, or span would go
    // negative (depthOf('a/x')=2 + depthOf(file)=1 − 2·2 = −1).
    expect(lcaDepthOfPaths('a/x', 'a/x/typed.ts')).toBe(2);
    expect(lcaDepth('a/x', 'a/x/typed.ts')).toBe(1);
    expect(depthOf('a/x') + depthOf('a/x/typed.ts') - 2 * lcaDepth('a/x', 'a/x/typed.ts')).toBe(1);
  });

  it('a deeply-nested type-covered file edge no longer crowds out a genuine cross-module node tunnel in the ranking', () => {
    // 'a/x -> b/y' is this fixture's real architectural tunnel (span 4, per the tunnelSpans
    // block above). Widen the universe with an edge between two type-covered files that sit
    // many directories deep on disk and share no real ancestor — under raw
    // depthOfPath/lcaDepthOfPaths this edge spans 9 (6+5−2·1), which would outrank the real
    // tunnel. It must not.
    const universe = [
      ...edgeUniverse(DECLARED, DETECTED),
      { from: 'src/a/b/c/d/e/p.ts', to: 'lib/q.ts', viaContract: false, origin: 'detected' as const },
    ];
    const { depthOf, lcaDepth } = widenedTunnelMetrics(REAL_NODE_IDS);
    const ranked = rankTunnels(universe, depthOf, lcaDepth);
    const realTunnel = ranked.find((e) => e.from === 'a/x' && e.to === 'b/y');
    const fileTunnel = ranked.find((e) => e.from === 'src/a/b/c/d/e/p.ts');
    expect(realTunnel?.span).toBe(4);
    expect(fileTunnel?.span).toBeLessThan(realTunnel?.span as number);
    expect(ranked.indexOf(realTunnel as never)).toBeLessThan(ranked.indexOf(fileTunnel as never));
  });

  it('rankTunnels sorts widest span first, ties broken by (from, to)', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const ranked = rankTunnels(universe, depthOfPath, lcaDepthOfPaths);
    // a/x->b/y is span 4; a/x->a and b/y->b both tie at span 1, broken by `from`.
    expect(ranked.map((e) => `${e.from}->${e.to} (${e.span})`)).toEqual([
      'a/x->b/y (4)',
      'a/x->a (1)',
      'b/y->b (1)',
    ]);
  });
});

describe('quotientAtDepth', () => {
  it('collapses nodes to their depth-d ancestor and reports inter-block edges', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const q = quotientAtDepth(universe, 1, ancestorAtDepth);
    expect(q.depth).toBe(1);
    expect(q.blocks).toEqual(['a', 'b']);
    expect(q.interBlockEdges).toEqual([{ from: 'a', to: 'b' }]);
    // acyclic quotient → every crossing edge is between distinct SCCs
    expect(q.sccOutsideShare).toBe(1);
  });

  it('reports sccOutsideShare 0 when the quotient graph has a cycle', () => {
    // a/x → b/y and b/z → a/w collapse to a ↔ b at depth 1 (one 2-node SCC)
    const cyclic: StructEdge[] = [
      { from: 'a/x', to: 'b/y', viaContract: false, origin: 'detected' },
      { from: 'b/z', to: 'a/w', viaContract: false, origin: 'detected' },
    ];
    const q = quotientAtDepth(cyclic, 1, ancestorAtDepth);
    expect(q.blocks).toEqual(['a', 'b']);
    expect(q.interBlockEdges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
    expect(q.sccOutsideShare).toBe(0);
  });

  it('reports a fractional sccOutsideShare when some crossings are inside an SCC and some outside', () => {
    // Depth-1 quotient: a ↔ b (a 2-node SCC), plus a → c and a → d (singletons).
    //   inter-block edges: a→b, a→c, a→d, b→a  (4 distinct crossings)
    //   a→b, b→a lie INSIDE SCC {a,b}; a→c, a→d cross to distinct SCCs
    //   → sccOutsideShare = 2 / 4 = 0.5
    const mixed: StructEdge[] = [
      { from: 'a/m', to: 'b/n', viaContract: false, origin: 'detected' },
      { from: 'b/n', to: 'a/m', viaContract: false, origin: 'detected' },
      { from: 'a/m', to: 'c/p', viaContract: false, origin: 'detected' },
      { from: 'a/m', to: 'd/q', viaContract: false, origin: 'detected' },
    ];
    const q = quotientAtDepth(mixed, 1, ancestorAtDepth);
    expect(q.blocks).toEqual(['a', 'b', 'c', 'd']);
    expect(q.interBlockEdges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' },
      { from: 'b', to: 'a' },
    ]);
    expect(q.sccOutsideShare).toBe(0.5);
  });

  it('returns share 0 and no inter-block edges when nothing crosses a block', () => {
    const intraOnly: StructEdge[] = [
      { from: 'a/x', to: 'a', viaContract: false, origin: 'declared' },
    ];
    const q = quotientAtDepth(intraOnly, 1, ancestorAtDepth);
    expect(q.blocks).toEqual(['a']);
    expect(q.interBlockEdges).toEqual([]);
    expect(q.sccOutsideShare).toBe(0);
  });
});

describe('changeReach', () => {
  it('computes forward-closure reach and the mean normalized reach', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const { mean, perNode } = changeReach(universe, NODE_IDS);
    // a  → {}            → 0/3
    // a/x→ {a, b/y, b}   → 3/3 = 1
    // b  → {}            → 0/3
    // b/y→ {b}           → 1/3
    expect(perNode.get('a')).toBe(0);
    expect(perNode.get('a/x')).toBe(1);
    expect(perNode.get('b')).toBe(0);
    expect(perNode.get('b/y')).toBeCloseTo(1 / 3, 10);
    // mean = (0 + 1 + 0 + 1/3) / 4 = 1/3
    expect(mean).toBeCloseTo(1 / 3, 10);
  });

  it('iterates perNode in sorted node-id order (deterministic Map)', () => {
    const universe = edgeUniverse(DECLARED, DETECTED);
    const { perNode } = changeReach(universe, [...NODE_IDS].reverse());
    expect([...perNode.keys()]).toEqual(['a', 'a/x', 'b', 'b/y']);
  });

  it('handles N ≤ 1 without dividing by zero', () => {
    expect(changeReach([], []).mean).toBe(0);
    const single = changeReach([], ['solo']);
    expect(single.mean).toBe(0);
    expect(single.perNode.get('solo')).toBe(0);
  });
});
