import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { resolveApiKey, apiFetch } from '../../../src/llm/api-utils.js';
import type { LlmConfig } from '../../../src/model/graph.js';
import { describeHttpFailure, describeFetchFailure, missingKeyReason, DEFAULT_API_TIMEOUT_MS } from '../../../src/llm/api-utils.js';

const baseCfg: LlmConfig = {
  provider: 'openai', model: 'gpt-4.1-mini', temperature: 0,
  consensus: 1,
};

describe('resolveApiKey', () => {
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
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

describe('reviewer failure classification', () => {
  it('names the env var and the secrets overlay when the key is missing', () => {
    expect(missingKeyReason('anthropic')).toBe('no API key: set ANTHROPIC_API_KEY, or config.api_key for this tier in .yggdrasil/yg-secrets.yaml — nothing was sent');
  });

  it.each([
    [401, 'the API key was refused: check ANTHROPIC_API_KEY'],
    [403, 'access denied'],
    [404, "model 'claude-nonexistent-9' does not exist"],
    [400, 'most often an unknown model name'],
    [429, 'rate limit or quota exhausted'],
    [503, "the provider's server failed"],
  ])('HTTP %i is classified', (status, expected) => {
    const s = describeHttpFailure('anthropic', status, 'X', 'claude-nonexistent-9');
    expect(s).toContain(`HTTP ${status} X`);
    expect(s).toContain(expected);
  });

  it('a timeout names the seconds and config.timeout', () => {
    const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(describeFetchFailure(err, 'https://api.example.com/v1/messages?x=1', 60_000))
      .toBe('no response from https://api.example.com within 60s — raise config.timeout (seconds) for this tier, or check the server');
  });

  it('a network error names the underlying cause, not "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeFetchFailure(err, 'http://127.0.0.1:8000/v1/chat/completions', 60_000))
      .toBe('could not reach http://127.0.0.1:8000: ECONNREFUSED — check config.endpoint and the network');
  });

  it('the hosted default timeout is 60s', () => {
    expect(DEFAULT_API_TIMEOUT_MS).toBe(60_000);
  });
});
