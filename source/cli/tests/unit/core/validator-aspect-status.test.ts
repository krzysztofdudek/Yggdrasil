import { describe, it, expect, afterEach } from 'vitest';
import { validate } from '../../../src/core/validator.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';

describe('validator: aspect-status-downgrade', () => {
  afterEach(() => {
    cleanupTestGraphs();
  });

  it('detects node attach-site declaring status lower than aspect-default', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(true);
  });

  it('no downgrade when node attach equals aspect-default', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('no downgrade when node attach raises status above aspect-default', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('cross-channel: flow enforced + node attach advisory → downgrade on node site', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' } }],
      flows: [{ path: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(true);
  });

  it('explicit-equal-to-anchor accepted silently', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(false);
    expect(issues.some(i => (i.code as string) === 'aspect-status-redundant')).toBe(false);
  });

  it('empty other_sources: anchor falls back to aspect default', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some(i => i.code === 'aspect-status-downgrade')).toBe(true);
  });
});
