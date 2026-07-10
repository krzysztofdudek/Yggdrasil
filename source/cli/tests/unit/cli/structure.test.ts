import { describe, it, expect } from 'vitest';
import type { Graph, GraphNode, Relation } from '../../../src/model/graph.js';
import { renderStructure } from '../../../src/cli/structure.js';

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
});
