import { describe, it, expect } from 'vitest';
// The spectral-headroom probe's PURE structural analysis is exercised directly
// here — no subprocess, no built dist, fully offline and deterministic. It imports
// only the pure functions from the plain-ESM script at the repo root; the spectral
// math has zero heavy dependencies (the graph-loading half is dynamic-imported by
// the script's main() only, so importing the pure functions loads nothing else).
// @ts-expect-error — plain ESM script at the repo root, no type declarations.
import { analyzeStructure } from '../../../../scripts/spectral-headroom.mjs';

// ---------------------------------------------------------------------------
// Fixture: two triangles joined by a SINGLE bridge edge, with the two directory
// prefixes (`a/…`, `b/…`) aligned to the two triangles. Fully hand-computable.
//
//   a/1 — a/2         b/1 — b/2
//    \   /             \   /
//    a/3 ————bridge———— b/1        (triangle A: a/1,a/2,a/3 ; triangle B: b/1,b/2,b/3)
//
// Degrees: a/1=2, a/2=2, a/3=3, b/1=3, b/2=2, b/3=2  (total volume 14).
// The natural minimum-conductance cut is {a/*} | {b/*}: exactly ONE edge (the
// bridge) crosses, each side has volume 7, so φ* = 1 / min(7,7) = 1/7.
// The trivial (all-zero) eigenvalue of the normalized Laplacian is 0; the second
// eigenvalue λ₂ ≈ 0.2046663546 (independently cross-checked with a dense Jacobi
// eigensolver). Because the directories are aligned to the triangles, every
// directory cut equals the optimum → headroom = 1.
// ---------------------------------------------------------------------------
const NODE_IDS = ['a/1', 'a/2', 'a/3', 'b/1', 'b/2', 'b/3'];
const EDGES = [
  { from: 'a/1', to: 'a/2' },
  { from: 'a/2', to: 'a/3' },
  { from: 'a/1', to: 'a/3' },
  { from: 'b/1', to: 'b/2' },
  { from: 'b/2', to: 'b/3' },
  { from: 'b/1', to: 'b/3' },
  { from: 'a/3', to: 'b/1' }, // the single bridge
];

const ONE_SEVENTH = 1 / 7;
const LAMBDA2 = 0.2046663546;

describe('spectral-headroom — two triangles joined by one bridge (hand-checkable)', () => {
  it('takes the whole graph as the giant component', () => {
    const r = analyzeStructure(NODE_IDS, EDGES);
    expect(r.totalNodes).toBe(6);
    expect(r.componentSize).toBe(6);
    expect([...r.componentNodes].sort()).toEqual([
      'a/1',
      'a/2',
      'a/3',
      'b/1',
      'b/2',
      'b/3',
    ]);
  });

  it('recovers λ₂ of the normalized Laplacian', () => {
    const r = analyzeStructure(NODE_IDS, EDGES);
    expect(r.lambda2).toBeCloseTo(LAMBDA2, 5);
  });

  it('splits the Fiedler vector along the bridge (triangle A vs triangle B)', () => {
    const r = analyzeStructure(NODE_IDS, EDGES);
    const sign = (id: string) => Math.sign(r.fiedler[id]);
    // The three A-nodes share one sign; the three B-nodes share the opposite sign.
    expect(sign('a/1')).toBe(sign('a/2'));
    expect(sign('a/2')).toBe(sign('a/3'));
    expect(sign('b/1')).toBe(sign('b/2'));
    expect(sign('b/2')).toBe(sign('b/3'));
    expect(sign('a/1')).toBe(-sign('b/1'));
    // Sign is canonicalized (smallest-id entry non-negative) so the numbers are
    // reproducible, not merely a partition.
    expect(r.fiedler['a/1']).toBeGreaterThanOrEqual(0);
  });

  it('finds φ* = 1/7 via the sweep cut, at the a|b boundary', () => {
    const r = analyzeStructure(NODE_IDS, EDGES);
    expect(r.phiStar).toBeCloseTo(ONE_SEVENTH, 10);
    expect([...r.sweepCut.nodes].sort()).toEqual(['a/1', 'a/2', 'a/3']);
  });

  it('scores each aligned directory cut at the optimum → headroom 1', () => {
    const r = analyzeStructure(NODE_IDS, EDGES);
    const byDir = Object.fromEntries(
      r.directoryCuts.map((d: { dir: string; conductance: number }) => [d.dir, d.conductance]),
    );
    expect(byDir['a']).toBeCloseTo(ONE_SEVENTH, 10);
    expect(byDir['b']).toBeCloseTo(ONE_SEVENTH, 10);
    expect(r.minDir?.conductance).toBeCloseTo(ONE_SEVENTH, 10);
    expect(r.headroom).toBeCloseTo(1, 10);
  });

  it('is byte-identical across two runs (deterministic)', () => {
    const a = analyzeStructure(NODE_IDS, EDGES);
    const b = analyzeStructure(NODE_IDS, EDGES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('spectral-headroom — giant-component selection', () => {
  it('analyzes the LARGER component and drops the detached smaller one', () => {
    // The 6-node two-triangles graph PLUS a detached 2-node component (c/1—c/2).
    const nodeIds = [...NODE_IDS, 'c/1', 'c/2'];
    const edges = [...EDGES, { from: 'c/1', to: 'c/2' }];
    const r = analyzeStructure(nodeIds, edges);
    expect(r.totalNodes).toBe(8);
    expect(r.componentSize).toBe(6); // the giant component, not the 2-node island
    expect([...r.componentNodes].sort()).not.toContain('c/1');
    // The optimum is unchanged — the island does not participate.
    expect(r.phiStar).toBeCloseTo(ONE_SEVENTH, 10);
  });
});
