import { describe, it, expect } from 'vitest';
import type { Graph, AspectDef, GraphNode } from '../../../src/model/graph.js';
import { computeAspectUsage, formatAspectsOutput } from '../../../src/cli/aspects.js';

function makeAspect(id: string, overrides: Partial<AspectDef> = {}): AspectDef {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `Description of ${id}`,
    artifacts: [],
    ...overrides,
  };
}

function makeNode(
  path: string,
  aspects: string[] = [],
  type: string = 'module',
): GraphNode {
  return {
    path,
    meta: {
      name: path.split('/').pop() || path,
      type,
      aspects,
    },
    artifacts: [],
    children: [],
    parent: null,
  };
}

function makeGraph(aspects: AspectDef[], nodes: GraphNode[] = []): Graph {
  const nodesMap = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodesMap.set(node.path, node);
  }

  return {
    rootPath: '/fake',
    config: { version: '1' },
    architecture: {
      node_types: {
        module: { description: 'Module', aspects: [] },
      },
    },
    nodes: nodesMap,
    aspects,
    flows: [],
    schemas: [],
  } as Graph;
}

describe('computeAspectUsage', () => {
  it('counts zero usage for orphaned aspect', () => {
    const graph = makeGraph([makeAspect('deterministic')]);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(0);
  });

  it('counts own declaration usage', () => {
    const nodes = [makeNode('cli/core', ['deterministic'])];
    const graph = makeGraph([makeAspect('deterministic')], nodes);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(1);
    expect(usage.get('deterministic')?.own).toBe(1);
  });

  it('counts multiple nodes using same aspect', () => {
    const nodes = [
      makeNode('cli/core', ['deterministic']),
      makeNode('cli/commands', ['deterministic']),
    ];
    const graph = makeGraph([makeAspect('deterministic')], nodes);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(2);
    expect(usage.get('deterministic')?.own).toBe(2);
  });

  it('counts multiple aspect sources separately', () => {
    const nodes = [
      makeNode('cli/own', ['own-aspect']),
      makeNode('cli/flow', []),
    ];
    const graph = makeGraph(
      [makeAspect('own-aspect'), makeAspect('flow-aspect')],
      nodes,
    );
    graph.flows = [
      {
        path: 'test-flow',
        name: 'Test Flow',
        nodes: ['cli/flow'],
        aspects: ['flow-aspect'],
        artifacts: [],
      },
    ];
    const usage = computeAspectUsage(graph);
    expect(usage.get('own-aspect')?.own).toBe(1);
    expect(usage.get('flow-aspect')?.flow).toBe(1);
  });

});

describe('formatAspectsOutput', () => {
  it('shows usage stats per aspect', () => {
    const aspects = [makeAspect('deterministic')];
    const nodes = [makeNode('cli/core', ['deterministic'])];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('deterministic');
    expect(output).toContain('Used by:');
  });

  it('shows orphaned label for unused aspect', () => {
    const aspects = [makeAspect('unused-aspect')];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('orphaned');
  });

  it('shows implies when present', () => {
    const aspects = [makeAspect('parent-aspect', { implies: ['child-aspect'] })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Implies: child-aspect');
  });

  it('handles aspect with no description', () => {
    const aspects = [makeAspect('bare', { description: undefined })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('bare');
    expect(output).not.toContain('undefined');
  });

  it('shows multiple nodes count', () => {
    const aspects = [makeAspect('shared')];
    const nodes = [
      makeNode('cli/core', ['shared']),
      makeNode('cli/commands', ['shared']),
      makeNode('cli/utils', ['shared']),
    ];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Used by: 3 nodes');
  });

  it('shows single node count correctly', () => {
    const aspects = [makeAspect('single')];
    const nodes = [makeNode('cli/core', ['single'])];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Used by: 1 node');
  });
});
