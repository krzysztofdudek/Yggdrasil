import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectStatusSources,
  getAspectSource,
} from '../../../src/core/graph/aspects.js';
import { evaluateWhen } from '../../../src/core/when-evaluator.js';
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

const TRUE_WHEN: WhenPredicate = { node: { type: 'service' } };
const FALSE_WHEN: WhenPredicate = { node: { type: 'no-such-type' } };

// ============================================================================
// Section E — node atom forms in when
// ============================================================================

describe('node atom — type / has_port / has_mapping', () => {
  it('node.type true/false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { type: 'service' } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { node: { type: 'command' } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('node.has_port true/false', () => {
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'], ports: { charge: { description: 'c', aspects: [] } } },
    });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { has_port: 'charge' } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { node: { has_port: 'refund' } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('node.has_mapping true/false both directions', () => {
    const mapped = makeNode('m', { meta: { name: 'm', type: 'service', aspects: ['a'], mapping: ['src/x.ts'] } });
    const unmapped = makeNode('u', { meta: { name: 'u', type: 'service', aspects: ['a'] } });
    const gMapTrue = makeGraph({ nodes: new Map([['m', mapped]]), aspects: [aspect('a', { when: { node: { has_mapping: true } } })] });
    const gMapFalse = makeGraph({ nodes: new Map([['u', unmapped]]), aspects: [aspect('a', { when: { node: { has_mapping: false } } })] });
    expect(computeEffectiveAspects(mapped, gMapTrue).has('a')).toBe(true);
    expect(computeEffectiveAspects(unmapped, gMapFalse).has('a')).toBe(true);
    // cross: has_mapping:true on an unmapped node => false
    const gCross = makeGraph({ nodes: new Map([['u', unmapped]]), aspects: [aspect('a', { when: { node: { has_mapping: true } } })] });
    expect(computeEffectiveAspects(unmapped, gCross).has('a')).toBe(false);
  });

  it('empty mapping array is treated as no mapping (has_mapping:false)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], mapping: [] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { node: { has_mapping: false } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });
});

// ============================================================================
// Section F — relations atom forms in when
// ============================================================================

describe('relations atom — target / target_type / consumes_port', () => {
  function consumerGraph(when: WhenPredicate, rel: { target: string; type: any; consumes?: string[] }) {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service-client', ports: { charge: { description: 'c', aspects: [] } } },
    });
    const node = makeNode('orders', {
      meta: { name: 'orders', type: 'command', aspects: ['a'], relations: [rel] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', node]]),
      aspects: [aspect('a', { when })],
    });
    return { node, graph };
  }

  it('relations.calls.target exact match true/false', () => {
    const { node, graph } = consumerGraph({ relations: { calls: { target: 'payments' } } }, { target: 'payments', type: 'calls' });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { relations: { calls: { target: 'elsewhere' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('relations.calls.target_type true/false', () => {
    const { node, graph } = consumerGraph({ relations: { calls: { target_type: 'service-client' } } }, { target: 'payments', type: 'calls' });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { relations: { calls: { target_type: 'service' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('relations.calls.consumes_port true/false', () => {
    const { node, graph } = consumerGraph({ relations: { calls: { consumes_port: 'charge' } } }, { target: 'payments', type: 'calls', consumes: ['charge'] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { relations: { calls: { consumes_port: 'refund' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('relations clause keyed by a relation TYPE the node lacks -> false', () => {
    // Node has a calls relation but the when keys on `uses`.
    const { node, graph } = consumerGraph({ relations: { uses: { target: 'payments' } } }, { target: 'payments', type: 'calls' });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('relations clause with multiple type keys is ANDed across types', () => {
    const target = makeNode('payments', { meta: { name: 'payments', type: 'service' } });
    const dep = makeNode('lib', { meta: { name: 'lib', type: 'library' } });
    const node = makeNode('orders', {
      meta: {
        name: 'orders', type: 'command', aspects: ['a'],
        relations: [{ target: 'payments', type: 'calls' }, { target: 'lib', type: 'uses' }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['lib', dep], ['orders', node]]),
      aspects: [aspect('a', { when: { relations: { calls: { target: 'payments' }, uses: { target: 'lib' } } } })],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    // break the `uses` half -> whole clause is false
    graph.aspects[0].when = { relations: { calls: { target: 'payments' }, uses: { target: 'other' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('node with NO relations -> any relations clause is false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { relations: { calls: { target: 'x' } } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section G — descendants atom forms in when
// ============================================================================

describe('descendants atom — type / has_port / relations', () => {
  function parentWith(childMeta: Partial<GraphNode['meta']>, when: WhenPredicate, extraNodes: Array<[string, GraphNode]> = []) {
    const child = makeNode('mod/c', { meta: { name: 'c', type: 'service', ...childMeta } });
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['a'] }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({
      nodes: new Map<string, GraphNode>([['mod', parent], ['mod/c', child], ...extraNodes]),
      aspects: [aspect('a', { when })],
    });
    return { parent, graph };
  }

  it('descendants.type true/false', () => {
    const { parent, graph } = parentWith({ type: 'command' }, { descendants: { type: 'command' } });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    graph.aspects[0].when = { descendants: { type: 'handler' } };
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(false);
  });

  it('descendants.has_port true/false', () => {
    const { parent, graph } = parentWith({ ports: { charge: { description: 'c', aspects: [] } } }, { descendants: { has_port: 'charge' } });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    graph.aspects[0].when = { descendants: { has_port: 'refund' } };
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(false);
  });

  it('descendants.relations true/false', () => {
    const target = makeNode('pay', { meta: { name: 'pay', type: 'service-client' } });
    const { parent, graph } = parentWith(
      { relations: [{ target: 'pay', type: 'calls' }] },
      { descendants: { relations: { calls: { target_type: 'service-client' } } } },
      [['pay', target]],
    );
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
    graph.aspects[0].when = { descendants: { relations: { calls: { target_type: 'service' } } } };
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(false);
  });

  it('a leaf node (no descendants) -> any descendants clause is false', () => {
    const leaf = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', leaf]]), aspects: [aspect('a', { when: { descendants: { type: 'service' } } })] });
    expect(computeEffectiveAspects(leaf, graph).has('a')).toBe(false);
  });

  it('descendants are transitive (grandchild satisfies the clause)', () => {
    const grandchild = makeNode('mod/c/g', { meta: { name: 'g', type: 'handler' } });
    const child = makeNode('mod/c', { meta: { name: 'c', type: 'service' }, children: [grandchild] });
    grandchild.parent = child;
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['a'] }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/c', child], ['mod/c/g', grandchild]]),
      aspects: [aspect('a', { when: { descendants: { type: 'handler' } } })],
    });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(true);
  });

  it('descendants clause does NOT consider the node itself', () => {
    // The node is type=handler but has NO descendants of type handler.
    const child = makeNode('mod/c', { meta: { name: 'c', type: 'service' } });
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'handler', aspects: ['a'] }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({
      nodes: new Map([['mod', parent], ['mod/c', child]]),
      aspects: [aspect('a', { when: { descendants: { type: 'handler' } } })],
    });
    expect(computeEffectiveAspects(parent, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section H — boolean combinators: all_of / any_of / not
// ============================================================================

describe('boolean combinators in when', () => {
  it('all_of true only when every clause true', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], mapping: ['src/x.ts'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { all_of: [{ node: { type: 'service' } }, { node: { has_mapping: true } }] } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { all_of: [{ node: { type: 'service' } }, { node: { has_mapping: false } }] };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('any_of true when at least one clause true', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { any_of: [{ node: { type: 'command' } }, { node: { type: 'service' } }] } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { any_of: [{ node: { type: 'command' } }, { node: { type: 'handler' } }] };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('not negates a clause', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { not: { node: { type: 'command' } } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    graph.aspects[0].when = { not: { node: { type: 'service' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('nested combinators: not(any_of) == all_of(not)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when: { not: { any_of: [{ node: { type: 'command' } }, { node: { type: 'handler' } }] } } })] });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true); // node is service, neither command nor handler
    graph.aspects[0].when = { not: { any_of: [{ node: { type: 'service' } }, { node: { type: 'handler' } }] } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('implicit all_of over multiple atomic keys (relations AND node)', () => {
    const target = makeNode('pay', { meta: { name: 'pay', type: 'service-client' } });
    const node = makeNode('orders', {
      meta: { name: 'orders', type: 'command', aspects: ['a'], relations: [{ target: 'pay', type: 'calls' }] },
    });
    const graph = makeGraph({
      nodes: new Map([['pay', target], ['orders', node]]),
      aspects: [aspect('a', { when: { node: { type: 'command' }, relations: { calls: { target_type: 'service-client' } } } })],
    });
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    // break the node half -> false even though relations half holds
    graph.aspects[0].when = { node: { type: 'handler' }, relations: { calls: { target_type: 'service-client' } } };
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });
});

// ============================================================================
// Section I — implies channel (7) with when filtering
// ============================================================================

describe('implies channel — global when + per-edge impliesWhens', () => {
  it('implied B kept when B.global true and A.impliesWhens[B] true', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'], impliesWhens: { b: { node: { type: 'service' } } } }),
        aspect('b', { when: { node: { type: 'service' } } }),
      ],
    });
    expect(computeEffectiveAspects(node, graph)).toEqual(new Set(['a', 'b']));
  });

  it('implied B dropped when B.global false (implier still effective)', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'] }),
        aspect('b', { when: { node: { type: 'command' } } }),
      ],
    });
    const r = computeEffectiveAspects(node, graph);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(false);
  });

  it('implied B dropped when per-edge impliesWhens[B] false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'], impliesWhens: { b: { node: { type: 'command' } } } }),
        aspect('b'),
      ],
    });
    const r = computeEffectiveAspects(node, graph);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(false);
  });

  it('implier itself filtered out by its own global when -> implied not pulled in', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'], when: { node: { type: 'command' } } }),
        aspect('b'),
      ],
    });
    const r = computeEffectiveAspects(node, graph);
    expect(r.has('a')).toBe(false);
    expect(r.has('b')).toBe(false);
  });

  it('B stays effective via a direct attach even when A.impliesWhens[B] is false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a', 'b'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'], impliesWhens: { b: { node: { type: 'command' } } } }),
        aspect('b'),
      ],
    });
    expect(computeEffectiveAspects(node, graph).has('b')).toBe(true);
  });

  it('transitive: per-edge when on the SECOND edge prunes only the leaf', () => {
    // a -> b -> c. impliesWhens on b->c is false. a and b kept, c dropped.
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { implies: ['b'] }),
        aspect('b', { implies: ['c'], impliesWhens: { c: { node: { type: 'command' } } } }),
        aspect('c'),
      ],
    });
    expect(computeEffectiveAspects(node, graph)).toEqual(new Set(['a', 'b']));
  });

  it('diamond: c reachable via a passing edge survives a parallel pruned edge', () => {
    // top -> left -> bottom (left->bottom pruned)
    // top -> right -> bottom (right->bottom open) => bottom survives
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['top'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('top', { implies: ['left', 'right'] }),
        aspect('left', { implies: ['bottom'], impliesWhens: { bottom: { node: { type: 'command' } } } }),
        aspect('right', { implies: ['bottom'] }),
        aspect('bottom'),
      ],
    });
    expect(computeEffectiveAspects(node, graph)).toEqual(new Set(['top', 'left', 'right', 'bottom']));
  });
});

// ============================================================================
// Section J — combine each channel's attach with a passing/failing global when
// (cross-product confidence that the filter is wired into every channel)
// ============================================================================

describe('global when wired into every channel — false global drops, true global keeps', () => {
  const channels: Array<{ name: string; build: (when: WhenPredicate) => { node: GraphNode; graph: Graph } }> = [
    {
      name: 'own',
      build: (when) => {
        const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
        return { node, graph: makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { when })] }) };
      },
    },
    {
      name: 'ancestor-node',
      build: (when) => {
        const parent = makeNode('mod', { meta: { name: 'mod', type: 'module', aspects: ['a'] } });
        const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
        parent.children = [child];
        return { node: child, graph: makeGraph({ nodes: new Map([['mod', parent], ['mod/svc', child]]), aspects: [aspect('a', { when })] }) };
      },
    },
    {
      name: 'own-type',
      build: (when) => {
        const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
        return {
          node,
          graph: makeGraph({
            nodes: new Map([['svc', node]]),
            architecture: { node_types: { service: { description: 's', aspects: ['a'] } } },
            aspects: [aspect('a', { when })],
          }),
        };
      },
    },
    {
      name: 'ancestor-type',
      build: (when) => {
        const parent = makeNode('mod', { meta: { name: 'mod', type: 'module' } });
        const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'service' } });
        parent.children = [child];
        return {
          node: child,
          graph: makeGraph({
            nodes: new Map([['mod', parent], ['mod/svc', child]]),
            architecture: { node_types: { module: { description: 'm', aspects: ['a'] }, service: { description: 's' } } },
            aspects: [aspect('a', { when })],
          }),
        };
      },
    },
    {
      name: 'flow',
      build: (when) => {
        const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
        return {
          node,
          graph: makeGraph({
            nodes: new Map([['svc', node]]),
            flows: [{ path: 'f', name: 'F', nodes: ['svc'], aspects: ['a'] }],
            aspects: [aspect('a', { when })],
          }),
        };
      },
    },
    {
      name: 'port',
      build: (when) => {
        const target = makeNode('pay', { meta: { name: 'pay', type: 'service', ports: { charge: { description: 'c', aspects: ['a'] } } } });
        const node = makeNode('orders', { meta: { name: 'orders', type: 'service', relations: [{ target: 'pay', type: 'calls', consumes: ['charge'] }] } });
        return { node, graph: makeGraph({ nodes: new Map([['pay', target], ['orders', node]]), aspects: [aspect('a', { when })] }) };
      },
    },
  ];

  for (const { name, build } of channels) {
    it(`${name}: global when=true keeps`, () => {
      const { node, graph } = build(TRUE_WHEN);
      expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
    });
    it(`${name}: global when=false drops`, () => {
      const { node, graph } = build(FALSE_WHEN);
      expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
    });
  }
});

// ============================================================================
// Section K — status computation honors when too (computeEffectiveAspectStatuses)
// ============================================================================

describe('computeEffectiveAspectStatuses respects when filtering', () => {
  it('global when=false -> aspect absent from status map', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { status: 'enforced', when: FALSE_WHEN })] });
    expect(computeEffectiveAspectStatuses(node, graph).has('a')).toBe(false);
  });

  it('attach-site when=false -> aspect absent from status map', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'], aspectWhens: { a: FALSE_WHEN } } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { status: 'enforced' })] });
    expect(computeEffectiveAspectStatuses(node, graph).has('a')).toBe(false);
  });

  it('when=true -> status present and equals declared/default', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('a', { status: 'advisory', when: TRUE_WHEN })] });
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('advisory');
  });

  it('status = max() across channels; a when-blocked channel does not contribute', () => {
    // own attach declares advisory but with when=false (blocked).
    // type default declares enforced with no when (open). Effective = enforced.
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' }, aspectWhens: { a: FALSE_WHEN } },
    });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 's', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      aspects: [aspect('a')],
    });
    const m = computeEffectiveAspectStatuses(node, graph);
    expect(m.get('a')).toBe('enforced');
  });

  it('implied status not propagated when implied global when=false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { status: 'enforced', implies: ['b'] }),
        aspect('b', { status: 'enforced', when: FALSE_WHEN }),
      ],
    });
    const m = computeEffectiveAspectStatuses(node, graph);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });

  it('implied status not propagated when per-edge impliesWhens false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [
        aspect('a', { status: 'enforced', implies: ['b'], impliesWhens: { b: FALSE_WHEN } }),
        aspect('b', { status: 'enforced' }),
      ],
    });
    const m = computeEffectiveAspectStatuses(node, graph);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });
});

// ============================================================================
// Section L — provenance: getAspectStatusSources is when-filtered;
//             getAspectSource is NOT (informational, ignores when)
// ============================================================================

describe('getAspectStatusSources is when-filtered per channel', () => {
  it('drops a channel whose attach-site when is false; keeps the passing one', () => {
    // own (advisory) blocked by attach when=false; type-default (enforced) open.
    const node = makeNode('svc', {
      meta: { name: 'svc', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' }, aspectWhens: { a: FALSE_WHEN } },
    });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 's', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      aspects: [aspect('a')],
    });
    const sources = getAspectStatusSources(node, 'a', graph);
    // own channel filtered out; only type-default remains
    expect(sources.map(s => s.channel)).toEqual([3]);
    expect(sources[0].declared).toBe('enforced');
  });

  it('global when=false removes ALL channel sources', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      architecture: { node_types: { service: { description: 's', aspects: ['a'] } } },
      aspects: [aspect('a', { when: FALSE_WHEN })],
    });
    expect(getAspectStatusSources(node, 'a', graph)).toEqual([]);
  });
});

describe('getAspectSource ignores when (informational provenance)', () => {
  it('still reports the channel even when global when=false', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service', aspects: ['a'] } });
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      aspects: [aspect('a', { when: FALSE_WHEN })],
    });
    expect(getAspectSource('a', node, graph)).toBe('own declaration');
  });
});

// ============================================================================
// Section M — direct evaluateWhen sanity for edge atoms used above
// ============================================================================

describe('evaluateWhen — edge atoms', () => {
  it('relations.consumes_port false when relation has no consumes', () => {
    const target = makeNode('pay', { meta: { name: 'pay', type: 'service', ports: { charge: { description: 'c', aspects: [] } } } });
    const node = makeNode('orders', { meta: { name: 'orders', type: 'command', relations: [{ target: 'pay', type: 'calls' }] } });
    const graph = makeGraph({ nodes: new Map([['pay', target], ['orders', node]]) });
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'charge' } } }, node, graph)).toBe(false);
  });

  it('relations.target_type false when target node is missing from graph', () => {
    const node = makeNode('orders', { meta: { name: 'orders', type: 'command', relations: [{ target: 'ghost', type: 'calls' }] } });
    const graph = makeGraph({ nodes: new Map([['orders', node]]) });
    expect(evaluateWhen({ relations: { calls: { target_type: 'anything' } } }, node, graph)).toBe(false);
  });

  it('descendants clause false on a leaf even when the leaf has the queried port itself', () => {
    const leaf = makeNode('svc', { meta: { name: 'svc', type: 'service', ports: { charge: { description: 'c', aspects: [] } } } });
    const graph = makeGraph({ nodes: new Map([['svc', leaf]]) });
    expect(evaluateWhen({ descendants: { has_port: 'charge' } }, leaf, graph)).toBe(false);
  });

  it('empty atomic object {} is vacuously true', () => {
    const node = makeNode('svc', { meta: { name: 'svc', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['svc', node]]) });
    expect(evaluateWhen({} as WhenPredicate, node, graph)).toBe(true);
  });
});
