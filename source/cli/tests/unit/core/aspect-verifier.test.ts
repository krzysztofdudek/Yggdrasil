import { describe, it, expect, vi } from 'vitest';
import { verifyAspects } from '../../../src/llm/aspect-verifier.js';
import type { LlmProvider } from '../../../src/llm/types.js';

function mockProvider(responses: Array<{ satisfied: boolean; reason: string }>): LlmProvider {
  let callIndex = 0;
  return {
    verifyAspect: vi.fn(async () => responses[callIndex++] ?? { satisfied: true, reason: 'ok' }),
    reviewArtifact: vi.fn(async () => ({ current: true, reason: 'ok' })),
    isAvailable: vi.fn(async () => true),
    getContextWindowSize: vi.fn(async () => 8192),
  };
}

describe('verifyAspects', () => {
  it('returns satisfied for passing aspects', async () => {
    const provider = mockProvider([{ satisfied: true, reason: 'Code satisfies requirements' }]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test-aspect', contentFile: '# Test\nMust do X' }],
      sourceFiles: [{ path: 'test.ts', content: 'export function x() {}' }],
    });
    expect(results['test-aspect']).toEqual({ satisfied: true, reason: 'Code satisfies requirements' });
    expect(provider.verifyAspect).toHaveBeenCalledOnce();
  });

  it('returns not satisfied for failing aspects', async () => {
    const provider = mockProvider([{ satisfied: false, reason: 'Missing X' }]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test-aspect', contentFile: '# Test\nMust do X' }],
      sourceFiles: [{ path: 'test.ts', content: 'export function y() {}' }],
    });
    expect(results['test-aspect']).toEqual({ satisfied: false, reason: 'Missing X' });
  });

  it('verifies multiple aspects independently', async () => {
    const provider = mockProvider([
      { satisfied: true, reason: 'ok' },
      { satisfied: false, reason: 'fail' },
    ]);
    const results = await verifyAspects({
      provider,
      aspects: [
        { id: 'aspect-a', contentFile: 'content a' },
        { id: 'aspect-b', contentFile: 'content b' },
      ],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
    });
    expect(results['aspect-a'].satisfied).toBe(true);
    expect(results['aspect-b'].satisfied).toBe(false);
  });

  it('uses consensus voting when consensus > 1', async () => {
    const provider = mockProvider([
      { satisfied: true, reason: 'yes' },
      { satisfied: true, reason: 'yes' },
      { satisfied: false, reason: 'no' },
    ]);
    const results = await verifyAspects({
      provider,
      aspects: [{ id: 'test', contentFile: 'content' }],
      sourceFiles: [{ path: 'test.ts', content: 'code' }],
      consensus: 3,
    });
    expect(results['test'].satisfied).toBe(true);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(3);
  });
});
