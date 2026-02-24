import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { buildContext } from '../../src/core/context-builder.js';
import { validate } from '../../src/core/validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../fixtures/sample-project-with-knowledge');

describe('knowledge-pipeline integration', () => {
  it('loadGraph includes knowledge items from knowledge/', async () => {
    const graph = await loadGraph(FIXTURE);

    expect(graph.knowledge).toHaveLength(1);
    expect(graph.knowledge[0].name).toBe('Example Decision');
    expect(graph.knowledge[0].scope).toBe('global');
    expect(graph.knowledge[0].category).toBe('decisions');
    expect(graph.knowledge[0].path).toBe('decisions/001-example');
  });

  it('buildContext includes knowledge for scope global', async () => {
    const graph = await loadGraph(FIXTURE);
    const pkg = await buildContext(graph, 'orders/order-service');

    const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
    expect(knowledgeLayers.length).toBeGreaterThan(0);
    expect(knowledgeLayers.some((l) => l.label.toLowerCase().includes('example decision'))).toBe(
      true,
    );
  });

  it('validate passes for fixture with knowledge', async () => {
    const graph = await loadGraph(FIXTURE);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('loadGraph includes schemas when templates/ exists', async () => {
    const graph = await loadGraph(FIXTURE);
    expect(graph.schemas).toBeDefined();
  });
});
