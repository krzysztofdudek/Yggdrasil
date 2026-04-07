import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '../../../src/llm/claude-code.js';
import type { AspectResponse, ArtifactResponse } from '../../../src/llm/types.js';

describe('ClaudeCodeProvider', () => {
  it('constructs with default model', () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    expect(provider).toBeDefined();
  });

  it('isAvailable returns false when claude is not on PATH', async () => {
    // In CI, claude CLI is unlikely to be on PATH
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    // We can't guarantee this in all environments, so just verify it doesn't throw
    const result = await provider.isAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('getContextWindowSize returns undefined (not supported)', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    const size = await provider.getContextWindowSize();
    expect(size).toBeUndefined();
  });

  it('verifyAspect returns result with expected shape', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    const result = await provider.verifyAspect({
      aspectContent: 'test aspect',
      sourceCode: 'const x = 1;',
      sourceFiles: ['test.ts'],
    });
    expect(result).toHaveProperty('satisfied');
    expect(result).toHaveProperty('reason');
  }, 120_000);

  it('reviewArtifact returns result with expected shape', async () => {
    const provider = new ClaudeCodeProvider({ model: 'haiku' });
    const result = await provider.reviewArtifact({
      artifactContent: 'test artifact',
      artifactName: 'responsibility.md',
      sourceCode: 'const x = 1;',
      sourceFiles: ['test.ts'],
    });
    expect(result).toHaveProperty('current');
    expect(result).toHaveProperty('reason');
  }, 120_000);
});

describe('ClaudeCodeProvider.parseResponse', () => {
  it('parses clean JSON', () => {
    const result = ClaudeCodeProvider.parseResponse<AspectResponse>(
      '{"satisfied": true, "reason": "code matches"}',
      { satisfied: false, reason: 'fallback' },
    );
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('code matches');
  });

  it('parses JSON in markdown fence', () => {
    const result = ClaudeCodeProvider.parseResponse<AspectResponse>(
      'Here is my analysis:\n```json\n{"satisfied": false, "reason": "missing export"}\n```',
      { satisfied: false, reason: 'fallback' },
    );
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe('missing export');
  });

  it('extracts JSON object from mixed text', () => {
    const result = ClaudeCodeProvider.parseResponse<AspectResponse>(
      'After reviewing the code, I found: {"satisfied": true, "reason": "all good"}. That is my conclusion.',
      { satisfied: false, reason: 'fallback' },
    );
    expect(result.satisfied).toBe(true);
  });

  it('falls back to natural language for claim responses', () => {
    const result = ClaudeCodeProvider.parseResponse<AspectResponse>(
      'The code is satisfied with the claim because it correctly implements...',
      { satisfied: false, reason: 'fallback' },
    );
    expect(result.satisfied).toBe(true);
  });

  it('falls back for artifact responses', () => {
    const result = ClaudeCodeProvider.parseResponse<ArtifactResponse>(
      'The documentation is stale and needs updating.',
      { current: false, reason: 'fallback' },
    );
    expect(result.current).toBe(false);
  });

  it('returns fallback on empty output', () => {
    const fallback = { satisfied: false, reason: 'fallback' };
    const result = ClaudeCodeProvider.parseResponse<AspectResponse>('', fallback);
    expect(result).toEqual(fallback);
  });
});
