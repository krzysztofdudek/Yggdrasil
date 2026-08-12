import { describe, it, expect } from 'vitest';
import {
  impliesClosure,
  buildReverseTargetIndex,
  collectFlowParticipants,
} from '../../../src/core/progressive-scope.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';

// --- Helpers (mirrors tests/unit/core/effective-aspects.test.ts's construction style) ---

function makeNode(
  path: string,
  overrides: Partial<GraphNode> & { meta?: Partial<GraphNode['meta']> } = {},
): GraphNode {
  return {
    path,
    meta: { name: path, type: 'library', ...overrides.meta },
    children: [],
    parent: overrides.parent ?? null,
    ...overrides,
  } as GraphNode;
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath: '/tmp',
    ...overrides,
  } as Graph;
}

function makeAspect(id: string, overrides: Partial<AspectDef> = {}): AspectDef {
  return { name: id, id, reviewer: { type: 'llm' as const }, artifacts: [], ...overrides };
}

// --- impliesClosure ---

describe('impliesClosure', () => {
  it('walks an implies chain a -> b -> c and contains all three', () => {
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'] }),
        makeAspect('b', { implies: ['c'] }),
        makeAspect('c'),
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b', 'c']));
  });

  it('terminates on a cycle instead of looping forever', () => {
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'] }),
        makeAspect('b', { implies: ['c'] }),
        makeAspect('c', { implies: ['a'] }), // closes the cycle back to a
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b', 'c']));
  });

  it('is unconditional: ignores when/status entirely (no node/graph filtering applies)', () => {
    // A draft-status implier still propagates for this structural closure —
    // unlike computeEffectiveAspectStatuses/expandImpliesFiltered, which would
    // stop a draft aspect from propagating its implied aspects.
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'], status: 'draft' }),
        makeAspect('b'),
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b']));
  });

  it('returns just the seed id when it implies nothing', () => {
    const graph = makeGraph({ aspects: [makeAspect('solo')] });
    expect(impliesClosure('solo', graph)).toEqual(new Set(['solo']));
  });

  it('returns just the seed id when the aspect id is unknown to the graph', () => {
    const graph = makeGraph({ aspects: [] });
    expect(impliesClosure('ghost', graph)).toEqual(new Set(['ghost']));
  });
});

// --- buildReverseTargetIndex ---

describe('buildReverseTargetIndex', () => {
  it('maps a target to every node with ANY relation to it — port-consumer and plain uses alike', () => {
    const target = makeNode('payments', { meta: { name: 'payments', type: 'library' } });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders',
        type: 'library',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const plainUser = makeNode('reports', {
      meta: {
        name: 'reports',
        type: 'library',
        relations: [{ target: 'payments', type: 'uses' }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([
        ['payments', target],
        ['orders', consumer],
        ['reports', plainUser],
      ]),
    });
    const index = buildReverseTargetIndex(graph);
    expect(index.get('payments')).toEqual(['orders', 'reports']);
  });

  it('a node with no relations contributes nothing to the index', () => {
    const lonely = makeNode('lonely');
    const graph = makeGraph({ nodes: new Map([['lonely', lonely]]) });
    const index = buildReverseTargetIndex(graph);
    expect(index.size).toBe(0);
  });

  it('a target with no incoming relations is simply absent from the index', () => {
    const target = makeNode('target');
    const graph = makeGraph({ nodes: new Map([['target', target]]) });
    const index = buildReverseTargetIndex(graph);
    expect(index.has('target')).toBe(false);
  });
});

// --- collectFlowParticipants ---

describe('collectFlowParticipants', () => {
  it('includes a declared participant and its descendants', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'library' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'library' } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([
        ['mod', parent],
        ['mod/svc', child],
      ]),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['mod'] }],
    });
    const result = collectFlowParticipants(graph, 'Checkout');
    expect(result).toEqual(new Set(['mod', 'mod/svc']));
  });

  it('matches a flow by its path when the name does not match', () => {
    const node = makeNode('svc');
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      flows: [{ path: 'checkout-flow', name: 'Checkout', nodes: ['svc'] }],
    });
    const result = collectFlowParticipants(graph, 'checkout-flow');
    expect(result).toEqual(new Set(['svc']));
  });

  it('returns an empty set for an unknown flow name', () => {
    const graph = makeGraph({ flows: [] });
    expect(collectFlowParticipants(graph, 'nope')).toEqual(new Set());
  });

  it('skips a declared node path that is not in the graph (dangling reference)', () => {
    const graph = makeGraph({
      nodes: new Map(),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['ghost'] }],
    });
    expect(collectFlowParticipants(graph, 'Checkout')).toEqual(new Set());
  });
});
