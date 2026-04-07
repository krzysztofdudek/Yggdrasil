import { describe, it, expect } from 'vitest';
import { runBatch } from '../../../src/cli/approve.js';

describe('runBatch', () => {
  it('returns results in input order regardless of completion order', async () => {
    const order: string[] = [];
    const approveOne = async (nodePath: string) => {
      const delay = nodePath === 'a' ? 20 : 5;
      await new Promise(r => setTimeout(r, delay));
      order.push(nodePath);
      return { action: 'approved' } as any;
    };
    const results = await runBatch(['a', 'b', 'c'], 3, approveOne);
    expect(results[0].nodePath).toBe('a');
    expect(results[1].nodePath).toBe('b');
    expect(results[2].nodePath).toBe('c');
    expect(order[0]).toBe('b'); // b/c complete before a
  });

  it('processes all nodes when concurrency=1 (sequential)', async () => {
    const processed: string[] = [];
    const approveOne = async (nodePath: string) => {
      processed.push(nodePath);
      return { action: 'approved' } as any;
    };
    await runBatch(['x', 'y', 'z'], 1, approveOne);
    expect(processed).toEqual(['x', 'y', 'z']);
  });

  it('processes all nodes when concurrency exceeds node count', async () => {
    const processed: string[] = [];
    const approveOne = async (nodePath: string) => {
      processed.push(nodePath);
      return { action: 'approved' } as any;
    };
    const results = await runBatch(['p', 'q'], 10, approveOne);
    expect(results).toHaveLength(2);
    expect(new Set(processed)).toEqual(new Set(['p', 'q']));
  });

  it('each node processed exactly once with concurrency=5 over 20 nodes', async () => {
    const callCount = new Map<string, number>();
    const nodes = Array.from({ length: 20 }, (_, i) => `node-${i}`);
    const approveOne = async (nodePath: string) => {
      callCount.set(nodePath, (callCount.get(nodePath) ?? 0) + 1);
      return { action: 'approved' } as any;
    };
    await runBatch(nodes, 5, approveOne);
    for (const node of nodes) {
      expect(callCount.get(node)).toBe(1);
    }
  });
});
