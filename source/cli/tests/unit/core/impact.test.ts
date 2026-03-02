import { describe, it, expect } from 'vitest';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectDescendants,
} from '../../../src/cli/impact.js';
import { collectEffectiveAspectIds } from '../../../src/core/context-builder.js';
import type { Graph, GraphNode } from '../../../src/model/types.js';

function makeNode(nodePath: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop()!, type: 'service' },
    artifacts: [],
    children: [],
    parent: null,
    ...overrides,
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  return {
    config: {
      name: 'Test',
      stack: {},
      standards: '',
      node_types: [{ name: 'service' }],
      artifacts: {},
    },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: '/tmp',
  };
}

describe('collectReverseDependents', () => {
  it('returns empty when no nodes depend on target', () => {
    const target = makeNode('a');
    const graph = makeGraph([target]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
    expect(result.allDependents).toEqual([]);
  });

  it('finds direct dependents via structural relations', () => {
    const target = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const graph = makeGraph([target, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b']);
  });

  it('finds transitive dependents', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toContain('b');
    expect(result.allDependents).toContain('c');
  });

  it('handles diamond dependency without duplication', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [
          { target: 'a', type: 'uses' },
          { target: 'b', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b', 'c']);
    expect(new Set(result.allDependents).size).toBe(result.allDependents.length);
  });

  it('ignores event relations (emits/listens)', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'emits' }],
      },
    });
    const graph = makeGraph([a, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
  });
});

describe('buildTransitiveChains', () => {
  it('chains do NOT include the target node', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains.length).toBe(1);
    expect(chains[0]).not.toContain('<- a');
    expect(chains[0]).toBe('<- b <- c');
  });

  it('returns empty when no transitive-only deps', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains).toEqual([]);
  });
});

describe('collectDescendants', () => {
  it('returns all descendants of a parent node', () => {
    const parent = makeNode('mod');
    const child1 = makeNode('mod/a', { parent });
    const child2 = makeNode('mod/b', { parent });
    const grandchild = makeNode('mod/a/x', { parent: child1 });
    parent.children = [child1, child2];
    child1.children = [grandchild];
    const graph = makeGraph([parent, child1, child2, grandchild]);
    const result = collectDescendants(graph, 'mod');
    expect(result.sort()).toEqual(['mod/a', 'mod/a/x', 'mod/b']);
  });

  it('returns empty for leaf node', () => {
    const leaf = makeNode('leaf');
    const graph = makeGraph([leaf]);
    expect(collectDescendants(graph, 'leaf')).toEqual([]);
  });
});

describe('collectEffectiveAspectIds', () => {
  it('collects own aspects', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['tag-a'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [{ name: 'A', id: 'tag-a', artifacts: [] }];
    const result = collectEffectiveAspectIds(graph, 'a');
    expect([...result]).toEqual(['tag-a']);
  });

  it('collects hierarchy aspects from parent', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['tag-parent'] },
    });
    const child = makeNode('mod/svc', { parent });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'P', id: 'tag-parent', artifacts: [] }];
    const result = collectEffectiveAspectIds(graph, 'mod/svc');
    expect([...result]).toContain('tag-parent');
  });

  it('collects flow aspects', () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    graph.aspects = [{ name: 'Saga', id: 'requires-saga', artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['a'],
      aspects: ['requires-saga'], artifacts: [],
    }];
    const result = collectEffectiveAspectIds(graph, 'a');
    expect([...result]).toContain('requires-saga');
  });

  it('expands implies recursively', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['tag-a'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [
      { name: 'A', id: 'tag-a', implies: ['tag-b'], artifacts: [] },
      { name: 'B', id: 'tag-b', artifacts: [] },
    ];
    const result = collectEffectiveAspectIds(graph, 'a');
    expect([...result]).toContain('tag-a');
    expect([...result]).toContain('tag-b');
  });

  it('collects flow aspects via ancestor participation', () => {
    const parent = makeNode('mod');
    const child = makeNode('mod/svc', { parent });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'Saga', id: 'requires-saga', artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod'],
      aspects: ['requires-saga'], artifacts: [],
    }];
    const result = collectEffectiveAspectIds(graph, 'mod/svc');
    expect([...result]).toContain('requires-saga');
  });

  it('expands multi-level implies chains', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['hipaa'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [
      { name: 'HIPAA', id: 'hipaa', implies: ['audit'], artifacts: [] },
      { name: 'Audit', id: 'audit', implies: ['logging'], artifacts: [] },
      { name: 'Logging', id: 'logging', artifacts: [] },
    ];
    const result = collectEffectiveAspectIds(graph, 'a');
    expect([...result]).toContain('hipaa');
    expect([...result]).toContain('audit');
    expect([...result]).toContain('logging');
  });

  it('combines own + hierarchy + flow + implies into effective set', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['parent-aspect'] },
    });
    const child = makeNode('mod/svc', {
      parent,
      meta: { name: 'svc', type: 'service', aspects: ['own-aspect'] },
    });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [
      { name: 'Own', id: 'own-aspect', implies: ['implied-aspect'], artifacts: [] },
      { name: 'Parent', id: 'parent-aspect', artifacts: [] },
      { name: 'Flow', id: 'flow-aspect', artifacts: [] },
      { name: 'Implied', id: 'implied-aspect', artifacts: [] },
    ];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod/svc'],
      aspects: ['flow-aspect'], artifacts: [],
    }];
    const result = collectEffectiveAspectIds(graph, 'mod/svc');
    expect([...result]).toContain('own-aspect');
    expect([...result]).toContain('parent-aspect');
    expect([...result]).toContain('flow-aspect');
    expect([...result]).toContain('implied-aspect');
    expect(result.size).toBe(4);
  });

  it('returns empty set for node with no aspects, no hierarchy aspects, no flows', () => {
    const node = makeNode('isolated');
    const graph = makeGraph([node]);
    const result = collectEffectiveAspectIds(graph, 'isolated');
    expect(result.size).toBe(0);
  });

  it('deduplicates aspects from multiple sources', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['shared'] },
    });
    const child = makeNode('mod/svc', {
      parent,
      meta: { name: 'svc', type: 'service', aspects: ['shared'] },
    });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'Shared', id: 'shared', artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod/svc'],
      aspects: ['shared'], artifacts: [],
    }];
    const result = collectEffectiveAspectIds(graph, 'mod/svc');
    expect([...result]).toEqual(['shared']);
  });
});

describe('co-aspect nodes detection', () => {
  it('finds nodes sharing aspects via effective aspect set', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['audit'] },
    });
    const b = makeNode('svc-b', {
      meta: { name: 'svc-b', type: 'service', aspects: ['audit'] },
    });
    const c = makeNode('svc-c', {
      meta: { name: 'svc-c', type: 'service' },
    });
    const graph = makeGraph([a, b, c]);
    graph.aspects = [{ name: 'Audit', id: 'audit', artifacts: [] }];

    const targetEffective = collectEffectiveAspectIds(graph, 'svc-a');
    const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
    for (const [p] of graph.nodes) {
      if (p === 'svc-a') continue;
      const nodeEffective = collectEffectiveAspectIds(graph, p);
      const shared = [...targetEffective].filter((id) => nodeEffective.has(id));
      if (shared.length > 0) {
        coAspectNodes.push({ path: p, shared });
      }
    }
    expect(coAspectNodes).toHaveLength(1);
    expect(coAspectNodes[0].path).toBe('svc-b');
    expect(coAspectNodes[0].shared).toEqual(['audit']);
  });

  it('detects co-aspect via implies chain', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['hipaa'] },
    });
    const b = makeNode('svc-b', {
      meta: { name: 'svc-b', type: 'service', aspects: ['audit'] },
    });
    const graph = makeGraph([a, b]);
    graph.aspects = [
      { name: 'HIPAA', id: 'hipaa', implies: ['audit'], artifacts: [] },
      { name: 'Audit', id: 'audit', artifacts: [] },
    ];

    const targetEffective = collectEffectiveAspectIds(graph, 'svc-a');
    expect(targetEffective.has('audit')).toBe(true);

    const bEffective = collectEffectiveAspectIds(graph, 'svc-b');
    const shared = [...targetEffective].filter((id) => bEffective.has(id));
    expect(shared).toContain('audit');
  });

  it('detects co-aspect via flow propagation', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['logging'] },
    });
    const b = makeNode('svc-b');
    const graph = makeGraph([a, b]);
    graph.aspects = [{ name: 'Logging', id: 'logging', artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['svc-b'],
      aspects: ['logging'], artifacts: [],
    }];

    const aEffective = collectEffectiveAspectIds(graph, 'svc-a');
    const bEffective = collectEffectiveAspectIds(graph, 'svc-b');
    const shared = [...aEffective].filter((id) => bEffective.has(id));
    expect(shared).toContain('logging');
  });
});
