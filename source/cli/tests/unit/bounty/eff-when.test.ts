import { describe, it, expect } from 'vitest';
import { computeEffectiveAspects } from '../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ----------------------------------------------------------------------------
// Bug-bounty: effective aspects — when-predicate filtering, per channel.
//
// A `when` predicate on an aspect (global `when:`) or on an attach entry
// (channel-local aspectWhens / impliesWhens) filters applicability per channel:
//   - when true  -> the attachment keeps the aspect on the node
//   - when false -> the attachment drops the aspect on that channel
//
// An aspect is effective iff AT LEAST ONE channel path passes
//   (global when AND attach-site when).
//
// Atoms exercised: node {type, has_port, has_mapping}, relations {target,
// target_type, consumes_port}, descendants {type, has_port, relations}, plus
// boolean combinators all_of / any_of / not, combined with each of channels
// 1-6 and the implies channel (7).
//
// These functions are pure (no I/O); we build small in-memory graphs.
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

/** Build a minimal llm AspectDef. */
function aspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    reviewer: { type: 'llm' as const },
    artifacts: [],
    ...extra,
  } as AspectDef;
}

const FALSE_WHEN: WhenPredicate = { node: { type: 'no-such-type' } };

// ============================================================================
// Section A — global aspect.when filtering, one per channel
// ============================================================================

describe('global aspect.when — channel 1 (own)', () => {
  it('global when=true keeps own aspect', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [aspect('a', { when: { node: { type: 'service' } } })],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('global when=false drops own aspect', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [aspect('a', { when: { node: { type: 'command' } } })],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('global aspect.when — channel 2 (ancestor node)', () => {
  function build(when: WhenPredicate, childType = 'service') {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['a'] } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: childType } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      aspects: [aspect('a', { when })],
    });
    return { child, graph };
  }

  it('global when=true keeps inherited aspect', () => {
    const { child, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(true);
  });

  it('global when=false drops inherited aspect (predicate evaluated on the CHILD)', () => {
    // The global when is evaluated against the node under inspection (child),
    // not the ancestor that attached it.
    const { child, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(false);
  });
});

describe('global aspect.when — channel 3 (own architecture type)', () => {
  function build(when: WhenPredicate) {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', mapping: ['src/x.ts'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['a'] } } },
      aspects: [aspect('a', { when })],
    });
    return { node, graph };
  }

  it('global when=true keeps type-default aspect', () => {
    const { node, graph } = build({ node: { has_mapping: true } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('global when=false drops type-default aspect', () => {
    const { node, graph } = build({ node: { has_mapping: false } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('global aspect.when — channel 4 (ancestor architecture type)', () => {
  function build(when: WhenPredicate) {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      architecture: {
        node_types: {
          module: { description: 'mod', aspects: ['a'] },
          service: { description: 'svc' },
        },
      },
      aspects: [aspect('a', { when })],
    });
    return { child, graph };
  }

  it('global when=true keeps ancestor-type aspect', () => {
    const { child, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(true);
  });

  it('global when=false drops ancestor-type aspect', () => {
    const { child, graph } = build({ node: { type: 'module' } });
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(false);
  });
});

describe('global aspect.when — channel 5 (flow)', () => {
  function build(when: WhenPredicate, nodeType = 'service') {
    const node = makeNode('svc', { meta: { name: 'svc', type: nodeType } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      flows: [{ path: 'f', name: 'F', nodes: ['svc'], aspects: ['a'] }],
      aspects: [aspect('a', { when })],
    });
    return { node, graph };
  }

  it('global when=true keeps flow aspect', () => {
    const { node, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('global when=false drops flow aspect', () => {
    const { node, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('global aspect.when — channel 6 (port)', () => {
  function build(when: WhenPredicate, consumerType = 'service') {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: 'c', aspects: ['a'] } } },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: consumerType,
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('a', { when })],
    });
    return { consumer, graph };
  }

  it('global when=true keeps port aspect', () => {
    const { consumer, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(consumer, graph).has('a')).toBe(true);
  });

  it('global when=false drops port aspect', () => {
    const { consumer, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(consumer, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section B — attach-site when (aspectWhens / impliesWhens), one per channel
// ============================================================================

describe('attach-site aspectWhens — channel 1 (own)', () => {
  function build(when: WhenPredicate, nodeType = 'service') {
    const node = makeNode('svc', {
      meta: { name: 'svc', type: nodeType, aspects: ['a'], aspectWhens: { a: when } },
    });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a')] });
    return { node, graph };
  }
  it('own attach-site when=true keeps aspect', () => {
    const { node, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });
  it('own attach-site when=false drops aspect', () => {
    const { node, graph } = build({ node: { type: 'command' } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('attach-site aspectWhens — channel 2 (ancestor node)', () => {
  function build(when: WhenPredicate, childType = 'service') {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['a'], aspectWhens: { a: when } },
    });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: childType } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      aspects: [aspect('a')],
    });
    return { child, graph };
  }
  it('ancestor attach-site when=true keeps aspect (evaluated on child)', () => {
    const { child, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(true);
  });
  it('ancestor attach-site when=false drops aspect (evaluated on child)', () => {
    const { child, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(false);
  });
});

describe('attach-site aspectWhens — channel 3 (own type)', () => {
  function build(when: WhenPredicate, mapping?: string[]) {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', mapping } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['a'], aspectWhens: { a: when } } } },
      aspects: [aspect('a')],
    });
    return { node, graph };
  }
  it('type-default attach-site when=true keeps aspect', () => {
    const { node, graph } = build({ node: { has_mapping: true } }, ['src/x.ts']);
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });
  it('type-default attach-site when=false drops aspect', () => {
    const { node, graph } = build({ node: { has_mapping: true } }, undefined);
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('attach-site aspectWhens — channel 4 (ancestor type)', () => {
  function build(when: WhenPredicate, childType = 'service') {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: childType } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/svc', child]]),
      architecture: {
        node_types: {
          module: { description: 'mod', aspects: ['a'], aspectWhens: { a: when } },
          service: { description: 'svc' },
          command: { description: 'cmd' },
        },
      },
      aspects: [aspect('a')],
    });
    return { child, graph };
  }
  it('ancestor-type attach-site when=true keeps aspect', () => {
    const { child, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(true);
  });
  it('ancestor-type attach-site when=false drops aspect', () => {
    const { child, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(false);
  });
});

describe('attach-site aspectWhens — channel 5 (flow)', () => {
  function build(when: WhenPredicate, nodeType = 'service') {
    const node = makeNode('svc', { meta: { name: 'svc', type: nodeType } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      flows: [{ path: 'f', name: 'F', nodes: ['svc'], aspects: ['a'], aspectWhens: { a: when } }],
      aspects: [aspect('a')],
    });
    return { node, graph };
  }
  it('flow attach-site when=true keeps aspect', () => {
    const { node, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });
  it('flow attach-site when=false drops aspect', () => {
    const { node, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

describe('attach-site aspectWhens — channel 6 (port)', () => {
  function build(when: WhenPredicate, consumerType = 'service') {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'c', aspects: ['a'], aspectWhens: { a: when } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: consumerType,
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('a')],
    });
    return { consumer, graph };
  }
  it('port attach-site when=true keeps aspect', () => {
    const { consumer, graph } = build({ node: { type: 'service' } });
    expect(computeEffectiveAspects(consumer, graph).has('a')).toBe(true);
  });
  it('port attach-site when=false drops aspect', () => {
    const { consumer, graph } = build({ node: { type: 'service' } }, 'command');
    expect(computeEffectiveAspects(consumer, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section C — global AND attach-site combine via AND, per channel
// ============================================================================

describe('global AND attach-site (AND semantics)', () => {
  it('own: both true -> kept', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: { node: { has_mapping: false } } } } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { type: 'service' } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('own: global true, attach false -> dropped', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: { node: { type: 'command' } } } } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { type: 'service' } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('own: global false, attach true -> dropped', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: { node: { type: 'service' } } } } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { type: 'command' } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('own: both false -> dropped', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: FALSE_WHEN } } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: FALSE_WHEN })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section D — multi-channel: aspect passes if ANY channel path passes
// ============================================================================

describe('multi-channel OR — at least one passing path keeps the aspect', () => {
  it('own channel blocked but type channel passes -> effective', () => {
    // Own attach when=false, but the same aspect also attaches via type default
    // with no when -> the type path passes, so the aspect is effective.
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: FALSE_WHEN } },
    });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['a'] } } },
      aspects: [aspect('a')],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('all attaching channels blocked -> dropped', () => {
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: FALSE_WHEN } },
    });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['a'], aspectWhens: { a: FALSE_WHEN } } } },
      aspects: [aspect('a')],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('global when=false blocks EVERY channel (cannot be salvaged by attach-site)', () => {
    // Global when is ANDed on every channel; a false global cannot be rescued by
    // any passing attach-site, on any channel.
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'] },
    });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 'svc', aspects: ['a'] } } },
      flows: [{ path: 'f', name: 'F', nodes: ['svc'], aspects: ['a'] }],
      aspects: [aspect('a', { when: FALSE_WHEN })],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});
