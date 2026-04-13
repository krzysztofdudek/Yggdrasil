import { describe, it, expect } from 'vitest';
import { GoogleProvider } from '../../../src/llm/google.js';
import type { LlmConfig } from '../../../src/model/graph.js';

const baseCfg: LlmConfig = {
  provider: 'google', model: 'gemini-2.5-flash', temperature: 0,
  consensus: 1, max_tokens: 'auto',
};

describe('GoogleProvider', () => {
  it('constructs with config', () => {
    expect(new GoogleProvider({ ...baseCfg, api_key: 'goog-test' })).toBeDefined();
  });

  it('isAvailable returns true when api_key set', async () => {
    expect(await new GoogleProvider({ ...baseCfg, api_key: 'goog-test' }).isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no api_key', async () => {
    expect(await new GoogleProvider(baseCfg).isAvailable()).toBe(false);
  });

  it('returns fallback on connection failure', async () => {
    const provider = new GoogleProvider({ ...baseCfg, api_key: 'goog-test', endpoint: 'http://localhost:99999' });
    const result = await provider.verifyAspect('test prompt');
    expect(result.satisfied).toBe(false);
  });
});
