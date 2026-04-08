import { describe, it, expect } from 'vitest';
import { createLlmProvider } from '../../../src/llm/provider.js';

describe('LLM provider factory', () => {
  it('creates ollama provider', () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', temperature: 0, consensus: 1, max_tokens: 'auto',
      verify_aspects: true, verify_artifacts: false,
    });
    expect(provider).toBeDefined();
  });

  it('creates claude-code provider', () => {
    const provider = createLlmProvider({
      provider: 'claude-code', model: 'haiku', temperature: 0, consensus: 1, max_tokens: 'auto',
      verify_aspects: true, verify_artifacts: false,
    });
    expect(provider).toBeDefined();
  });

  it('throws on unknown provider', () => {
    expect(() => createLlmProvider({
      provider: 'unknown' as any, model: 'test', temperature: 0, consensus: 1, max_tokens: 'auto',
      verify_aspects: true, verify_artifacts: false,
    })).toThrow(/unknown/i);
  });
});

describe('OllamaProvider', () => {
  it('returns false when ollama is not running', async () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', endpoint: 'http://localhost:99999',
      temperature: 0, consensus: 1, max_tokens: 'auto', verify_artifacts: false,
    });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('returns fallback on connection failure for verifyAspect', async () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', endpoint: 'http://localhost:99999',
      temperature: 0, consensus: 1, max_tokens: 'auto', verify_artifacts: false,
    });
    const result = await provider.verifyAspect({
      aspectContent: 'test', sourceCode: 'test', sourceFiles: ['test.ts'],
    });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('could not be parsed');
  });
});
