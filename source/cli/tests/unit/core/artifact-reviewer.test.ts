import { describe, it, expect } from 'vitest';
import { reviewArtifacts } from '../../../src/core/artifact-reviewer.js';
import type { LlmProvider, ArtifactResponse } from '../../../src/llm/types.js';

function mockProvider(overrides: {
  reviewArtifact: (params: { artifactContent: string; artifactName: string; sourceCode: string; sourceFiles: string[] }) => Promise<ArtifactResponse>;
}): LlmProvider {
  return {
    async verifyClaim() { return { satisfied: true, reason: 'ok' }; },
    reviewArtifact: overrides.reviewArtifact,
    async isAvailable() { return true; },
    async getContextWindowSize() { return 8192; },
  };
}

describe('artifact-reviewer', () => {
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
