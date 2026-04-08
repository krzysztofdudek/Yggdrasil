import { describe, it, expect } from 'vitest';
import { reviewArtifacts } from '../../../src/llm/artifact-reviewer.js';
import type { LlmProvider, ArtifactResponse } from '../../../src/llm/types.js';

function mockProvider(overrides: {
  reviewArtifact: (params: { artifactContent: string; artifactName: string; sourceCode: string; sourceFiles: string[] }) => Promise<ArtifactResponse>;
}, opts?: { needsChunking?: boolean }): LlmProvider {
  return {
    needsChunking: opts?.needsChunking ?? true,
    async verifyAspect() { return { satisfied: true, reason: 'ok' }; },
    reviewArtifact: overrides.reviewArtifact,
    async isAvailable() { return true; },
    async getContextWindowSize() { return 8192; },
  };
}

describe('artifact-reviewer', () => {
  it('marks artifact as not current when provider throws', async () => {
    const provider: LlmProvider = {
      needsChunking: true,
      async verifyAspect() { return { satisfied: true, reason: 'ok' }; },
      async reviewArtifact() { throw new Error('network error'); },
      async isAvailable() { return true; },
      async getContextWindowSize() { return 8192; },
    };
    const results = await reviewArtifacts({
      provider,
      artifacts: [{ name: 'responsibility.md', content: 'content' }],
      sourceFiles: [{ path: 'f.ts', content: 'code' }],
      maxTokens: 8192,
    });
    expect(results['responsibility.md'].current).toBe(false);
    expect(results['responsibility.md'].reason).toContain('Reviewer failed');
  });

  it('chunks source files when exceeding maxTokens', async () => {
    const calls: string[] = [];
    const provider: LlmProvider = {
      needsChunking: true,
      async verifyAspect() { return { satisfied: true, reason: 'ok' }; },
      async reviewArtifact(params) {
        calls.push(params.sourceCode.substring(0, 20));
        return { current: true, reason: 'ok' };
      },
      async isAvailable() { return true; },
      async getContextWindowSize() { return 8192; },
    };
    await reviewArtifacts({
      provider,
      artifacts: [{ name: 'responsibility.md', content: 'content' }],
      sourceFiles: [
        { path: 'a.ts', content: 'x'.repeat(200) },
        { path: 'b.ts', content: 'y'.repeat(200) },
      ],
      maxTokens: 75, // Forces chunking (75 * 4 * 0.7 = 210 chars — less than one file block)
    });
    expect(calls.length).toBe(2);
  });

  it('returns empty chunk fallback when no source files provided', async () => {
    const calls: Array<{ code: string; files: string[] }> = [];
    const provider = mockProvider({
      reviewArtifact: async (params) => {
        calls.push({ code: params.sourceCode, files: params.sourceFiles });
        return { current: true, reason: 'ok' };
      },
    });

    const results = await reviewArtifacts({
      provider,
      artifacts: [{ name: 'responsibility.md', content: 'content' }],
      sourceFiles: [],
      maxTokens: 8192,
    });

    expect(results['responsibility.md'].current).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].code).toBe('');
    expect(calls[0].files).toEqual([]);
  });

  it('returns per-artifact review results', async () => {
    const provider = mockProvider({
      reviewArtifact: async (params) => {
        if (params.artifactName === 'responsibility.md') {
          return { current: false, reason: 'Missing new function validateClaims' };
        }
        return { current: true, reason: 'up to date' };
      },
    });

    const results = await reviewArtifacts({
      provider,
      artifacts: [
        { name: 'responsibility.md', content: 'Old content...' },
        { name: 'interface.md', content: 'Current interface...' },
      ],
      sourceFiles: [{ path: 'validator.ts', content: 'function validateClaims() {}' }],
      maxTokens: 8192,
    });

    expect(results['responsibility.md'].current).toBe(false);
    expect(results['responsibility.md'].reason).toContain('validateClaims');
    expect(results['interface.md'].current).toBe(true);
  });
});
