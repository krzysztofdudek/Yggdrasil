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
    expect(output).toContain('## OwnArtifacts');
    expect(output).toContain('## Relational');
    expect(output).toContain('Audit Logging');
    expect(output).toContain('Checkout Flow');
    expect(output).toContain('Materialization Target');
    expect(output).toContain('src/orders/order.service.ts');
  });

  it('global context has stack info', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const globalLayer = pkg.layers.find((l) => l.type === 'global');
    expect(globalLayer).toBeDefined();
    expect(globalLayer?.content).toContain('TypeScript');
    expect(globalLayer?.content).toContain('NestJS');
    expect(globalLayer?.content).toContain('PostgreSQL');
  });

  it('hierarchy includes orders/ configured artifacts only', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const hierarchyLayer = pkg.layers.find((l) => l.type === 'hierarchy');
    expect(hierarchyLayer).toBeDefined();
    expect(hierarchyLayer?.label).toContain('orders');
    // Only config.artifacts (responsibility, interface, constraints, description) are included
    expect(hierarchyLayer?.content).toContain('responsibility');
    expect(hierarchyLayer?.content).toContain('description');
  });

  it('own artifacts present (only configured types)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const ownLayer = pkg.layers.find((l) => l.type === 'own');
    expect(ownLayer).toBeDefined();
    expect(ownLayer?.label).toContain('OrderService');
    // Only config.artifacts (responsibility, interface, constraints, description) are included
    expect(ownLayer?.content).toContain('responsibility');
    expect(ownLayer?.content).toContain('description');
  });

  it('relational includes auth-api artifacts (config-allowed only)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const relationalLayers = pkg.layers.filter((l) => l.type === 'relational');
    expect(relationalLayers.length).toBeGreaterThan(0);
    const authApiLayer = relationalLayers.find(
      (l) => l.label.includes('auth/auth-api') || l.label.includes('AuthApi'),
    );
    expect(authApiLayer).toBeDefined();
    expect(authApiLayer?.content).toContain('responsibility');
    expect(authApiLayer?.content).toContain('Auth API');
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

  it('checkout flow artifacts included', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');

    const flowLayers = pkg.layers.filter((l) => l.type === 'flows');
    expect(flowLayers.length).toBeGreaterThan(0);
    const checkoutLayer = flowLayers.find((l) => l.label.includes('Checkout'));
    expect(checkoutLayer).toBeDefined();
    expect(checkoutLayer?.content).toContain('sequence');
  });
});
