import { describe, it, expect } from 'vitest';
import { verifyClaims } from '../../../src/core/claim-verifier.js';
import type { LlmProvider, ClaimResponse } from '../../../src/llm/types.js';

function mockProvider(responses: ClaimResponse[]): LlmProvider {
  let callIndex = 0;
  return {
    async verifyClaim() { return responses[callIndex++] ?? { satisfied: false, reason: 'no response' }; },
    async reviewArtifact() { return { current: true, reason: 'ok' }; },
    async isAvailable() { return true; },
    async getContextWindowSize() { return 8192; },
  };
}

describe('claim-verifier', () => {
  it('returns per-claim results for a node', async () => {
    const provider = mockProvider([
      { satisfied: true, reason: 'no side effects found' },
      { satisfied: false, reason: 'Date.now() found on line 42' },
    ]);
    const results = await verifyClaims({
      provider,
      aspects: [{
        id: 'deterministic',
        claims: [
          { id: 'no-side-effects', claim: 'No side effects' },
          { id: 'pure-transforms', claim: 'Pure transforms' },
        ],
        contentFile: 'Determinism aspect content...',
      }],
      sourceFiles: [{ path: 'validator.ts', content: 'const x = Date.now();' }],
      consensus: 1,
      maxTokens: 8192,
    });

    expect(results['deterministic']['no-side-effects'].satisfied).toBe(true);
    expect(results['deterministic']['pure-transforms'].satisfied).toBe(false);
    expect(results['deterministic']['pure-transforms'].reason).toContain('Date.now()');
  });

  it('uses consensus majority vote with consensus=3', async () => {
    const provider = mockProvider([
      { satisfied: true, reason: 'ok' },
      { satisfied: false, reason: 'not ok' },
      { satisfied: true, reason: 'ok' },
    ]);
    const results = await verifyClaims({
      provider,
      aspects: [{
        id: 'test',
        claims: [{ id: 'c1', claim: 'claim' }],
        contentFile: 'content',
      }],
      sourceFiles: [{ path: 'f.ts', content: 'code' }],
      consensus: 3,
      maxTokens: 8192,
    });

    // 2/3 say satisfied → satisfied
    expect(results['test']['c1'].satisfied).toBe(true);
  });

  it('chunks source when exceeding maxTokens', async () => {
    const calls: string[] = [];
    const provider: LlmProvider = {
      async verifyClaim(params) {
        calls.push(params.sourceCode.substring(0, 20));
        return { satisfied: true, reason: 'ok' };
      },
      async reviewArtifact() { return { current: true, reason: 'ok' }; },
      async isAvailable() { return true; },
      async getContextWindowSize() { return 100; },
    };

    await verifyClaims({
      provider,
      aspects: [{ id: 'a', claims: [{ id: 'c', claim: 'test' }], contentFile: 'content' }],
      sourceFiles: [
        { path: 'a.ts', content: 'x'.repeat(200) },
        { path: 'b.ts', content: 'y'.repeat(200) },
      ],
      consensus: 1,
      maxTokens: 75, // Forces chunking (75 * 4 * 0.7 = 210 chars — less than one file block)
    });

    // Should have been called twice (one per chunk)
    expect(calls.length).toBe(2);
  });

  it('returns empty chunk when sourceFiles is empty', async () => {
    const provider = mockProvider([{ satisfied: true, reason: 'ok' }]);
    const results = await verifyClaims({
      provider,
      aspects: [{ id: 'a', claims: [{ id: 'c', claim: 'test' }], contentFile: 'content' }],
      sourceFiles: [], // empty — triggers fallback chunk
      consensus: 1,
      maxTokens: 8192,
    });
    expect(results['a']['c'].satisfied).toBe(true);
  });

  it('skips TODO claims and marks as not satisfied', async () => {
    const provider = mockProvider([]);
    const results = await verifyClaims({
      provider,
      aspects: [{
        id: 'test',
        claims: [{ id: 'c1', claim: 'TODO — write claim for this anchor' }],
        contentFile: 'content',
      }],
      sourceFiles: [{ path: 'f.ts', content: 'code' }],
      consensus: 1,
      maxTokens: 8192,
    });

    expect(results['test']['c1'].satisfied).toBe(false);
    expect(results['test']['c1'].reason).toContain('TODO');
  });
});
