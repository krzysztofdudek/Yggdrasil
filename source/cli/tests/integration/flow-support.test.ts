import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';
import { computeEffectiveAspects } from '../../src/core/effective-aspects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../fixtures/sample-project');
const CLI_ROOT = path.join(__dirname, '../..');

describe('flow-support integration', () => {
  it('scenario 1: flows load from flows/ directory', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.flows).toHaveLength(1);
    expect(graph.flows[0].name).toBe('Checkout Flow');
    expect(graph.flows[0].nodes).toContain('auth/auth-api');
    expect(graph.flows[0].nodes).toContain('orders/order-service');
  });

  it('scenario 2: status counting finds flows', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.flows.length).toBe(1);
  });

  it('scenario 3: check validation passes for valid fixture', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    // mapping-path-missing: users/missing-service maps src/users/missing.service.ts which doesn't exist on disk
    // (intentional fixture — used by drift tests to verify "missing" detection)
    const unexpectedErrors = errors.filter(
      (i) => !(i.code === 'mapping-path-missing' && i.nodePath === 'users/missing-service'),
    );
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('scenario 5: flow references model nodes', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const checkoutFlow = graph.flows.find((f) => f.name === 'Checkout Flow');

    expect(checkoutFlow).toBeDefined();
    for (const nodePath of checkoutFlow!.nodes) {
      expect(graph.nodes.has(nodePath)).toBe(true);
    }
  });

  it('scenario 6: FlowDef and graph.flows are populated', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(graph.flows).toBeDefined();
    expect(Array.isArray(graph.flows)).toBe(true);
  });

  it('tree output shows model hierarchy', () => {
    const distBin = path.join(CLI_ROOT, 'dist', 'bin.js');
    const result = spawnSync('node', [distBin, 'tree'], {
      cwd: FIXTURE_PROJECT,
      encoding: 'utf-8',
    });

    if (result.error?.message?.includes('ENOENT')) {
      return;
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auth');
    expect(result.stdout).toContain('orders');
    expect(result.stdout).toContain('order-service');
  });

  it('flow aspects propagate to participants via collectEffectiveAspectIds', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // checkout-flow has aspects: [requires-logging]
    // auth/auth-api is a participant → should get requires-logging
    const effective = computeEffectiveAspects(graph.nodes.get('auth/auth-api')!, graph);
    expect(effective.has('requires-logging')).toBe(true);
  });

  it('aspect implies chain resolves in fixture (requires-audit implies requires-logging)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // orders has aspect requires-audit which implies requires-logging
    const effective = computeEffectiveAspects(graph.nodes.get('orders')!, graph);
    expect(effective.has('requires-audit')).toBe(true);
    expect(effective.has('requires-logging')).toBe(true);
  });

  it('child inherits flow aspects via ancestor participation', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // orders/order-service is direct participant in checkout-flow
    // checkout-flow has aspects: [requires-logging]
    // order-service also has requires-audit (own) which implies requires-logging
    // Both paths should produce requires-logging in effective set
    const effective = computeEffectiveAspects(graph.nodes.get('orders/order-service')!, graph);
    expect(effective.has('requires-logging')).toBe(true);
    expect(effective.has('requires-audit')).toBe(true);
  });

  it('non-participant node without aspects has no effective aspects', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // users module has no own aspects and is not in any flow
    const effective = computeEffectiveAspects(graph.nodes.get('users')!, graph);
    expect(effective.size).toBe(0);
  });

});
