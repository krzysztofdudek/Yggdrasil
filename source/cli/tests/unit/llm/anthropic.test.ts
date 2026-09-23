import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from '../../../src/llm/anthropic.js';
import type { LlmConfig } from '../../../src/model/graph.js';
import { vi } from 'vitest';
import { probeProvider } from '../../../src/llm/provider.js';

const baseCfg: LlmConfig = {
  provider: 'anthropic', model: 'claude-haiku-4-5-20251001', temperature: 0,
  consensus: 1,
};

describe('AnthropicProvider', () => {
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

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

describe('AnthropicProvider — failure reasons', () => {
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

  it('no key: unavailable, naming the variable to set — not "endpoint did not respond"', async () => {
    const probe = await probeProvider(new AnthropicProvider(baseCfg), 'anthropic');
    expect(probe).toEqual({ available: false, reason: 'no API key: set ANTHROPIC_API_KEY, or config.api_key for this tier in .yggdrasil/yg-secrets.yaml — nothing was sent' });
  });

  it('a 401 is reported as a refused key, a 404 as an unknown model', async () => {
    const statuses = [401, 404];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: statuses.shift()!, statusText: 'Nope' })));
    const p = new AnthropicProvider({ ...baseCfg, api_key: 'sk-ant-test', model: 'claude-nonexistent-9' });
    const first = await p.verifyAspect('prompt');
    expect(first.errorSource).toBe('provider');
    expect(first.reason).toBe('Anthropic request failed: HTTP 401 Nope — the API key was refused: check ANTHROPIC_API_KEY, or config.api_key for this tier in .yggdrasil/yg-secrets.yaml');
    const second = await p.verifyAspect('prompt');
    expect(second.reason).toContain("HTTP 404 Nope — not found: model 'claude-nonexistent-9' does not exist");
  });

  it('honours config.timeout and names it when the call times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
      return new Response('');
    }));
    const p = new AnthropicProvider({ ...baseCfg, api_key: 'sk-ant-test', timeout: 50 });
    const r = await p.verifyAspect('prompt');
    expect(r.reason).toContain('no response from https://api.anthropic.com within 0s');
    expect(r.reason).toContain('config.timeout');
  });
});
