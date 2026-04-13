import { describe, it, expect } from 'vitest';
import {
  fetchAnthropicModels,
  fetchOpenAIModels,
  fetchGoogleModels,
  fetchOllamaModels,
} from '../../../src/llm/model-fetcher.js';

describe('fetchAnthropicModels', () => {
  it('returns error for invalid API key', async () => {
    const result = await fetchAnthropicModels('invalid-key');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable endpoint', async () => {
    // Anthropic fetcher uses a fixed endpoint, so we test via invalid key
    // which will produce an HTTP error from the real endpoint or a network error
    const result = await fetchAnthropicModels('');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });
});

describe('fetchOpenAIModels', () => {
  it('returns error for invalid API key', async () => {
    const result = await fetchOpenAIModels('invalid-key');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it('returns error for unreachable endpoint', async () => {
    const result = await fetchOpenAIModels('test-key', 'http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });
});

describe('fetchGoogleModels', () => {
  it('returns error for invalid API key', async () => {
    const result = await fetchGoogleModels('invalid-key');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });
});

describe('fetchOllamaModels', () => {
  it('returns error for unreachable endpoint', async () => {
    const result = await fetchOllamaModels('http://localhost:1');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });
});
