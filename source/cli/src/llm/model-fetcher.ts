import { debugWrite } from '../utils/debug-log.js';

export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

const OPENAI_EXCLUDE = /^(whisper|tts|dall-e|text-embedding|embedding)/;

function fail(error: string): FetchModelsResult {
  return { ok: false, models: [], error };
}

export async function fetchAnthropicModels(apiKey: string): Promise<FetchModelsResult> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      debugWrite(`[model-fetcher] fetchAnthropicModels: ${msg}`);
      return fail(msg);
    }
    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map(m => m.id);
    return { ok: true, models };
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[model-fetcher] fetchAnthropicModels: ${msg}`);
    return fail(msg);
  }
}

export async function fetchOpenAIModels(apiKey: string, endpoint?: string): Promise<FetchModelsResult> {
  const base = endpoint ?? 'https://api.openai.com/v1';
  try {
    const res = await fetch(`${base}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      debugWrite(`[model-fetcher] fetchOpenAIModels: ${msg}`);
      return fail(msg);
    }
    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = (data.data ?? [])
      .map(m => m.id)
      .filter(id => !OPENAI_EXCLUDE.test(id));
    return { ok: true, models };
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[model-fetcher] fetchOpenAIModels: ${msg}`);
    return fail(msg);
  }
}

export async function fetchGoogleModels(apiKey: string): Promise<FetchModelsResult> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      debugWrite(`[model-fetcher] fetchGoogleModels: ${msg}`);
      return fail(msg);
    }
    const data = await res.json() as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };
    const models = (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
    return { ok: true, models };
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[model-fetcher] fetchGoogleModels: ${msg}`);
    return fail(msg);
  }
}

export async function fetchOllamaModels(endpoint?: string): Promise<FetchModelsResult> {
  const base = endpoint ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      debugWrite(`[model-fetcher] fetchOllamaModels: ${msg}`);
      return fail(msg);
    }
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map(m => m.name);
    return { ok: true, models };
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[model-fetcher] fetchOllamaModels: ${msg}`);
    return fail(msg);
  }
}
