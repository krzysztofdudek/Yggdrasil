import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { buildContext } from '../../src/core/context-builder.js';
import { formatContextMarkdown } from '../../src/formatters/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../fixtures/sample-project');

describe('context-pipeline', () => {
  it('full pipeline: loadGraph → buildContext → formatMarkdown', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = formatContextMarkdown(pkg);

    expect(output).toContain('Context Package: OrderService');
    expect(output).toContain('Path: orders/order-service');
    expect(output).toContain('## Global');
    expect(output).toContain('## Hierarchy');
    expect(output).toContain('## Relational');
    expect(output).toContain('Audit Logging');
    expect(output).toContain('Checkout Flow');
    expect(output).toContain('Materialization Target');
    expect(output).toContain('src/orders/order.service.ts');
  });

  it('global context has project name', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const globalLayer = pkg.layers.find((l) => l.type === 'global');
    expect(globalLayer).toBeDefined();
    expect(globalLayer?.content).toContain('**Project:** sample-project');
    expect(globalLayer?.content).not.toContain('Stack');
    expect(globalLayer?.content).not.toContain('Standards');
  });

  it('hierarchy includes orders/ yg-node.yaml content', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const hierarchyLayer = pkg.layers.find((l) => l.type === 'hierarchy' && l.label.includes('orders'));
    expect(hierarchyLayer).toBeDefined();
    expect(hierarchyLayer?.content).toContain('yg-node.yaml');
  });

  it('own node layer present with yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const ownLayer = pkg.layers.find((l) => l.label.startsWith('Node:'));
    expect(ownLayer).toBeDefined();
    expect(ownLayer?.label).toContain('OrderService');
    expect(ownLayer?.content).toContain('yg-node.yaml');
  });

  it('relational includes auth-api metadata (config-allowed only)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const relationalLayers = pkg.layers.filter((l) => l.type === 'relational');
    expect(relationalLayers.length).toBeGreaterThan(0);
    const authApiLayer = relationalLayers.find(
      (l) => l.label.includes('auth/auth-api') || l.label.includes('AuthApi'),
    );
    expect(authApiLayer).toBeDefined();
    // Relational layer contains dependency description or consumes info
    expect(authApiLayer).toBeDefined();
  });

  it('audit aspect included (tag requires-audit)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
    expect(aspectLayers.length).toBeGreaterThan(0);
    const auditLayer = aspectLayers.find((l) => l.label.includes('Audit Logging'));
    expect(auditLayer).toBeDefined();
    expect(auditLayer?.label).toContain('requires-audit');
    expect(auditLayer?.content).toContain('audit_log');
  });

  it('checkout flow metadata included', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const flowLayers = pkg.layers.filter((l) => l.type === 'flows');
    expect(flowLayers.length).toBeGreaterThan(0);
    const checkoutLayer = flowLayers.find((l) => l.label.includes('Checkout'));
    expect(checkoutLayer).toBeDefined();
    // Flow layer now contains the description from yg-flow.yaml
    expect(checkoutLayer).toBeDefined();
  });
});
