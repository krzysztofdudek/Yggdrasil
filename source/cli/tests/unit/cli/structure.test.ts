import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Graph, GraphNode, Relation } from '../../../src/model/graph.js';
import {
  renderStructure,
  cyclePhrase,
  computeStructuralEdgeUniverse,
} from '../../../src/cli/structure.js';

const LEGEND =
  'edges = declared structural relations ∪ statically detected dependencies; event relations excluded; weights not computed';

/** Minimal in-memory node — renderStructure only reads meta.relations + the id. */
function node(path: string, relations: Relation[] = []): GraphNode {
  return {
    path,
    meta: {
      name: path.split('/').pop() ?? path,
      type: 'service',
      aspects: [],
      relations,
    },
    children: [],
    parent: null,
  };
}

/** renderStructure reads only `graph.nodes`; the rest of Graph is irrelevant. */
function graphOf(nodes: GraphNode[]): Graph {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) map.set(n.path, n);
  return { nodes: map } as unknown as Graph;
}

const NO_DETECTED = new Map<string, Set<string>>();

describe('renderStructure', () => {
  it('always prints the verbatim edge-universe legend, even on an empty graph', () => {
    const out = renderStructure(graphOf([]), NO_DETECTED);
    expect(out).toContain(LEGEND);
    expect(out).toContain('No structural dependencies between components yet.');
    expect(out).toMatch(/From an average component, 0% of the system is reachable/);
  });

  it('names cross-tree tunnels with their span in words and reports the depth-1 module view', () => {
    const graph = graphOf([
      node('auth'),
      node('auth/api'),
      node('checkout'),
      node('checkout/controller', [{ target: 'orders/service', type: 'uses' }]),
      node('orders'),
      node('orders/service', [
        { target: 'auth/api', type: 'uses' },
        { target: 'users/repo', type: 'uses' },
        { target: 'users/repo', type: 'emits', consumes: [] } as Relation,
      ]),
      node('users'),
      node('users/repo', [{ target: 'orders/service', type: 'listens' } as Relation]),
    ]);

    const out = renderStructure(graph, NO_DETECTED);

    // Tunnels — the declared cross-tree edge, span in words.
    expect(out).toContain('checkout/controller → orders/service — jumps 4 levels across the tree');
    // Event relations (emits/listens) are excluded from the universe.
    expect(out).not.toContain('users/repo → orders/service');

    // Modules depth-1: four top-level groups, acyclic.
    expect(out).toContain('At depth 1:');
    expect(out).toContain('4 groups: auth, checkout, orders, users');
    expect(out).toContain('3 dependencies between groups');
    expect(out).toContain('All dependencies between groups flow one way (no cycles).');
  });

  it('phrases a ported edge as "via declared contract"', () => {
    const graph = graphOf([
      node('a'),
      node('a/svc', [{ target: 'b/svc', type: 'uses', consumes: ['charge'] } as Relation]),
      node('b'),
      node('b/svc'),
    ]);
    const out = renderStructure(graph, NO_DETECTED);
    expect(out).toContain('a/svc → b/svc — jumps 4 levels across the tree, via declared contract');
  });

  it('describes a cycle between groups positively (no jargon)', () => {
    const graph = graphOf([
      node('x'),
      node('x/svc', [{ target: 'y/svc', type: 'calls' }]),
      node('y'),
      node('y/svc', [{ target: 'x/svc', type: 'calls' }]),
    ]);
    const out = renderStructure(graph, NO_DETECTED);
    // Two groups that depend on each other → a cycle, phrased positively.
    expect(out).toMatch(/% of the dependencies between groups are part of a cycle/);
    // None of the internal method names leak into the output.
    for (const banned of ['LCA', 'SCC', 'conductance', 'Laplacian', 'Fiedler', 'eigenvalue']) {
      expect(out).not.toContain(banned);
    }
  });

  it('unions detected edges into the universe', () => {
    // No declared relations at all — the only edge is a detected one.
    const graph = graphOf([node('p'), node('p/a'), node('q'), node('q/b')]);
    const detected = new Map<string, Set<string>>([['p/a', new Set(['q/b'])]]);
    const out = renderStructure(graph, detected);
    expect(out).toContain('p/a → q/b — jumps 4 levels across the tree, no declared contract');
  });

  it('omitting `widened` renders the exact node-only output — byte-identical to a caller who never heard of the type-level augmentation', () => {
    const graph = graphOf([node('p'), node('p/a')]);
    const withoutArg = renderStructure(graph, NO_DETECTED);
    const withEmptyWidening = renderStructure(graph, NO_DETECTED, { edges: [], nodeIds: [], hasTypeCovered: false });
    expect(withoutArg).toBe(withEmptyWidening);
    expect(withoutArg).toMatch(/From an average component, 0% of the system is reachable/);
  });

  it('a nonempty widening merges its edges into the SAME universe the node-only edges already populate, and widens the reach population', () => {
    // 'p/a' is a real node; 'p/a/typed.ts' is the widened id space's own file path —
    // sharing the string space directly (file paths are /-delimited too).
    const graph = graphOf([node('p'), node('p/a')]);
    const widened = {
      edges: [{ from: 'p/a', to: 'p/a/typed.ts', viaContract: false, origin: 'detected' as const }],
      nodeIds: ['p/a/typed.ts'],
      hasTypeCovered: true,
    };
    const out = renderStructure(graph, NO_DETECTED, widened);
    expect(out).toContain('p/a → p/a/typed.ts — jumps 1 level across the tree, no declared contract');
    // The jargon-free-language rule: a type-covered file is never called a "component".
    expect(out).toContain('From an average component or type-covered file,');
    expect(out).not.toMatch(/From an average component,/);
  });

  it('a type-covered file edge that sits many directories deep on disk never outranks a genuine cross-module node tunnel', () => {
    // The real architecture has exactly one genuine cross-module dependency: checkout/controller
    // -> orders/service, spanning 4 hierarchy levels (mirrors the earlier "names cross-tree
    // tunnels" test above). The widening adds an edge between two type-covered files that share
    // no real ancestor and sit six/five directories deep — raw directory-segment math would rank
    // that edge (span 9) ahead of the real tunnel (span 4); it must not.
    const graph = graphOf([
      node('checkout'),
      node('checkout/controller', [{ target: 'orders/service', type: 'uses' }]),
      node('orders'),
      node('orders/service'),
    ]);
    const widened = {
      edges: [{ from: 'src/a/b/c/d/e/p.ts', to: 'lib/q.ts', viaContract: false, origin: 'detected' as const }],
      nodeIds: ['src/a/b/c/d/e/p.ts', 'lib/q.ts'],
      hasTypeCovered: true,
    };
    const out = renderStructure(graph, NO_DETECTED, widened);
    const tunnelsSection = out.slice(out.indexOf('Tunnels'), out.indexOf('Modules'));
    const realIdx = tunnelsSection.indexOf('checkout/controller → orders/service');
    const fileIdx = tunnelsSection.indexOf('src/a/b/c/d/e/p.ts → lib/q.ts');
    expect(realIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    // The real architectural tunnel is listed FIRST — its span (4) outranks the file
    // edge's span (2, bounded regardless of how deep the two files sit on disk).
    expect(realIdx).toBeLessThan(fileIdx);
    expect(tunnelsSection).toContain('checkout/controller → orders/service — jumps 4 levels across the tree');
    expect(tunnelsSection).toContain('src/a/b/c/d/e/p.ts → lib/q.ts — jumps 2 levels across the tree');
  });

  it('renderModules calls the header "component groups" flag-off, and widens the wording once a type-covered file joins a group — never a file called a component', () => {
    const graph = graphOf([
      node('x'),
      node('x/svc', [{ target: 'y/svc', type: 'calls' }]),
      node('y'),
      node('y/svc'),
    ]);
    const flagOff = renderStructure(graph, NO_DETECTED);
    expect(flagOff).toContain('Modules — how component groups at each level depend on one another');

    const widened = {
      edges: [{ from: 'x/svc', to: 'x/svc/typed.ts', viaContract: false, origin: 'detected' as const }],
      nodeIds: ['x/svc/typed.ts'],
      hasTypeCovered: true,
    };
    const flagOn = renderStructure(graph, NO_DETECTED, widened);
    expect(flagOn).toContain('Modules — how groups of components and type-covered files at each level depend on one another');
    expect(flagOn).not.toContain('Modules — how component groups at each level depend on one another');
  });
});

// The authoritative structural-edge-universe accessor, exercised end-to-end
// against a REAL on-disk fixture project (copied to a temp dir so the relation
// pass's cache never touches the committed fixture). It is the same universe the
// `yg structure` command assembles; its correctness here is what keeps an offline
// structural report from ever drifting from the dashboard.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/sample-project',
);

describe.skipIf(!existsSync(FIXTURE))('computeStructuralEdgeUniverse (real fixture)', () => {
  it('returns the declared structural edges ∪ detected edges over the fixture node ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-edge-universe-'));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      const { nodeIds, edges } = await computeStructuralEdgeUniverse(dir);

      // The fixture's nodes are all present.
      for (const id of [
        'checkout/controller',
        'orders/order-service',
        'auth/auth-api',
        'users/user-repo',
      ]) {
        expect(nodeIds).toContain(id);
      }

      // Every edge endpoint is a known node (the universe is closed over nodeIds).
      const idSet = new Set(nodeIds);
      for (const e of edges) {
        expect(idSet.has(e.from)).toBe(true);
        expect(idSet.has(e.to)).toBe(true);
      }

      // The declared structural relations are present (independent of whether the
      // detected-edge pass contributes anything on this host).
      const has = (from: string, to: string) =>
        edges.some((e) => e.from === from && e.to === to);
      expect(has('checkout/controller', 'orders/order-service')).toBe(true);
      expect(has('orders/order-service', 'auth/auth-api')).toBe(true);
      expect(has('orders/order-service', 'users/user-repo')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const RELATION_GATE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/type-relation-gate',
);

describe.skipIf(!existsSync(RELATION_GATE_FIXTURE))('computeStructuralEdgeUniverse — type-level widening', () => {
  it('a type-covered file joins nodeIds (own file path) and its real edges join the universe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-edge-universe-typecov-'));
    try {
      cpSync(RELATION_GATE_FIXTURE, dir, { recursive: true });
      const { nodeIds, edges } = await computeStructuralEdgeUniverse(dir);

      expect(nodeIds).toContain('owner');
      expect(nodeIds).toContain('src/svc/handler.ts');
      expect(nodeIds).toContain('src/util/plain-util.ts');
      // The ambiguous file is never classified into `covered` — it never joins nodeIds.
      expect(nodeIds).not.toContain('src/svc/ambiguous.ts');

      const has = (from: string, to: string) => edges.some((e) => e.from === from && e.to === to);
      expect(has('src/svc/handler.ts', 'owner')).toBe(true);
      expect(has('src/svc/handler.ts', 'src/util/plain-util.ts')).toBe(true);
      expect(has('src/util/plain-util.ts', 'owner')).toBe(true);
      // Every edge endpoint is a known id — the universe stays closed over nodeIds.
      const idSet = new Set(nodeIds);
      for (const e of edges) {
        expect(idSet.has(e.from)).toBe(true);
        expect(idSet.has(e.to)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cyclePhrase — cycle-share floor', () => {
  it('never rounds a NONZERO cycle share down to "0%"; a sub-1% share reads "<1%"', () => {
    // 332 of 333 crossings flow one way → a 1/333 ≈ 0.3% cycle share. Rounding
    // gives 0, but a real cycle exists, so it must read "<1%", never "0%".
    const phrase = cyclePhrase(333, 332 / 333);
    expect(phrase).toContain('<1% of the dependencies between groups are part of a cycle');
    expect(phrase).not.toMatch(/\b0% of the dependencies/);
  });

  it('only an EXACT-zero cycle share (all crossings one way) says "flow one way (no cycles)"', () => {
    expect(cyclePhrase(10, 1)).toBe('All dependencies between groups flow one way (no cycles).');
  });

  it('a share at or above the rounding threshold renders its rounded whole percent', () => {
    // 0.6% cycle share rounds up to 1%.
    expect(cyclePhrase(1000, 0.994)).toContain('1% of the dependencies between groups are part of a cycle');
    // A clear cycle majority rounds normally.
    expect(cyclePhrase(4, 0.5)).toContain('50% of the dependencies between groups are part of a cycle');
  });

  it('reports no dependencies when there are no crossings', () => {
    expect(cyclePhrase(0, 0)).toBe('No dependencies between these groups.');
  });
});
