import { describe, it, expect } from 'vitest';
import { evaluateWhen } from '../../../src/core/when-evaluator.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

function makeNode(path: string, overrides: Partial<GraphNode> & { meta?: Partial<GraphNode['meta']> } = {}): GraphNode {
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

describe('evaluateWhen', () => {
  it('relations.calls.target_type matches', () => {
    const target = makeNode('payments', { meta: { name: 'p', type: 'service-client' } });
    const node = makeNode('orders', {
      meta: { name: 'o', type: 'command', relations: [{ portNames: ['default'], target: 'payments', type: 'calls' }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', node]]) });
    const p: WhenPredicate = { relations: { calls: { target_type: 'service-client' } } };
    expect(evaluateWhen(p, node, graph)).toBe(true);
  });

  it('relations.calls.target_type does not match', () => {
    const node = makeNode('orders', { meta: { name: 'o', type: 'command' } });
    const graph = makeGraph({ nodes: new Map([['orders', node]]) });
    const p: WhenPredicate = { relations: { calls: { target_type: 'service-client' } } };
    expect(evaluateWhen(p, node, graph)).toBe(false);
  });

  it('relations.calls.target exact path', () => {
    const node = makeNode('orders', {
      meta: { name: 'o', type: 'command', relations: [{ portNames: ['default'], target: 'payments/service', type: 'calls' }] },
    });
    const graph = makeGraph({
      nodes: new Map([
        ['orders', node],
        ['payments/service', makeNode('payments/service', { meta: { name: 'ps', type: 'service' } })],
      ]),
    });
    expect(evaluateWhen({ relations: { calls: { target: 'payments/service' } } }, node, graph)).toBe(true);
    expect(evaluateWhen({ relations: { calls: { target: 'payments/other' } } }, node, graph)).toBe(false);
  });

  it('relations.consumes_port matches when relation consumes the named port', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'p', type: 'service',
        ports: { charge: { description: 'charge', aspects: [] } },
      },
    });
    const node = makeNode('orders', {
      meta: { name: 'o', type: 'command', relations: [{ target: 'payments', type: 'calls', portNames: ['charge'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', node]]) });
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'charge' } } }, node, graph)).toBe(true);
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'refund' } } }, node, graph)).toBe(false);
  });

  it('consumes_port: default matches a relation that named nothing at all — a DELIBERATE behavior change: the parser normalizes an undeclared relation to portNames: [default], so the implicit port is now a real match target, not just a name that happens to never appear', () => {
    const target = makeNode('payments', {
      meta: {
        name: 'p', type: 'service',
        ports: { charge: { description: 'charge', aspects: [] } },
      },
    });
    const bare = makeNode('orders', {
      meta: { name: 'o', type: 'command', relations: [{ target: 'payments', type: 'calls', portNames: ['default'] }] },
    });
    const graph = makeGraph({ nodes: new Map([['payments', target], ['orders', bare]]) });
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'default' } } }, bare, graph)).toBe(true);
    // Naming only the implicit port never satisfies a REAL port name — a
    // relation is named-in-full, not partially: it enters through exactly
    // what it named.
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'charge' } } }, bare, graph)).toBe(false);
  });

  it('descendants.relations matches when a child has the relation', () => {
    const child = makeNode('orders/handler', {
      meta: { name: 'h', type: 'handler', relations: [{ portNames: ['default'], target: 'payments', type: 'calls' }] },
    });
    const target = makeNode('payments', { meta: { name: 'p', type: 'service-client' } });
    const parent = makeNode('orders', { meta: { name: 'o', type: 'module' }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({
      nodes: new Map([['orders', parent], ['orders/handler', child], ['payments', target]]),
    });
    expect(evaluateWhen({
      descendants: { relations: { calls: { target_type: 'service-client' } } },
    }, parent, graph)).toBe(true);
  });

  it('descendants.type matches', () => {
    const child = makeNode('orders/cmd', { meta: { name: 'c', type: 'command' } });
    const parent = makeNode('orders', { meta: { name: 'o', type: 'module' }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({ nodes: new Map([['orders', parent], ['orders/cmd', child]]) });
    expect(evaluateWhen({ descendants: { type: 'command' } }, parent, graph)).toBe(true);
    expect(evaluateWhen({ descendants: { type: 'handler' } }, parent, graph)).toBe(false);
  });

  it('descendants.has_port matches', () => {
    const child = makeNode('orders/api', {
      meta: { name: 'a', type: 'service', ports: { charge: { description: 'c', aspects: [] } } },
    });
    const parent = makeNode('orders', { meta: { name: 'o', type: 'module' }, children: [child] });
    child.parent = parent;
    const graph = makeGraph({ nodes: new Map([['orders', parent], ['orders/api', child]]) });
    expect(evaluateWhen({ descendants: { has_port: 'charge' } }, parent, graph)).toBe(true);
  });

  it('node.type matches', () => {
    const node = makeNode('x', { meta: { name: 'x', type: 'command' } });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    expect(evaluateWhen({ node: { type: 'command' } }, node, graph)).toBe(true);
    expect(evaluateWhen({ node: { type: 'service' } }, node, graph)).toBe(false);
  });

  it('node.has_port matches', () => {
    const node = makeNode('x', {
      meta: { name: 'x', type: 'service', ports: { charge: { description: 'c', aspects: [] } } },
    });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    expect(evaluateWhen({ node: { has_port: 'charge' } }, node, graph)).toBe(true);
    expect(evaluateWhen({ node: { has_port: 'refund' } }, node, graph)).toBe(false);
  });

  it('node.has_mapping matches true and false', () => {
    const mapped = makeNode('m', { meta: { name: 'm', type: 'service', mapping: ['src/x.ts'] } });
    const unmapped = makeNode('u', { meta: { name: 'u', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['m', mapped], ['u', unmapped]]) });
    expect(evaluateWhen({ node: { has_mapping: true } }, mapped, graph)).toBe(true);
    expect(evaluateWhen({ node: { has_mapping: false } }, mapped, graph)).toBe(false);
    expect(evaluateWhen({ node: { has_mapping: true } }, unmapped, graph)).toBe(false);
    expect(evaluateWhen({ node: { has_mapping: false } }, unmapped, graph)).toBe(true);
  });

  it('node.id matches the exact path and only the exact path', () => {
    const a = makeNode('a/b', { meta: { name: 'a/b', type: 'service' } });
    const graph = makeGraph({
      nodes: new Map([
        ['a/b', a],
        ['a/c', makeNode('a/c', { meta: { name: 'a/c', type: 'service' } })],
        ['a/b/c', makeNode('a/b/c', { meta: { name: 'a/b/c', type: 'service' } })],
      ]),
    });
    expect(evaluateWhen({ node: { id: 'a/b' } }, a, graph)).toBe(true);
    expect(evaluateWhen({ node: { id: 'a/b' } }, graph.nodes.get('a/c')!, graph)).toBe(false);
    expect(evaluateWhen({ node: { id: 'a/b' } }, graph.nodes.get('a/b/c')!, graph)).toBe(false);
  });

  it('node.id list matches any of its entries, and only those', () => {
    const a = makeNode('a', { meta: { name: 'a', type: 'service' } });
    const b = makeNode('b', { meta: { name: 'b', type: 'service' } });
    const c = makeNode('c', { meta: { name: 'c', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['a', a], ['b', b], ['c', c]]) });
    const p: WhenPredicate = { node: { id: ['a', 'b'] } };
    expect(evaluateWhen(p, a, graph)).toBe(true);
    expect(evaluateWhen(p, b, graph)).toBe(true);
    expect(evaluateWhen(p, c, graph)).toBe(false);
  });

  it('not: around node.id inverts the match', () => {
    const a = makeNode('a/b', { meta: { name: 'a/b', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['a/b', a]]) });
    expect(evaluateWhen({ not: { node: { id: 'a/b' } } }, a, graph)).toBe(false);
    expect(evaluateWhen({ not: { node: { id: 'a/c' } } }, a, graph)).toBe(true);
  });

  it('node.id combined with type is an AND within the clause', () => {
    const a = makeNode('a/b', { meta: { name: 'a/b', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['a/b', a]]) });
    expect(evaluateWhen({ node: { id: 'a/b', type: 'service' } }, a, graph)).toBe(true);
    expect(evaluateWhen({ node: { id: 'a/b', type: 'inny' } }, a, graph)).toBe(false);
  });

  it('node.id matches unicode and space characters literally', () => {
    const node = makeNode('usługi/płatności moduł', { meta: { name: 'x', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['usługi/płatności moduł', node]]) });
    expect(evaluateWhen({ node: { id: 'usługi/płatności moduł' } }, node, graph)).toBe(true);
    expect(evaluateWhen({ node: { id: 'uslugi/platnosci modul' } }, node, graph)).toBe(false);
  });

  it('node.id does not normalize backslashes to forward slashes', () => {
    const node = makeNode('a/b', { meta: { name: 'a/b', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['a/b', node]]) });
    expect(evaluateWhen({ node: { id: 'a\\b' } }, node, graph)).toBe(false);
  });

  it('all_of requires every clause true', () => {
    const node = makeNode('x', { meta: { name: 'x', type: 'command' } });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    expect(evaluateWhen({ all_of: [{ node: { type: 'command' } }, { node: { has_mapping: false } }] }, node, graph)).toBe(true);
    expect(evaluateWhen({ all_of: [{ node: { type: 'command' } }, { node: { has_mapping: true } }] }, node, graph)).toBe(false);
  });

  it('any_of requires at least one clause true', () => {
    const node = makeNode('x', { meta: { name: 'x', type: 'service' } });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    expect(evaluateWhen({ any_of: [{ node: { type: 'command' } }, { node: { type: 'service' } }] }, node, graph)).toBe(true);
    expect(evaluateWhen({ any_of: [{ node: { type: 'command' } }, { node: { type: 'handler' } }] }, node, graph)).toBe(false);
  });

  it('not negates', () => {
    const node = makeNode('x', { meta: { name: 'x', type: 'command' } });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    expect(evaluateWhen({ not: { node: { type: 'service' } } }, node, graph)).toBe(true);
    expect(evaluateWhen({ not: { node: { type: 'command' } } }, node, graph)).toBe(false);
  });

  it('implicit all_of over multiple atomic keys', () => {
    const node = makeNode('x', {
      meta: { name: 'x', type: 'command', mapping: ['src/x.ts'] },
    });
    const graph = makeGraph({ nodes: new Map([['x', node]]) });
    const p: WhenPredicate = {
      node: { type: 'command' },
      descendants: { has_port: 'nope' }, // false
    } as WhenPredicate;
    expect(evaluateWhen(p, node, graph)).toBe(false);
  });
});
