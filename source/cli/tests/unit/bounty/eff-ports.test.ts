import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
} from '../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef, RelationType } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ============================================================
// Bug-bounty: effective aspects — channel 6 (ports).
//
// Channel 6 contract (from agent-rules / aspects.ts):
//   A relation that *consumes* a port makes that port's aspects effective on
//   the CONSUMER. A bare relation (no `consumes`) does NOT propagate. A
//   consumed port that does not exist on the target contributes nothing.
//   Ports propagate to the consumer only — never to the target (the port
//   owner) nor to a node that merely references the target without consuming.
//
// These tests build small in-memory graphs (pure objects — no FS) following
// the established makeNode/makeGraph pattern from effective-aspects.test.ts.
// ============================================================

// --- Helpers (mirror effective-aspects.test.ts) ---

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

function aspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    reviewer: { type: 'llm' as const },
    artifacts: [],
    ...extra,
  } as AspectDef;
}

// ============================================================
// 1. Basic propagation — consumed port aspects reach the consumer
// ============================================================

describe('channel 6 — basic propagation to consumer', () => {
  it('single consumed port → its single aspect is effective on consumer', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: 'Charge', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct']));
  });

  it('single consumed port with MANY aspects → all become effective on consumer', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: 'Charge', aspects: ['ct', 'idempotency', 'auth'] } },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct'), aspect('idempotency'), aspect('auth')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct', 'idempotency', 'auth']));
  });

  it('every relation type that consumes a port propagates (calls/uses/extends/implements)', () => {
    for (const type of ['calls', 'uses', 'extends', 'implements'] as RelationType[]) {
      const target = makeNode('t', { meta: { name: 't', type: 'service', ports: { p: { description: '', aspects: ['x'] } } } });
      const consumer = makeNode('c', { meta: { name: 'c', type: 'service', relations: [{ target: 't', type, portNames: ['p'] }] } });
      const graph = makeGraph({ nodes: new Map([['t', target], ['c', consumer]]), aspects: [aspect('x')] });
      expect(computeEffectiveAspects(consumer, graph).has('x'), `relation type ${type}`).toBe(true);
    }
  });

  it('event relations (emits/listens) that consume a port also propagate', () => {
    for (const type of ['emits', 'listens'] as RelationType[]) {
      const target = makeNode('t', { meta: { name: 't', type: 'service', ports: { p: { description: '', aspects: ['x'] } } } });
      const consumer = makeNode('c', {
        meta: { name: 'c', type: 'service', relations: [{ target: 't', type, portNames: ['p'], event_name: 'Evt' }] },
      });
      const graph = makeGraph({ nodes: new Map([['t', target], ['c', consumer]]), aspects: [aspect('x')] });
      expect(computeEffectiveAspects(consumer, graph).has('x'), `relation type ${type}`).toBe(true);
    }
  });
});

// ============================================================
// 2. Bare relation (no consumes) does NOT propagate
// ============================================================

describe('channel 6 — bare relation does NOT propagate', () => {
  it('relation without consumes field → port aspects NOT effective', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: 'Charge', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ portNames: ['default'], target: 'payments', type: 'calls' }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });

  it('relation with empty consumes array → nothing propagates', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: 'Charge', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: [] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });

  it('two relations to same target, only one consumes → port aspects still effective (via the consuming one)', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: 'Charge', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [
          { portNames: ['default'], target: 'payments', type: 'uses' },                       // bare
          { target: 'payments', type: 'calls', portNames: ['charge'] }, // consuming
        ],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct']));
  });

  it('node with no relations at all → no port aspects', () => {
    const consumer = makeNode('orders', { meta: { name: 'orders', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['orders', consumer]]) });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });
});

// ============================================================
// 3. Multiple consumed ports
// ============================================================

describe('channel 6 — multiple consumed ports', () => {
  it('one relation consuming two ports on the same target → union of both ports aspects', () => {
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
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'refund'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct'), aspect('idempotency')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct', 'idempotency']));
  });

  it('two relations to two different targets, each consuming a port → union across targets', () => {
    const payments = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const inventory = makeNode('inventory', {
      meta: { name: 'inventory', type: 'service', ports: { reserve: { description: '', aspects: ['stock-lock'] } } },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        relations: [
          { target: 'payments', type: 'calls', portNames: ['charge'] },
          { target: 'inventory', type: 'calls', portNames: ['reserve'] },
        ],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', payments], ['inventory', inventory], ['orders', consumer]]),
      aspects: [aspect('ct'), aspect('stock-lock')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct', 'stock-lock']));
  });

  it('two ports sharing the same aspect → dedup to one entry in the set', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: { description: '', aspects: ['shared'] },
          refund: { description: '', aspects: ['shared'] },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'refund'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('shared')],
    });
    expect([...computeEffectiveAspects(consumer, graph)]).toEqual(['shared']);
  });

  it('duplicate port name listed twice in consumes → still one aspect (idempotent)', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect([...computeEffectiveAspects(consumer, graph)]).toEqual(['ct']);
  });
});

// ============================================================
// 4. Consuming a non-existent port
// ============================================================

describe('channel 6 — non-existent / missing port consumption', () => {
  it('consuming a port name that does not exist on target → contributes nothing', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['nonexistent'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });

  it('consuming a mix of existing + non-existent ports → only the existing one contributes', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'nope'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['ct']));
  });

  it('relation target node does not exist in the graph → no throw, no aspects', () => {
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'ghost', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['orders', consumer]]) });
    expect(() => computeEffectiveAspects(consumer, graph)).not.toThrow();
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });

  it('target exists but has NO ports map at all → consuming any name is a no-op', () => {
    const target = makeNode('payments', { meta: { name: 'payments', type: 'service' } });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });

  it('consumed port exists but declares an empty aspects array → nothing propagates', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: [] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
    });
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
  });
});

// ============================================================
// 5. Directionality — ports propagate to the consumer only
// ============================================================

describe('channel 6 — directionality (consumer only, not the owner)', () => {
  it('the port-owning target does NOT receive its own port aspects via channel 6', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    // Port aspects flow OUTWARD to the consumer; the owner itself is unaffected by channel 6.
    expect(computeEffectiveAspects(target, graph).has('ct')).toBe(false);
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(true);
  });

  it('a third node that does NOT relate to the target gets nothing', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const bystander = makeNode('reporting', { meta: { name: 'reporting', type: 'service' } });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer], ['reporting', bystander]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(bystander, graph).size).toBe(0);
  });

  it('channel 6 does NOT cascade to the consumers descendants automatically', () => {
    // Only the node that owns the consuming relation is affected; a child node
    // without its own consuming relation does not inherit the port aspect.
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const child = makeNode('orders/sub', { parent: consumer, meta: { name: 'sub', type: 'service' } });
    consumer.children = [child];
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer], ['orders/sub', child]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(child, graph).has('ct')).toBe(false);
  });
});

// ============================================================
// 6. Status of port aspects (channel 6 status contribution)
// ============================================================

describe('channel 6 — status contribution', () => {
  it('port aspect with no status override → aspect default status applies', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('advisory');
  });

  it('aspect default absent → effective status is enforced for a port aspect', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')], // no status → default enforced
    });
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('enforced');
  });

  it('port-level aspectStatus override bumps status up', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: '', aspects: ['ct'], aspectStatus: { ct: 'enforced' } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('enforced');
  });

  it('strictest wins when the same aspect arrives via port (advisory) and own (enforced)', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: '', aspects: ['ct'], aspectStatus: { ct: 'advisory' } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        aspects: ['ct'],
        aspectStatus: { ct: 'enforced' },
        relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('enforced');
  });

  it('a DRAFT port aspect is still effective (id present) but stays draft', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: '', aspects: ['ct'], aspectStatus: { ct: 'draft' } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(true);
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('draft');
  });
});

// ============================================================
// 7. Implies expansion seeded by a port aspect (channel 6 → channel 7)
// ============================================================

describe('channel 6 — feeds implies expansion (channel 7)', () => {
  it('a port aspect that implies another → both become effective on consumer', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['port-root'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [
        aspect('port-root', { implies: ['port-child'] }),
        aspect('port-child'),
      ],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['port-root', 'port-child']));
  });

  it('a DRAFT port aspect does NOT propagate its implied aspect', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: '', aspects: ['port-root'], aspectStatus: { 'port-root': 'draft' } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [
        aspect('port-root', { implies: ['port-child'] }),
        aspect('port-child'),
      ],
    });
    const result = computeEffectiveAspects(consumer, graph);
    expect(result.has('port-root')).toBe(true);   // itself effective via the port channel
    expect(result.has('port-child')).toBe(false); // dormant implier must not pull in its implied aspect
  });
});

// ============================================================
// 8. `when` filtering on channel 6
// ============================================================

describe('channel 6 — when filtering', () => {
  it('port-level aspectWhens=false removes the aspect for the consumer', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'command' } } as WhenPredicate }, // consumer is service → false
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(false);
  });

  it('port-level aspectWhens=true keeps the aspect', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'service' } } as WhenPredicate }, // consumer is service → true
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(true);
  });

  it('aspect GLOBAL when=false removes a port aspect even when consumed', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { when: { node: { type: 'command' } } as WhenPredicate })], // consumer is service → false
    });
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(false);
  });

  it('global AND port-site when combine (both must hold)', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'service' } } as WhenPredicate }, // true
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { when: { node: { type: 'service' } } as WhenPredicate })], // true
    });
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(true);

    // Flip the global when to false → aspect drops despite port-site when true.
    graph.aspects[0].when = { node: { type: 'command' } } as WhenPredicate;
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(false);
  });

  it('a port aspect filtered out by when does NOT contribute status', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'command' } } as WhenPredicate }, // false for service consumer
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(computeEffectiveAspectStatuses(consumer, graph).has('ct')).toBe(false);
  });
});

// ============================================================
// 9. Provenance — getAspectSource (channel 6 label, ignores when)
// ============================================================

describe('channel 6 — getAspectSource provenance', () => {
  it('reports port name and target node for a consumed port aspect', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', consumer]]) });
    expect(getAspectSource('ct', consumer, graph)).toBe("port 'charge' on 'payments'");
  });

  it('getAspectSource ignores when — a when-filtered port aspect still reports the port origin', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'command' } } as WhenPredicate }, // would filter for effective set
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', consumer]]), aspects: [aspect('ct')] });
    // getAspectSource is informational and ignores `when`.
    expect(getAspectSource('ct', consumer, graph)).toBe("port 'charge' on 'payments'");
    // ... but the effective set respects when.
    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(false);
  });

  it('reports the FIRST consumed port that carries the aspect when several do', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: { description: '', aspects: ['shared'] },
          refund: { description: '', aspects: ['shared'] },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'refund'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', consumer]]) });
    expect(getAspectSource('shared', consumer, graph)).toBe("port 'charge' on 'payments'");
  });

  it('a non-consumed port aspect is NOT reported as a port source (returns unknown)', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ portNames: ['default'], target: 'payments', type: 'calls' }] }, // bare
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', consumer]]) });
    expect(getAspectSource('ct', consumer, graph)).toBe('unknown source');
  });
});

// ============================================================
// 10. Provenance — getAspectStatusSources (channel 6, when-filtered)
// ============================================================

describe('channel 6 — getAspectStatusSources provenance', () => {
  it('emits a channel-6 source with the port:<name>@<target> machine origin', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: { charge: { description: '', aspects: ['ct'], aspectStatus: { ct: 'enforced' } } },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    const sources = getAspectStatusSources(consumer, 'ct', graph);
    expect(sources).toHaveLength(1);
    expect(sources[0].channel).toBe(6);
    expect(sources[0].origin).toBe('port:charge@payments');
    expect(sources[0].declared).toBe('enforced');
  });

  it('uses the aspect default status when the port declares no override', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct', { status: 'advisory' })],
    });
    const sources = getAspectStatusSources(consumer, 'ct', graph);
    expect(sources).toHaveLength(1);
    expect(sources[0].declared).toBe('advisory');
  });

  it('does NOT emit a port source when the relation is bare (no consumes)', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ portNames: ['default'], target: 'payments', type: 'calls' }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(getAspectStatusSources(consumer, 'ct', graph)).toEqual([]);
  });

  it('does NOT emit a port source for a consumed non-existent port', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['ct'] } } },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['nope'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(getAspectStatusSources(consumer, 'ct', graph)).toEqual([]);
  });

  it('two distinct consumed ports carrying the same aspect → two channel-6 sources', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: { description: '', aspects: ['shared'], aspectStatus: { shared: 'advisory' } },
          refund: { description: '', aspects: ['shared'], aspectStatus: { shared: 'enforced' } },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge', 'refund'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('shared', { status: 'advisory' })],
    });
    const sources = getAspectStatusSources(consumer, 'shared', graph);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.channel === 6)).toBe(true);
    expect(sources.map((s) => s.origin).sort()).toEqual(['port:charge@payments', 'port:refund@payments']);
    expect(sources.map((s) => s.declared).sort()).toEqual(['advisory', 'enforced']);
  });

  it('when-filtered port aspect produces NO status source', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'payments', type: 'service',
        ports: {
          charge: {
            description: '', aspects: ['ct'],
            aspectWhens: { ct: { node: { type: 'command' } } as WhenPredicate }, // false for service consumer
          },
        },
      },
    });
    const consumer = makeNode('orders', {
      meta: { name: 'orders', type: 'service', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('ct')],
    });
    expect(getAspectStatusSources(consumer, 'ct', graph)).toEqual([]);
  });
});

// ============================================================
// 11. Combination with other channels — port aspect unions cleanly
// ============================================================

describe('channel 6 — combines with other channels', () => {
  it('port aspect + own aspect → union, both effective', () => {
    const target = makeNode('payments', {
      meta: { name: 'payments', type: 'service', ports: { charge: { description: '', aspects: ['port-x'] } } },
    });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders', type: 'service',
        aspects: ['own-x'],
        relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([['payments', target], ['orders', consumer]]),
      aspects: [aspect('port-x'), aspect('own-x')],
    });
    expect(computeEffectiveAspects(consumer, graph)).toEqual(new Set(['port-x', 'own-x']));
  });

  it('self-referential relation consuming an own port → own port aspect becomes effective', () => {
    // A node consuming a port it itself declares: channel 6 still fires (target === self).
    const node = makeNode('svc', {
      meta: {
        name: 'svc', type: 'service',
        ports: { p: { description: '', aspects: ['x'] } },
        relations: [{ target: 'svc', type: 'calls', portNames: ['p'] }],
      },
    });
    const graph = makeGraph({ nodes: new Map([['svc', node]]), aspects: [aspect('x')] });
    expect(computeEffectiveAspects(node, graph).has('x')).toBe(true);
    expect(getAspectSource('x', node, graph)).toBe("port 'p' on 'svc'");
  });
});
