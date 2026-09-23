import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../../../src/llm/openai.js';
import type { LlmConfig } from '../../../src/model/graph.js';
import { vi } from 'vitest';

const baseCfg: LlmConfig = {
  provider: 'openai', model: 'gpt-4.1-mini', temperature: 0,
  consensus: 1,
};

describe('OpenAIProvider', () => {
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; });

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

describe('openai-compatible — the key is optional', () => {
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; });
  const compat: LlmConfig = { provider: 'openai-compatible', model: 'local', endpoint: 'http://127.0.0.1:8000/v1', temperature: 0, consensus: 1 };

  it('is available with no key, for a keyless local server', async () => {
    expect(await new OpenAIProvider(compat).isAvailable()).toBe(true);
  });

  it('sends no Authorization header when there is no key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"satisfied": true, "reason": "ok"}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new OpenAIProvider(compat).verifyAspect('prompt');
    expect(r).toEqual({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('never sends OPENAI_API_KEY to an openai-compatible endpoint', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"satisfied": true, "reason": "ok"}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAIProvider(compat).verifyAspect('prompt');
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('reads its own OPENAI_COMPATIBLE_API_KEY', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-compat';
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"satisfied": true, "reason": "ok"}' } }] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await new OpenAIProvider(compat).verifyAspect('prompt');
      const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-compat');
    } finally {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    }
  });

  it('the hosted openai provider still requires a key', async () => {
    expect(await new OpenAIProvider(baseCfg).isAvailable()).toBe(false);
  });
});
