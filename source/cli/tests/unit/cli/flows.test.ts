import { describe, it, expect } from 'vitest';
import type { Graph, FlowDef } from '../../../src/model/graph.js';
import { formatFlowsOutput } from '../../../src/cli/flows.js';

function makeFlow(id: string, overrides: Partial<FlowDef> = {}): FlowDef {
  return {
    path: id,
    name: id.charAt(0).toUpperCase() + id.slice(1) + ' Flow',
    description: `Description of ${id} flow`,
    nodes: ['service/a', 'service/b'],
    aspects: [],
    artifacts: [],
    ...overrides,
  };
}

function makeGraph(flows: FlowDef[]): Graph {
  return {
    rootPath: '/fake',
    config: { version: '4.0.0' } as any,
    architecture: null as any,
    nodes: new Map(),
    aspects: [],
    flows,
    schemas: [],
  };
}

describe('formatFlowsOutput', () => {
  it('shows participant count and node names', () => {
    const graph = makeGraph([makeFlow('checkout')]);
    const output = formatFlowsOutput(graph);
    expect(output).toContain('checkout');
    expect(output).toContain('Participants:');
    expect(output).toContain('service/a');
    expect(output).toContain('service/b');
  });

  it('shows flow aspects when present', () => {
    const graph = makeGraph([makeFlow('checkout', { aspects: ['audit-log', 'correlation'] })]);
    const output = formatFlowsOutput(graph);
    expect(output).toContain('Aspects:');
    expect(output).toContain('audit-log');
    expect(output).toContain('correlation');
  });

  it('omits aspects section when flow has no aspects', () => {
    const graph = makeGraph([makeFlow('simple', { aspects: [] })]);
    const output = formatFlowsOutput(graph);
    expect(output).not.toContain('Aspects:');
  });

  it('shows flow description', () => {
    const graph = makeGraph([makeFlow('checkout')]);
    const output = formatFlowsOutput(graph);
    expect(output).toContain('Description of checkout flow');
  });

  it('handles flow with no description', () => {
    const graph = makeGraph([makeFlow('bare', { description: undefined })]);
    const output = formatFlowsOutput(graph);
    expect(output).toContain('Bare Flow');
    expect(output).not.toContain('undefined');
  });

  it('sorts flows by name', () => {
    const graph = makeGraph([
      makeFlow('zzz-flow'),
      makeFlow('aaa-flow'),
    ]);
    const output = formatFlowsOutput(graph);
    const aaaIdx = output.indexOf('Aaa-flow');
    const zzzIdx = output.indexOf('Zzz-flow');
    expect(aaaIdx).toBeLessThan(zzzIdx);
  });

  it('returns empty string for no flows', () => {
    const graph = makeGraph([]);
    const output = formatFlowsOutput(graph);
    expect(output).toBe('');
  });
});
