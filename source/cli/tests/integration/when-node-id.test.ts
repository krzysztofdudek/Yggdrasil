import { describe, it, expect } from 'vitest';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef } from '../../src/model/graph.js';

// ----------------------------------------------------------------------------
// `node: { id }` under `not:` — excluding one child from a parent-attached
// aspect without removing the child from the parent. Pure functions, in-memory
// graph (parent + two children), matching the style of tests/unit/bounty/eff-when.test.ts.
// ----------------------------------------------------------------------------

function makeNode(
  path: string,
  overrides: Partial<GraphNode> & { meta?: Partial<GraphNode['meta']> } = {},
): GraphNode {
  return {
    path,
    meta: { name: path, type: 'service', ...overrides.meta },
    children: [],
    parent: overrides.parent ?? null,
    ...overrides,
  } as GraphNode;
}

function aspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    reviewer: { type: 'llm' as const },
    artifacts: [],
    ...extra,
  } as AspectDef;
}

function buildFamily(extraAspectFields: Partial<AspectDef> = {}) {
  const parent = makeNode('svc', { meta: { name: 'svc', type: 'module', aspects: ['a'] } });
  const childA = makeNode('svc/a', { parent, meta: { name: 'a', type: 'service' } });
  const childB = makeNode('svc/b', { parent, meta: { name: 'b', type: 'service' } });
  parent.children = [childA, childB];
  const graph: Graph = {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map([['svc', parent], ['svc/a', childA], ['svc/b', childB]]),
    aspects: [aspect('a', extraAspectFields)],
    flows: [],
    rootPath: '/tmp',
  } as Graph;
  return { parent, childA, childB, graph };
}

describe('when: node.id — excluding one named child from a parent-attached aspect', () => {
  it('computeEffectiveAspects: effective on parent and child B, not on child A', () => {
    const { parent, childA, childB, graph } = buildFamily({
      when: { not: { node: { id: 'svc/a' } } },
    });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    expect(computeEffectiveAspects(childB, graph).has('a')).toBe(true);
    expect(computeEffectiveAspects(childA, graph).has('a')).toBe(false);
  });

  it('computeEffectiveAspectStatuses agrees with computeEffectiveAspects', () => {
    const { parent, childA, childB, graph } = buildFamily({
      when: { not: { node: { id: 'svc/a' } } },
    });
    expect(computeEffectiveAspectStatuses(parent, graph).has('a')).toBe(true);
    expect(computeEffectiveAspectStatuses(childB, graph).has('a')).toBe(true);
    expect(computeEffectiveAspectStatuses(childA, graph).has('a')).toBe(false);
  });

  it('control: the same aspect with no when is effective on the whole trio', () => {
    const { parent, childA, childB, graph } = buildFamily();
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    expect(computeEffectiveAspects(childA, graph).has('a')).toBe(true);
    expect(computeEffectiveAspects(childB, graph).has('a')).toBe(true);
  });

  it('node.id list excludes exactly the named children', () => {
    const { parent, childA, childB, graph } = buildFamily({
      when: { not: { node: { id: ['svc/a', 'svc/b'] } } },
    });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    expect(computeEffectiveAspects(childA, graph).has('a')).toBe(false);
    expect(computeEffectiveAspects(childB, graph).has('a')).toBe(false);
  });
});
