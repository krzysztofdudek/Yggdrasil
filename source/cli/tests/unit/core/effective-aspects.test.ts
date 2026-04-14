import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  getAspectSource,
} from '../../../src/core/effective-aspects.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

// --- Helpers ---

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
    schemas: [],
    rootPath: '/tmp',
    ...overrides,
  } as Graph;
}

// --- computeEffectiveAspects ---

describe('computeEffectiveAspects', () => {
  it('1. own aspects only', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['auth'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toEqual(new Set(['auth']));
  });

  it('2. parent node has direct aspect -> child inherits', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['parent-aspect'] } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    parent.children = [child];
    const graph = makeGraph({ nodes: new Map([['mod', parent], ['mod/svc', child]]) });
    const result = computeEffectiveAspects(child, graph);
    expect(result).toContain('parent-aspect');
  });

  it('3. grandparent aspect -> grandchild inherits (recursive)', () => {
    const grandparent = makeNode('root', { meta: { name: 'root', type: 'module', aspects: ['gp-aspect'] } });
    const parent = makeNode('root/mid', { parent: grandparent, meta: { name: 'mid', type: 'module' } });
    grandparent.children = [parent];
    const child = makeNode('root/mid/leaf', { parent, meta: { name: 'leaf', type: 'service' } });
    parent.children = [child];
    const graph = makeGraph({ nodes: new Map([['root', grandparent], ['root/mid', parent], ['root/mid/leaf', child]]) });
    const result = computeEffectiveAspects(child, graph);
    expect(result).toContain('gp-aspect');
  });

  it('4. own type has default aspect in architecture', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['requires-auth'] } } },
    });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toContain('requires-auth');
  });

  it('5. parent type has default aspect in architecture', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      architecture: {
        node_types: {
          module: { description: 'mod', aspects: ['module-aspect'] },
          service: { description: 'svc' },
        },
      },
    });
    const result = computeEffectiveAspects(child, graph);
    expect(result).toContain('module-aspect');
  });

  it('6. flow participation -> flow aspects included', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['svc'], aspects: ['transactional'] }],
    });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toContain('transactional');
  });

  it('7. ancestor participates in flow -> descendant inherits flow aspects', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['mod'], aspects: ['transactional'] }],
    });
    const result = computeEffectiveAspects(child, graph);
    expect(result).toContain('transactional');
  });

  it('8. port consumption -> port required aspects included', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['correlation-tracking', 'idempotency'] } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [
        { name: 'CT', id: 'correlation-tracking', artifacts: [] },
        { name: 'IK', id: 'idempotency', artifacts: [] },
      ],
    });
    const result = computeEffectiveAspects(consumer, graph);
    expect(result).toContain('correlation-tracking');
    expect(result).toContain('idempotency');
  });

  it('9. implies chain -> expanded (A implies B implies C -> all three)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        { name: 'A', id: 'a', implies: ['b'], artifacts: [] },
        { name: 'B', id: 'b', implies: ['c'], artifacts: [] },
        { name: 'C', id: 'c', artifacts: [] },
      ],
    });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toEqual(new Set(['a', 'b', 'c']));
  });

  it('10. implies cycle -> throws error', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        { name: 'A', id: 'a', implies: ['b'], artifacts: [] },
        { name: 'B', id: 'b', implies: ['c'], artifacts: [] },
        { name: 'C', id: 'c', implies: ['a'], artifacts: [] },
      ],
    });
    expect(() => computeEffectiveAspects(node, graph)).toThrow('Aspect implies cycle detected');
  });

  it('11. all channels active -> union of all', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['parent-aspect'] },
    });
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['port-aspect'] } },
      },
    });
    const node = makeNode('mod/svc', {
      parent,
      meta: {
        name: 'svc', type: 'service',
        aspects: ['own-aspect'],
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    parent.children = [node];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', node], ['payments', target]]),
      architecture: {
        node_types: {
          service: { description: 'svc', aspects: ['arch-aspect'] },
          module: { description: 'mod', aspects: ['mod-arch-aspect'] },
        },
      },
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['mod/svc'], aspects: ['flow-aspect'] }],
      aspects: [
        { name: 'Own', id: 'own-aspect', implies: ['implied-aspect'], artifacts: [] },
        { name: 'Parent', id: 'parent-aspect', artifacts: [] },
        { name: 'Arch', id: 'arch-aspect', artifacts: [] },
        { name: 'ModArch', id: 'mod-arch-aspect', artifacts: [] },
        { name: 'Flow', id: 'flow-aspect', artifacts: [] },
        { name: 'Port', id: 'port-aspect', artifacts: [] },
        { name: 'Implied', id: 'implied-aspect', artifacts: [] },
      ],
    });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toEqual(new Set([
      'own-aspect', 'parent-aspect', 'arch-aspect', 'mod-arch-aspect',
      'flow-aspect', 'port-aspect', 'implied-aspect',
    ]));
  });

  it('12. empty node -> empty set', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    const result = computeEffectiveAspects(node, graph);
    expect(result.size).toBe(0);
  });

  it('13. deduplication -- same aspect from multiple channels -> appears once', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['shared'] },
    });
    const node = makeNode('mod/svc', {
      parent,
      meta: { name: 'svc', type: 'service', aspects: ['shared'] },
    });
    parent.children = [node];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', node]]),
      flows: [{ path: 'f', name: 'F', nodes: ['mod/svc'], aspects: ['shared'] }],
      aspects: [{ name: 'Shared', id: 'shared', artifacts: [] }],
    });
    const result = computeEffectiveAspects(node, graph);
    expect([...result]).toEqual(['shared']);
  });

  it('handles diamond dependency in implies chain', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['top'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        { name: 'Top', id: 'top', implies: ['left', 'right'], artifacts: [] },
        { name: 'Left', id: 'left', implies: ['bottom'], artifacts: [] },
        { name: 'Right', id: 'right', implies: ['bottom'], artifacts: [] },
        { name: 'Bottom', id: 'bottom', artifacts: [] },
      ],
    });
    const result = computeEffectiveAspects(node, graph);
    expect(result).toEqual(new Set(['top', 'left', 'right', 'bottom']));
  });

  it('handles missing target node gracefully for port consumption', () => {
    const node = makeNode('svc', {
      meta: {
        name: 'svc', type: 'service',
        relations: [{ target: 'nonexistent', type: 'calls', consumes: ['charge'] }],
      },
    });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    const result = computeEffectiveAspects(node, graph);
    expect(result.size).toBe(0);
  });

  it('skips consumed ports that do not exist on target', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['ct'] } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge', 'nonexistent'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [{ name: 'CT', id: 'ct', artifacts: [] }],
    });
    const result = computeEffectiveAspects(consumer, graph);
    expect(result).toEqual(new Set(['ct']));
  });

  it('handles relations without consumes field', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['ct'] } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [{ target: 'payments', type: 'calls' }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
    });
    const result = computeEffectiveAspects(consumer, graph);
    expect(result.size).toBe(0);
  });

  it('handles multiple consumed ports from same target', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: { description: 'Charge', aspects: ['ct'] },
          refund: { description: 'Refund', aspects: ['idempotency'] },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge', 'refund'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [
        { name: 'CT', id: 'ct', artifacts: [] },
        { name: 'IK', id: 'idempotency', artifacts: [] },
      ],
    });
    const result = computeEffectiveAspects(consumer, graph);
    expect(result).toContain('ct');
    expect(result).toContain('idempotency');
  });

  it('handles no architecture gracefully', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['own'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [{ name: 'Own', id: 'own', artifacts: [] }],
    });
    // Remove architecture
    (graph as any).architecture = undefined;
    const result = computeEffectiveAspects(node, graph);
    expect(result).toEqual(new Set(['own']));
  });
});

// --- getAspectSource ---

describe('getAspectSource', () => {
  it('1. own declaration', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['auth'] } });
    const graph = makeGraph();
    expect(getAspectSource('auth', node, graph)).toBe('own declaration');
  });

  it('2. inherited from parent node', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['parent-aspect'] } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getAspectSource('parent-aspect', child, graph)).toBe("inherited from parent 'mod'");
  });

  it('3. architecture type (own)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: { node_types: { service: { description: 'svc', aspects: ['auth'] } } },
    });
    expect(getAspectSource('auth', node, graph)).toBe('architecture (type: service)');
  });

  it('4. architecture type (ancestor)', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: {
          module: { description: 'mod', aspects: ['mod-aspect'] },
          service: { description: 'svc' },
        },
      },
    });
    expect(getAspectSource('mod-aspect', child, graph)).toBe('inherited from parent (type: module)');
  });

  it('5. flow participation (direct)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['svc'], aspects: ['transactional'] }],
    });
    expect(getAspectSource('transactional', node, graph)).toBe("flow 'checkout'");
  });

  it('6. flow participation (via ancestor)', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['mod'], aspects: ['transactional'] }],
    });
    expect(getAspectSource('transactional', child, graph)).toBe("flow 'checkout' (via parent 'mod')");
  });

  it('7. port consumption', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['ct'] } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
    });
    expect(getAspectSource('ct', consumer, graph)).toBe("port 'charge' on 'payments'");
  });

  it('8. implied aspect', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      aspects: [
        { name: 'Parent', id: 'parent-aspect', implies: ['child-aspect'], artifacts: [] },
        { name: 'Child', id: 'child-aspect', artifacts: [] },
      ],
    });
    expect(getAspectSource('child-aspect', node, graph)).toBe("implied by 'parent-aspect'");
  });

  it('9. unknown source', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getAspectSource('nonexistent', node, graph)).toBe('unknown source');
  });

  it('prioritizes own declaration over architecture', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['auth'] } });
    const graph = makeGraph({
      architecture: { node_types: { service: { description: 'svc', aspects: ['auth'] } } },
    });
    // Own should win because it's checked first
    expect(getAspectSource('auth', node, graph)).toBe('own declaration');
  });
});
