import { describe, it, expect } from 'vitest';
import { testApiProvider, testCliProvider } from '../../../src/llm/reviewer-test.js';
// The CLI probe asks the provider registry, which the shipped CLI fills through its command tree.
import '../../../src/llm/index.js';

describe('testApiProvider', () => {
  it('returns error for unreachable Anthropic endpoint', async () => {
    const result = await testApiProvider('anthropic', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable OpenAI endpoint', async () => {
    const result = await testApiProvider('openai', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable openai-compatible endpoint', async () => {
    const result = await testApiProvider('openai-compatible', 'test-key', 'test-model', 'http://localhost:99999');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable Ollama endpoint', async () => {
    const result = await testApiProvider('ollama', '', 'test-model', 'http://localhost:99999');
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

describe('testCliProvider — names the cause and the install', () => {
  it('a CLI provider whose binary is not on PATH gets that provider install hint', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(await testCliProvider('codex')).toEqual({
        ok: false,
        error: "'codex' was not found on PATH — install the Codex CLI (npm i -g @openai/codex) and sign in with `codex login`",
      });
      const copilot = await testCliProvider('copilot-cli');
      expect(copilot.ok).toBe(false);
      expect(copilot.error).toContain('YG_COPILOT_BIN');
    } finally {
      process.env.PATH = saved;
    }
  });
});
