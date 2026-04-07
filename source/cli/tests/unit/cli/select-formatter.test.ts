import { describe, it, expect } from 'vitest';
import { formatEnrichedResult } from '../../../src/cli/select.js';
import type { EnrichedSelectResult } from '../../../src/core/node-selector.js';

describe('formatEnrichedResult', () => {
  it('outputs three sections: Nodes, Aspects, Flows', () => {
    const result: EnrichedSelectResult = {
      nodes: [{ node: 'orders/order-service', score: 10, name: 'OrderService' }],
      aspects: [
        {
          aspectId: 'requires-audit',
          name: 'Audit',
          matched: true,
          nodeCount: 1,
          readPaths: ['.yggdrasil/aspects/requires-audit/content.md'],
        },
      ],
      flows: [
        {
          flowPath: 'checkout-flow',
          name: 'Checkout',
          matched: false,
          nodeCount: 1,
          readPath: '.yggdrasil/flows/checkout-flow/description.md',
        },
      ],
    };
    const output = formatEnrichedResult(result, 'order audit');
    expect(output).toContain('Nodes:');
    expect(output).toContain('Aspects:');
    expect(output).toContain('Flows:');
    expect(output).toContain('orders/order-service');
    expect(output).toContain('requires-audit');
    expect(output).toContain('checkout-flow');
  });

  it('shows (matched) annotation for directly-matched aspects', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [
        {
          aspectId: 'error-handling',
          name: 'Error',
          matched: true,
          nodeCount: 0,
          readPaths: ['.yggdrasil/aspects/error-handling/content.md'],
        },
      ],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'error');
    expect(output).toContain('(matched)');
  });

  it('shows (N nodes) annotation for aspects on returned nodes', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [
        {
          aspectId: 'requires-audit',
          name: 'Audit',
          matched: false,
          nodeCount: 3,
          readPaths: ['.yggdrasil/aspects/requires-audit/content.md'],
        },
      ],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'audit');
    expect(output).toContain('(3 nodes)');
  });

  it('shows (matched, N nodes) when both conditions are true', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [
        {
          aspectId: 'requires-audit',
          name: 'Audit',
          matched: true,
          nodeCount: 2,
          readPaths: [],
        },
      ],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'audit');
    expect(output).toContain('(matched, 2 nodes)');
  });

  it('includes read: path for aspects', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [
        {
          aspectId: 'req',
          name: 'R',
          matched: true,
          nodeCount: 0,
          readPaths: ['.yggdrasil/aspects/req/content.md'],
        },
      ],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'req');
    expect(output).toContain('read: .yggdrasil/aspects/req/content.md');
  });

  it('shows (none) when sections are empty', () => {
    const result: EnrichedSelectResult = { nodes: [], aspects: [], flows: [] };
    const output = formatEnrichedResult(result, 'nothing');
    const noneCount = (output.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBe(3);
  });

  it('includes read: path for flows', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [],
      flows: [
        {
          flowPath: 'checkout-flow',
          name: 'Checkout',
          matched: true,
          nodeCount: 0,
          readPath: '.yggdrasil/flows/checkout-flow/description.md',
        },
      ],
    };
    const output = formatEnrichedResult(result, 'checkout');
    expect(output).toContain('read: .yggdrasil/flows/checkout-flow/description.md');
  });

  it('shows node name with em dash separator', () => {
    const result: EnrichedSelectResult = {
      nodes: [{ node: 'auth', score: 5, name: 'Authentication' }],
      aspects: [],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'auth');
    expect(output).toContain('auth — Authentication');
  });

  it('shows (matched, 1 node) with singular form', () => {
    const result: EnrichedSelectResult = {
      nodes: [],
      aspects: [
        {
          aspectId: 'requires-audit',
          name: 'Audit',
          matched: true,
          nodeCount: 1,
          readPaths: [],
        },
      ],
      flows: [],
    };
    const output = formatEnrichedResult(result, 'audit');
    expect(output).toContain('(matched, 1 node)');
  });
});
