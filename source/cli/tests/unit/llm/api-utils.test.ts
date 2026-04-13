import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveApiKey, resolveMaxTokens, apiFetch } from '../../../src/llm/api-utils.js';
import type { LlmConfig } from '../../../src/model/graph.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const baseCfg: LlmConfig = {
  provider: 'openai', model: 'gpt-4.1-mini', temperature: 0,
  consensus: 1, max_tokens: 'auto',
};

describe('resolveApiKey', () => {
  afterEach(() => { delete process.env.OPENAI_API_KEY; });

  it('returns api_key from config when present', () => {
    expect(resolveApiKey({ ...baseCfg, api_key: 'sk-from-config' })).toBe('sk-from-config');
  });

  it('falls back to env var for openai', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    expect(resolveApiKey(baseCfg)).toBe('sk-from-env');
  });

  it('returns undefined when no key available', () => {
    expect(resolveApiKey(baseCfg)).toBeUndefined();
  });
});

describe('resolveMaxTokens', () => {
  it('returns explicit number from config', async () => {
    const provider = { getContextWindowSize: vi.fn(async () => 128000) } as unknown as LlmProvider;
    expect(await resolveMaxTokens({ ...baseCfg, max_tokens: 4096 }, provider)).toBe(4096);
  });

  it('auto-detects from provider', async () => {
    const provider = { getContextWindowSize: vi.fn(async () => 32000) } as unknown as LlmProvider;
    expect(await resolveMaxTokens(baseCfg, provider)).toBe(32000);
  });

  it('falls back to 8192 when provider returns undefined', async () => {
    const provider = { getContextWindowSize: vi.fn(async () => undefined) } as unknown as LlmProvider;
    expect(await resolveMaxTokens(baseCfg, provider)).toBe(8192);
  });
});

describe('apiFetch', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns response on success', async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);
    const res = await apiFetch('http://example.com/api', { method: 'POST' }, 'test');
    expect(res.status).toBe(200);
  });

  it('retries once on 429', async () => {
    const rateLimited = new Response('', { status: 429 });
    const success = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(success);
    const res = await apiFetch('http://example.com/api', { method: 'POST' }, 'test');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('throws after second failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'));
    await expect(apiFetch('http://example.com/api', { method: 'POST' }, 'test'))
      .rejects.toThrow('fail2');
  });
});
