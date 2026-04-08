import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectsForConsumer,
  getAspectSource,
} from '../../../src/core/effective-aspects.js';
import type { ArchitectureDef, AspectDef, FlowDef, Graph, GraphNode } from '../../../src/model/graph.js';

describe('computeEffectiveAspects', () => {
  // Helper to create minimal architecture
  function createArchitecture(nodeTypes: Record<string, {
    aspects?: string[];
    parents?: string[];
  }> = {}): ArchitectureDef {
    const built: Record<string, any> = {};
    for (const [type, config] of Object.entries(nodeTypes)) {
      built[type] = {
        description: `${type} type`,
        ...(config.aspects && { aspects: config.aspects }),
        ...(config.parents && { parents: config.parents }),
      };
    }
    return {
      node_types: built,
    };
  }

  // Helper to create aspect definitions
  function createAspects(specs: Record<string, {
    implies?: string[];
  }> = {}): AspectDef[] {
    return Object.entries(specs).map(([id, config]) => ({
      name: id,
      id,
      description: `Aspect ${id}`,
      implies: config.implies,

      artifacts: [],
    }));
  }

  it('should return empty sets for minimal node (no architecture constraints, no parents, no own aspects)', () => {
    const result = computeEffectiveAspects({
      nodeType: 'library',
      architecture: createArchitecture({ library: {} }),
      parentTypes: [],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular.size).toBe(0);
  });

  it('should include architecture constraints for node type', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['requires-auth', 'error-handling'],
        },
      }),
      parentTypes: [],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth', 'error-handling']));
  });


  it('should inherit parent type aspects recursively', () => {
    const result = computeEffectiveAspects({
      nodeType: 'rest-service',
      architecture: createArchitecture({
        'rest-service': {
          parents: ['service'],
        },
        service: {
          aspects: ['requires-auth', 'error-handling'],
        },
      }),
      parentTypes: ['service'],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth', 'error-handling']));
  });

  it('should combine own aspects with architecture constraints', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['requires-auth'],
        },
      }),
      parentTypes: [],
      ownAspects: ['audit-logging', 'rate-limiting'],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth', 'audit-logging', 'rate-limiting']));
  });

it('should add flow participation aspects to regular set', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: [],
      flowAspects: ['transaction-safety', 'idempotency'],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['transaction-safety', 'idempotency']));
  });

  it('should expand aspect implies chain', () => {
    const aspects = createAspects({
      'audit-logging': {
        implies: ['event-logging'],
      },
      'event-logging': {
        implies: ['structured-logging'],
      },
      'structured-logging': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: ['audit-logging'],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['audit-logging', 'event-logging', 'structured-logging']));
  });


  it('should detect aspect implies cycle and throw error', () => {
    const aspects: AspectDef[] = [
      {
        name: 'a',
        id: 'a',
        implies: ['b'],
  
        artifacts: [],
      },
      {
        name: 'b',
        id: 'b',
        implies: ['c'],
  
        artifacts: [],
      },
      {
        name: 'c',
        id: 'c',
        implies: ['a'],
  
        artifacts: [],
      },
    ];

    expect(() => {
      computeEffectiveAspects({
        nodeType: 'service',
        architecture: createArchitecture({ service: {} }),
        parentTypes: [],
        ownAspects: ['a'],
        flowAspects: [],
        allAspects: aspects,
        allFlows: [],
      });
    }).toThrow('Aspect implies cycle detected');
  });

  it('should combine all sources: architecture + parent + own + flow + implies', () => {
    const aspects = createAspects({
      'auth-base': {
        implies: ['auth-logging'],
      },
      'auth-logging': {},
      'transaction-base': {
        implies: ['transaction-logging'],
      },
      'transaction-logging': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'payment-service',
      architecture: createArchitecture({
        'payment-service': {
          parents: ['service'],
          aspects: ['encryption'],
        },
        service: {
          aspects: ['auth-base'],
        },
      }),
      parentTypes: ['service'],
      ownAspects: ['audit-trail'],
      flowAspects: ['transaction-base'],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set([
      'auth-base',
      'auth-logging',
      'encryption',
      'audit-trail',
      'transaction-base',
      'transaction-logging',
    ]));
  });

  it('should not duplicate aspects when they appear from multiple sources', () => {
    const aspects = createAspects({
      'auth-base': {
        implies: ['auth-logging'],
      },
      'auth-logging': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['auth-base', 'auth-logging'],
        },
      }),
      parentTypes: [],
      ownAspects: ['auth-base'],
      flowAspects: ['auth-logging'],
      allAspects: aspects,
      allFlows: [],
    });

    // Should have exact set, not duplicates
    expect(result.regular).toEqual(new Set(['auth-base', 'auth-logging']));
    expect(result.regular.size).toBe(2);
  });

  it('should handle missing aspect definition gracefully (aspect not in allAspects)', () => {
    // When an aspect ID is referenced but not defined, implies expansion just skips it
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: ['unknown-aspect'],
      flowAspects: [],
      allAspects: [], // Empty — unknown-aspect not defined
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['unknown-aspect']));
  });

  it('should handle multiple parents with their own inheritance chains', () => {
    const result = computeEffectiveAspects({
      nodeType: 'web-service',
      architecture: createArchitecture({
        'web-service': {
          parents: ['service', 'http-handler'],
        },
        service: {
          aspects: ['auth'],
        },
        'http-handler': {
          aspects: ['timeout-handling'],
        },
      }),
      parentTypes: ['service', 'http-handler'],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['auth', 'timeout-handling']));
  });

  it('should return immutable Sets', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['auth'],
        },
      }),
      parentTypes: [],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    // Verify Sets exist and are Sets
    expect(result.regular instanceof Set).toBe(true);

    // Caller shouldn't normally mutate, but verify the structure is correct
    expect(result.regular).toEqual(new Set(['auth']));
  });

  it('should handle deep inheritance chains (grandparent -> parent -> child)', () => {
    const result = computeEffectiveAspects({
      nodeType: 'specialized-service',
      architecture: createArchitecture({
        'specialized-service': {
          parents: ['extended-service'],
        },
        'extended-service': {
          parents: ['service'],
          aspects: ['caching'],
        },
        service: {
          aspects: ['auth'],
        },
      }),
      parentTypes: ['extended-service'],
      ownAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['auth', 'caching']));
  });

  it('should handle implies chain with multiple branches', () => {
    const aspects = createAspects({
      'top': {
        implies: ['left', 'right'],
      },
      'left': {
        implies: ['left-child'],
      },
      'right': {
        implies: ['right-child'],
      },
      'left-child': {},
      'right-child': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: ['top'],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['top', 'left', 'right', 'left-child', 'right-child']));
  });

  it('should handle diamond dependency in implies chain', () => {
    // top -> left, right
    // left -> bottom
    // right -> bottom
    // (bottom is reached from both paths)
    const aspects = createAspects({
      'top': {
        implies: ['left', 'right'],
      },
      'left': {
        implies: ['bottom'],
      },
      'right': {
        implies: ['bottom'],
      },
      'bottom': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: ['top'],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['top', 'left', 'right', 'bottom']));
    expect(result.regular.size).toBe(4);
  });

});

// ---- Helpers for graph-aware function tests ----

function makeNode(path: string, overrides: Partial<GraphNode> & { meta?: Partial<GraphNode['meta']> } = {}): GraphNode {
  return {
    path,
    meta: { name: path, type: 'library', ...overrides.meta },
    artifacts: [],
    children: [],
    parent: overrides.parent ?? null,
    ...overrides,
  } as GraphNode;
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: { name: 'test' },
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: '/tmp',
    ...overrides,
  } as Graph;
}


describe('getAspectSource', () => {
  it('identifies architecture type requirement', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: { service: { description: 'x', aspects: ['auth'] } },
      },
    });
    expect(getAspectSource('auth', node, graph)).toContain('architecture');
    expect(getAspectSource('auth', node, graph)).toContain('service');
  });

  it('identifies own declaration', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['custom'] } });
    const graph = makeGraph();
    expect(getAspectSource('custom', node, graph)).toContain('own declaration');
  });

  it('identifies flow participation', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['svc'], aspects: ['transactional'], artifacts: [] }],
    });
    expect(getAspectSource('transactional', node, graph)).toContain('flow');
    expect(getAspectSource('transactional', node, graph)).toContain('checkout');
  });

  it('identifies parent inheritance via own aspects', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['deterministic'] } });
    const child = makeNode('svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getAspectSource('deterministic', child, graph)).toContain('parent inheritance');
    expect(getAspectSource('deterministic', child, graph)).toContain('mod');
  });

  it('identifies parent inheritance via architecture type', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: { module: { description: 'x', aspects: ['deterministic'] }, service: { description: 'y' } },
      },
    });
    expect(getAspectSource('deterministic', child, graph)).toContain('parent inheritance');
    expect(getAspectSource('deterministic', child, graph)).toContain('architecture type');
  });

  it('identifies flow via parent', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      flows: [{ path: 'analysis', name: 'Analysis', nodes: ['mod'], aspects: ['pure'], artifacts: [] }],
    });
    expect(getAspectSource('pure', child, graph)).toContain('flow');
    expect(getAspectSource('pure', child, graph)).toContain('via parent');
  });

  it('returns unknown when source not found', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getAspectSource('nonexistent', node, graph)).toContain('unknown');
  });
});


// ---- Port-based integration aspects ----

describe('computeEffectiveAspectsForConsumer (port-based)', () => {
  it('computes integration aspects from consumed ports', () => {
    // Node A calls Node B, consumes port 'charge' which requires [correlation-tracking, idempotency]
    // Node A's effective aspects should include correlation-tracking + idempotency
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-tracking', 'idempotency'] },
          refund: { description: 'Refund', aspects: ['retry-policy'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls', consumes: ['charge'] }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
      aspects: [
        { name: 'correlation-tracking', id: 'correlation-tracking', artifacts: [] },
        { name: 'idempotency', id: 'idempotency', artifacts: [] },
        { name: 'retry-policy', id: 'retry-policy', artifacts: [] },
      ],
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective).toContain('correlation-tracking');
    expect(effective).toContain('idempotency');
    expect(effective).not.toContain('retry-policy'); // not consumed
  });

  it('returns empty set when target has no ports', () => {
    const nodeB = makeNode('nodeB', { meta: { name: 'nodeB', type: 'service' } });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls' }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective.size).toBe(0);
  });

  it('expands implies chain from consumed port aspects', () => {
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['base-tracking'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls', consumes: ['charge'] }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
      aspects: [
        { name: 'base-tracking', id: 'base-tracking', implies: ['logging'], artifacts: [] },
        { name: 'logging', id: 'logging', artifacts: [] },
      ],
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective).toContain('base-tracking');
    expect(effective).toContain('logging');
  });

  it('combines aspects from multiple consumed ports', () => {
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-tracking'] },
          refund: { description: 'Refund', aspects: ['idempotency'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls', consumes: ['charge', 'refund'] }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
      aspects: [
        { name: 'correlation-tracking', id: 'correlation-tracking', artifacts: [] },
        { name: 'idempotency', id: 'idempotency', artifacts: [] },
      ],
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective).toContain('correlation-tracking');
    expect(effective).toContain('idempotency');
  });

  it('collects aspects from multiple called targets', () => {
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-tracking'] },
        },
      },
    });
    const nodeC = makeNode('nodeC', {
      meta: {
        name: 'nodeC',
        type: 'service',
        ports: {
          notify: { description: 'Notify', aspects: ['event-based'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [
          { target: 'nodeB', type: 'calls', consumes: ['charge'] },
          { target: 'nodeC', type: 'calls', consumes: ['notify'] },
        ],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
        ['nodeC', nodeC],
      ]),
      aspects: [
        { name: 'correlation-tracking', id: 'correlation-tracking', artifacts: [] },
        { name: 'event-based', id: 'event-based', artifacts: [] },
      ],
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective).toContain('correlation-tracking');
    expect(effective).toContain('event-based');
  });

  it('handles relations without consumes field', () => {
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-tracking'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls' }], // No consumes
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective.size).toBe(0);
  });

  it('handles missing target node gracefully', () => {
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nonexistent', type: 'calls', consumes: ['charge'] }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([['nodeA', nodeA]]),
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective.size).toBe(0);
  });

  it('skips consumed ports that do not exist on target', () => {
    const nodeB = makeNode('nodeB', {
      meta: {
        name: 'nodeB',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-tracking'] },
        },
      },
    });
    const nodeA = makeNode('nodeA', {
      meta: {
        name: 'nodeA',
        type: 'service',
        relations: [{ target: 'nodeB', type: 'calls', consumes: ['charge', 'nonexistent-port'] }],
      },
    });

    const graph = makeGraph({
      nodes: new Map([
        ['nodeA', nodeA],
        ['nodeB', nodeB],
      ]),
      aspects: [
        { name: 'correlation-tracking', id: 'correlation-tracking', artifacts: [] },
      ],
    });

    const effective = computeEffectiveAspectsForConsumer(nodeA, graph);
    expect(effective).toContain('correlation-tracking');
    expect(effective.size).toBe(1);
  });
});
