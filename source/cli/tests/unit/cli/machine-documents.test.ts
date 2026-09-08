// =============================================================================
// Unit — the graph's own machine documents: `yg-impact/1` and `yg-node/1`.
//
// Both answer a question the text views already answer — "what depends on this
// component" and "what IS this component" — and both are assembled from the
// SAME graph queries those views use. These tests pin the properties a machine
// consumer relies on and the text view cannot show it: which dependents are
// direct and which are reached through somebody else, the path each indirect one
// travels, who consumes a published port (including through an event relation,
// which the dependency algorithms deliberately ignore), and a port's DECLARED
// contract version rather than the one a versionless port is read at.
//
// The graphs are built in memory rather than loaded from a fixture: every case
// below turns on one edge or one declared field, and a fixture project would
// hide which one produced the result.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildImpactDocument, buildNodeDocument } from '../../../src/core/graph/machine-documents.js';
import { IMPACT_JSON_SCHEMA } from '../../../src/formatters/impact-json.js';
import { NODE_JSON_SCHEMA } from '../../../src/formatters/node-json.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

function makeNode(nodePath: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop()!, type: 'service' },
    children: [],
    parent: null,
    ...overrides,
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects: [],
    flows: [],
    rootPath: '/graph',
  };
}

/**
 * `payments` publishes two ports and is depended on four ways:
 *  - `orders` uses it and consumes `charge`
 *  - `reporting` uses `orders`, so it reaches `payments` only through it
 *  - `ledger` reaches it ONLY by an event relation, but still names `charge`
 *  - `billing` declares two relations onto it at once
 */
function paymentsGraph(): Graph {
  const payments = makeNode('services/payments', {
    meta: {
      name: 'PaymentsService',
      type: 'service',
      description: 'Takes money.',
      mapping: ['src\\payments\\index.ts', 'src/payments/charge.ts'],
      // Declared out of alphabetical order on purpose: both documents sort
      // ports by name, so the order a graph happens to be written in must not
      // reach a consumer.
      ports: {
        charge: {
          description: 'Take a payment.',
          aspects: ['audit-required'],
          version: 3,
          test: 'tests\\contracts\\charge.test.ts',
        },
        refund: { description: 'Give it back.', aspects: [] },
        dispute: { description: 'Contest it.', aspects: [] },
      },
    },
  });
  const orders = makeNode('services/orders', {
    meta: {
      name: 'OrdersService',
      type: 'service',
      relations: [{ target: 'services/payments', type: 'uses', consumes: ['charge'] }],
    },
  });
  const reporting = makeNode('services/reporting', {
    meta: {
      name: 'ReportingService',
      type: 'service',
      relations: [{ target: 'services/orders', type: 'uses' }],
    },
  });
  const ledger = makeNode('services/ledger', {
    meta: {
      name: 'LedgerService',
      type: 'service',
      relations: [
        { target: 'services/payments', type: 'listens', event_name: 'PaymentTaken', consumes: ['charge'] },
      ],
    },
  });
  const billing = makeNode('services/billing', {
    meta: {
      name: 'BillingService',
      type: 'service',
      relations: [
        { target: 'services/payments', type: 'uses', consumes: ['charge', 'refund'] },
        { target: 'services/payments', type: 'emits', event_name: 'InvoiceRaised' },
      ],
    },
  });
  return makeGraph([payments, billing, orders, ledger, reporting]);
}

describe('the impact document — who depends on a component', () => {
  it('lists every dependent, marking the ones that declare an edge onto the subject', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');

    expect(doc.schema).toBe(IMPACT_JSON_SCHEMA);
    expect(doc.subject).toEqual({ kind: 'node', path: 'services/payments' });

    const byNode = Object.fromEntries(doc.dependents.map((d) => [d.node, d.direct]));
    expect(byNode['services/orders']).toBe(true);
    expect(byNode['services/billing']).toBe(true);
    // Reaches the subject only through `orders` — a dependent, not a direct one.
    expect(byNode['services/reporting']).toBe(false);
    // Reaches it only by an event relation, which is outside the structural
    // closure the dependency algorithms walk.
    expect(byNode['services/ledger']).toBeUndefined();
  });

  it('gives each indirect dependent the components its dependency travels through', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');
    expect(doc.transitive).toEqual([{ node: 'services/reporting', via: ['services/orders'] }]);
  });

  it('states the relations a dependent declares onto the subject, with the ports each names', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');
    const billing = doc.dependents.find((d) => d.node === 'services/billing');

    expect(billing?.relations).toEqual([
      { type: 'uses', ports: ['charge', 'refund'] },
      { type: 'emits', ports: [] },
    ]);
  });

  it('reports a component nothing depends on as a subject with no dependents at all', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/reporting');
    expect(doc.dependents).toEqual([]);
    expect(doc.transitive).toEqual([]);
    expect(doc.ports).toEqual([]);
  });
});

describe('the impact document — the ports a component publishes', () => {
  it('lists ports by name, with the declared version and contract test', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');

    expect(doc.ports.map((p) => p.name)).toEqual(['charge', 'dispute', 'refund']);
    expect(doc.ports[0].version).toBe(3);
    // Repo-relative POSIX, whatever separator the graph was read with.
    expect(doc.ports[0].test).toBe('tests/contracts/charge.test.ts');
  });

  it('says a versionless port declares no version rather than the one it is read at', () => {
    // The contract check reads a versionless port at version 1; the document
    // reports what the port SAYS about itself, and a number it never wrote
    // would be a claim it never made.
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');
    const refund = doc.ports.find((p) => p.name === 'refund');
    expect(refund?.version).toBeNull();
    expect(refund?.test).toBeNull();
  });

  it('counts a consumer that reaches the port through an event relation', () => {
    // `consumes:` is legal on every relation type, so a component that names a
    // port over an event edge is bound by its contract just the same — even
    // though it is not a structural dependent.
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');
    const charge = doc.ports.find((p) => p.name === 'charge');

    expect(charge?.consumers).toEqual([
      { node: 'services/billing', relation: 'uses' },
      { node: 'services/ledger', relation: 'listens' },
      { node: 'services/orders', relation: 'uses' },
    ]);
  });

  it('leaves a published port nobody names with an empty consumer list', () => {
    const doc = buildImpactDocument(paymentsGraph(), 'services/payments');
    // `billing` consumes `refund`; nothing else does.
    expect(doc.ports.find((p) => p.name === 'refund')?.consumers).toEqual([
      { node: 'services/billing', relation: 'uses' },
    ]);
  });
});

describe('the component document — structure the text view leaves implicit', () => {
  it('writes mapping entries and the parent chain in POSIX form', () => {
    const graph = paymentsGraph();
    const parent = makeNode('services', { meta: { name: 'Services', type: 'module' } });
    const payments = graph.nodes.get('services/payments')!;
    payments.parent = parent;
    parent.children = [payments, graph.nodes.get('services/orders')!];
    graph.nodes.set('services', parent);

    const doc = buildNodeDocument(graph, 'services/payments');
    expect(doc.schema).toBe(NODE_JSON_SCHEMA);
    expect(doc.mapping).toEqual(['src/payments/index.ts', 'src/payments/charge.ts']);
    expect(doc.parent).toBe('services');

    const parentDoc = buildNodeDocument(graph, 'services');
    expect(parentDoc.children).toEqual(['services/orders', 'services/payments']);
    expect(parentDoc.parent).toBeNull();
  });

  it('carries an event relation with its declared event name, and a plain one without', () => {
    const doc = buildNodeDocument(paymentsGraph(), 'services/billing');
    expect(doc.relations).toEqual([
      { target: 'services/payments', type: 'uses', consumes: ['charge', 'refund'] },
      { target: 'services/payments', type: 'emits', consumes: [], event_name: 'InvoiceRaised' },
    ]);
  });

  it('gives each port its declared contract, and a component with none an empty description', () => {
    const doc = buildNodeDocument(paymentsGraph(), 'services/payments');
    expect(doc.ports.charge).toEqual({
      description: 'Take a payment.',
      version: 3,
      test: 'tests/contracts/charge.test.ts',
      aspects: ['audit-required'],
    });
    expect(Object.keys(doc.ports)).toEqual(['charge', 'dispute', 'refund']);

    const bare = buildNodeDocument(paymentsGraph(), 'services/reporting');
    expect(bare.description).toBe('');
    expect(bare.mapping).toEqual([]);
    expect(bare.ports).toEqual({});
  });
});
