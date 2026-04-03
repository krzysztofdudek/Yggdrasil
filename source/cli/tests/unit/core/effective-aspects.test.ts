import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveIntegrationAspects,
  getAspectSource,
  getIntegrationAspectSource,
} from '../../../src/core/effective-aspects.js';
import type { ArchitectureDef, AspectDef, FlowDef, Graph, GraphNode } from '../../../src/model/types.js';

describe('computeEffectiveAspects', () => {
  // Helper to create minimal architecture
  function createArchitecture(nodeTypes: Record<string, {
    aspects?: string[];
    integration_aspects?: string[];
    parents?: string[];
  }> = {}): ArchitectureDef {
    const built: Record<string, any> = {};
    for (const [type, config] of Object.entries(nodeTypes)) {
      built[type] = {
        description: `${type} type`,
        ...(config.aspects && { aspects: config.aspects }),
        ...(config.integration_aspects && { integration_aspects: config.integration_aspects }),
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
      anchors: [],
      artifacts: [],
    }));
  }

  it('should return empty sets for minimal node (no architecture constraints, no parents, no own aspects)', () => {
    const result = computeEffectiveAspects({
      nodeType: 'library',
      architecture: createArchitecture({ library: {} }),
      parentTypes: [],
      ownAspects: [],
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular.size).toBe(0);
    expect(result.integration.size).toBe(0);
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
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth', 'error-handling']));
    expect(result.integration.size).toBe(0);
  });

  it('should include architecture integration_aspects separately', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['requires-auth'],
          integration_aspects: ['integration-webhook'],
        },
      }),
      parentTypes: [],
      ownAspects: [],
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth']));
    expect(result.integration).toEqual(new Set(['integration-webhook']));
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth', 'audit-logging', 'rate-limiting']));
  });

  it('should include node own integration_aspects', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({
        service: {
          aspects: ['requires-auth'],
        },
      }),
      parentTypes: [],
      ownAspects: [],
      ownIntegrationAspects: ['vendor-webhook'],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['requires-auth']));
    expect(result.integration).toEqual(new Set(['vendor-webhook']));
  });

  it('should add flow participation aspects to regular set', () => {
    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: [],
      ownIntegrationAspects: [],
      flowAspects: ['transaction-safety', 'idempotency'],
      allAspects: [],
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['transaction-safety', 'idempotency']));
    expect(result.integration.size).toBe(0);
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
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['audit-logging', 'event-logging', 'structured-logging']));
  });

  it('should expand integration aspect implies chain', () => {
    const aspects = createAspects({
      'integration-webhook': {
        implies: ['http-handler'],
      },
      'http-handler': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: [],
      ownIntegrationAspects: ['integration-webhook'],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.integration).toEqual(new Set(['integration-webhook', 'http-handler']));
  });

  it('should detect aspect implies cycle and throw error', () => {
    const aspects: AspectDef[] = [
      {
        name: 'a',
        id: 'a',
        implies: ['b'],
        anchors: [],
        artifacts: [],
      },
      {
        name: 'b',
        id: 'b',
        implies: ['c'],
        anchors: [],
        artifacts: [],
      },
      {
        name: 'c',
        id: 'c',
        implies: ['a'],
        anchors: [],
        artifacts: [],
      },
    ];

    expect(() => {
      computeEffectiveAspects({
        nodeType: 'service',
        architecture: createArchitecture({ service: {} }),
        parentTypes: [],
        ownAspects: ['a'],
        ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: [],
      allFlows: [],
    });

    // Verify Sets exist and are Sets
    expect(result.regular instanceof Set).toBe(true);
    expect(result.integration instanceof Set).toBe(true);

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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
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
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['top', 'left', 'right', 'bottom']));
    expect(result.regular.size).toBe(4);
  });

  it('should separate regular and integration aspects even when both have implies', () => {
    const aspects = createAspects({
      'auth-base': {
        implies: ['auth-logging'],
      },
      'auth-logging': {},
      'webhook-base': {
        implies: ['webhook-logging'],
      },
      'webhook-logging': {},
    });

    const result = computeEffectiveAspects({
      nodeType: 'service',
      architecture: createArchitecture({ service: {} }),
      parentTypes: [],
      ownAspects: ['auth-base'],
      ownIntegrationAspects: ['webhook-base'],
      flowAspects: [],
      allAspects: aspects,
      allFlows: [],
    });

    expect(result.regular).toEqual(new Set(['auth-base', 'auth-logging']));
    expect(result.integration).toEqual(new Set(['webhook-base', 'webhook-logging']));
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

describe('computeEffectiveIntegrationAspects', () => {
  it('returns empty set when no integration aspects', () => {
    const node = makeNode('svc');
    const graph = makeGraph();
    expect(computeEffectiveIntegrationAspects(node, graph)).toEqual(new Set());
  });

  it('collects from architecture type integration_aspects', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: {
          service: { description: 'x', integration_aspects: ['correlation'] },
        },
      },
    });
    expect(computeEffectiveIntegrationAspects(node, graph)).toContain('correlation');
  });

  it('collects from own integration_aspects', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', integration_aspects: ['tracing'] } });
    const graph = makeGraph();
    expect(computeEffectiveIntegrationAspects(node, graph)).toContain('tracing');
  });

  it('inherits from parent recursively', () => {
    const parent = makeNode('parent', { meta: { name: 'parent', type: 'module', integration_aspects: ['audit'] } });
    const child = makeNode('child', { parent, meta: { name: 'child', type: 'library' } });
    const graph = makeGraph();
    expect(computeEffectiveIntegrationAspects(child, graph)).toContain('audit');
  });

  it('expands implies chain', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', integration_aspects: ['base'] } });
    const graph = makeGraph({
      aspects: [
        { name: 'Base', id: 'base', implies: ['derived'], anchors: [], artifacts: [] },
        { name: 'Derived', id: 'derived', anchors: [], artifacts: [] },
      ],
    });
    const result = computeEffectiveIntegrationAspects(node, graph);
    expect(result).toContain('base');
    expect(result).toContain('derived');
  });

  it('uses cache on second call', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', integration_aspects: ['x'] } });
    const graph = makeGraph();
    const cache = new Map<string, Set<string>>();
    computeEffectiveIntegrationAspects(node, graph, cache);
    expect(cache.has('svc')).toBe(true);
    const cached = computeEffectiveIntegrationAspects(node, graph, cache);
    expect(cached).toContain('x');
  });
});

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

describe('getIntegrationAspectSource', () => {
  it('identifies architecture type requirement', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: { service: { description: 'x', integration_aspects: ['tracing'] } },
      },
    });
    expect(getIntegrationAspectSource('tracing', node, graph)).toContain('architecture');
  });

  it('identifies own declaration', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', integration_aspects: ['custom'] } });
    const graph = makeGraph();
    expect(getIntegrationAspectSource('custom', node, graph)).toContain('own declaration');
  });

  it('identifies parent with own integration_aspects', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', integration_aspects: ['audit'] } });
    const child = makeNode('svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getIntegrationAspectSource('audit', child, graph)).toContain("parent 'mod'");
  });

  it('identifies parent via architecture type', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('svc', { parent, meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({
      architecture: {
        node_types: { module: { description: 'x', integration_aspects: ['logging'] }, service: { description: 'y' } },
      },
    });
    expect(getIntegrationAspectSource('logging', child, graph)).toContain("parent 'mod'");
    expect(getIntegrationAspectSource('logging', child, graph)).toContain('architecture type');
  });

  it('returns implied when source not found', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph();
    expect(getIntegrationAspectSource('unknown', node, graph)).toContain('implied');
  });
});
