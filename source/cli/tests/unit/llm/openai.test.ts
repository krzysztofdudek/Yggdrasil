import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../../src/llm/openai.js';
import type { LlmConfig } from '../../../src/model/graph.js';

const baseCfg: LlmConfig = {
  provider: 'openai', model: 'gpt-4.1-mini', temperature: 0,
  consensus: 1, max_tokens: 'auto',
};

describe('OpenAIProvider', () => {
  it('constructs with config', () => {
    const provider = new OpenAIProvider({ ...baseCfg, api_key: 'sk-test' });
    expect(provider).toBeDefined();
  });

  it('isAvailable returns true when api_key set', async () => {
    const provider = new OpenAIProvider({ ...baseCfg, api_key: 'sk-test' });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no api_key', async () => {
    const provider = new OpenAIProvider(baseCfg);
    expect(await provider.isAvailable()).toBe(false);
  });

  it('returns fallback on connection failure', async () => {
    const provider = new OpenAIProvider({ ...baseCfg, api_key: 'sk-test', endpoint: 'http://localhost:99999' });
    const result = await provider.verifyAspect('test prompt');
    expect(result.satisfied).toBe(false);
  });

  it('getContextWindowSize returns undefined', async () => {
    const provider = new OpenAIProvider({ ...baseCfg, api_key: 'sk-test' });
    expect(await provider.getContextWindowSize()).toBeUndefined();
  });
});

describe('OpenAI-compatible (dual registration)', () => {
  it('constructs with custom endpoint', () => {
    const provider = new OpenAIProvider({
      ...baseCfg, provider: 'openai-compatible',
      api_key: 'sk-or-test', endpoint: 'https://openrouter.ai/api/v1',
    });
    expect(provider).toBeDefined();
  });

  it('uses custom endpoint — returns fallback on unreachable', async () => {
    const provider = new OpenAIProvider({
      ...baseCfg, provider: 'openai-compatible',
      api_key: 'sk-or-test', endpoint: 'http://localhost:99999',
    });
    const result = await provider.verifyAspect('test');
    expect(result.satisfied).toBe(false);
  });
});
