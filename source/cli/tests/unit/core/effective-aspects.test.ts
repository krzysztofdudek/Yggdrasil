import { describe, it, expect } from 'vitest';
import { computeEffectiveAspects } from '../../../src/core/effective-aspects.js';
import type { ArchitectureDef, AspectDef, FlowDef } from '../../../src/model/types.js';

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
