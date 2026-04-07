import { describe, it, expect } from 'vitest';
import { selectNodes } from '../../../src/core/node-selector.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('selectNodes', () => {
  it('returns nodes matching task keywords', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'order lifecycle management', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node).toBe('orders/order-service');
  });

  it('scores responsibility.md higher than other artifacts', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'authentication module', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node).toBe('auth');
  });

  it('returns empty array when no keywords match', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'quantum blockchain singularity', 5);
    expect(results).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'order', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('sorts by score descending', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'order service', 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('scores interface.md with x2 weight', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // "cancelOrder" and "refund" only appear in interface.md of order-service
    const results = selectNodes(graph, 'cancel refund', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node).toBe('orders/order-service');
  });

  it('includes node name in results', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'order lifecycle', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBeDefined();
    expect(typeof results[0].name).toBe('string');
  });

  it('returns empty array for empty task string', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, '', 5);
    expect(results).toEqual([]);
  });

  it('returns empty array for stop-words-only task', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const results = selectNodes(graph, 'the is a', 5);
    expect(results).toEqual([]);
  });

  it('handles node with missing aspect gracefully', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // Add a reference to a non-existent aspect on a node
    const node = graph.nodes.get('orders/order-service')!;
    const originalAspects = node.meta.aspects;
    node.meta.aspects = [
      ...(originalAspects ?? []),
      { aspect: 'nonexistent-aspect' },
    ];

    const results = selectNodes(graph, 'order lifecycle management', 5);
    expect(results.length).toBeGreaterThan(0);

    // Restore
    node.meta.aspects = originalAspects;
  });

  it('scores internals.md with x1 weight (else branch)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // "denylist" and "HMAC" only appear in auth/internals.md
    const results = selectNodes(graph, 'denylist HMAC rotating keys', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node).toBe('auth');
  });

  describe('S2 flow-based fallback', () => {
    it('falls back to flow matching when no nodes match directly', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // "sequence" appears in checkout-flow/sequence.md but not in any node artifact
      const results = selectNodes(graph, 'sequence steps', 5);
      expect(results.length).toBeGreaterThan(0);
      const nodePaths = results.map((r) => r.node);
      // flow participants should be returned via S2 fallback
      expect(nodePaths.some((p) => p === 'orders/order-service' || p === 'auth/auth-api')).toBe(
        true,
      );
    });

    it('deduplicates participants appearing in multiple flows', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // Add a second flow that shares a participant with checkout-flow
      graph.flows.push({
        path: 'test-flow',
        name: 'test sequence overlap',
        nodes: ['orders/order-service', 'nonexistent/node'],
        artifacts: [{ filename: 'description.md', content: 'test sequence overlap' }],
      });
      const results = selectNodes(graph, 'sequence overlap', 10);
      // orders/order-service should appear only once
      const hits = results.filter((r) => r.node === 'orders/order-service');
      expect(hits.length).toBe(1);
    });

    it('returns empty when neither S1 nor S2 match', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const results = selectNodes(graph, 'quantum blockchain', 5);
      expect(results).toEqual([]);
    });
  });
});
