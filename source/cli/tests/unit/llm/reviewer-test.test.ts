import { describe, it, expect } from 'vitest';
import { testApiProvider, testCliProvider } from '../../../src/llm/reviewer-test.js';

describe('testApiProvider', () => {
  it('returns error for unreachable Anthropic endpoint', async () => {
    const result = await testApiProvider('anthropic', 'test-key', 'test-model', 'http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable OpenAI endpoint', async () => {
    const result = await testApiProvider('openai', 'test-key', 'test-model', 'http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable openai-compatible endpoint', async () => {
    const result = await testApiProvider('openai-compatible', 'test-key', 'test-model', 'http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable Ollama endpoint', async () => {
    const result = await testApiProvider('ollama', '', 'test-model', 'http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for invalid Google API key', async () => {
    const result = await testApiProvider('google', 'invalid-key', 'gemini-pro');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('testCliProvider', () => {
  it('returns error for unsupported API provider used as CLI', async () => {
    // 'ollama' is an API provider, not a CLI provider — should fail
    const result = await testCliProvider('ollama');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported');
  });

  it('returns error for unsupported CLI provider', async () => {
    const result = await testCliProvider('anthropic');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported');
  });
});
