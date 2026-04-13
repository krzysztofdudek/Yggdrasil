import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/llm/anthropic.js';
import type { LlmConfig } from '../../../src/model/graph.js';

const baseCfg: LlmConfig = {
  provider: 'anthropic', model: 'claude-haiku-4-5-20251001', temperature: 0,
  consensus: 1, max_tokens: 'auto',
};

describe('AnthropicProvider', () => {
  it('constructs with config', () => {
    expect(new AnthropicProvider({ ...baseCfg, api_key: 'sk-ant-test' })).toBeDefined();
  });

  it('isAvailable returns true when api_key set', async () => {
    expect(await new AnthropicProvider({ ...baseCfg, api_key: 'sk-ant-test' }).isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no api_key', async () => {
    expect(await new AnthropicProvider(baseCfg).isAvailable()).toBe(false);
  });

  it('returns fallback on connection failure', async () => {
    const provider = new AnthropicProvider({ ...baseCfg, api_key: 'sk-ant-test', endpoint: 'http://localhost:99999' });
    const result = await provider.verifyAspect('test prompt');
    expect(result.satisfied).toBe(false);
  });
});
