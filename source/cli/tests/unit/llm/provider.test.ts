import { describe, it, expect } from 'vitest';
import { createLlmProvider } from '../../../src/llm/index.js';
import type { ReviewerProvider } from '../../../src/model/graph.js';

describe('LLM provider factory', () => {
  it('creates ollama provider', () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', temperature: 0, consensus: 1,
    });
    expect(provider).toBeDefined();
  });

  it('creates claude-code provider', () => {
    const provider = createLlmProvider({
      provider: 'claude-code', model: 'haiku', temperature: 0, consensus: 1,
    });
    expect(provider).toBeDefined();
  });

  it('throws on unknown provider', () => {
    expect(() => createLlmProvider({
      provider: 'unknown' as any, model: 'test', temperature: 0, consensus: 1,
    })).toThrow(/unknown/i);
  });
});

describe('Registry — all 9 providers register via index.ts', () => {
  const allProviders: ReviewerProvider[] = [
    'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
    'claude-code', 'codex', 'gemini-cli', 'copilot-cli',
  ];

  for (const name of allProviders) {
    it(`creates ${name} provider`, () => {
      const provider = createLlmProvider({
        provider: name, model: 'test', temperature: 0, consensus: 1,
        api_key: 'test-key',
      });
      expect(provider).toBeDefined();
    });
  }
});

describe('OllamaProvider', () => {
  it('returns false when ollama is not running', async () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', endpoint: 'http://localhost:99999',
      temperature: 0, consensus: 1,     });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('returns fallback on connection failure for verifyAspect', async () => {
    const provider = createLlmProvider({
      provider: 'ollama', model: 'test', endpoint: 'http://localhost:99999',
      temperature: 0, consensus: 1,     });
    const result = await provider.verifyAspect('test aspect prompt');
    expect(result.satisfied).toBe(false);
    // The reason names the transport failure, not a parse failure that never happened.
    expect(result.reason).toContain('Ollama request failed: could not reach');
    expect(result.reason).toContain('check config.endpoint');
  });
});
