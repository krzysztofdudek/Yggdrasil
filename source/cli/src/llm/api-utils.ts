import type { LlmConfig } from '../model/graph.js';
import type { LlmProvider } from './types.js';
import { debugWrite } from '../utils/debug-log.js';

const ENV_VAR_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

export function resolveApiKey(config: LlmConfig): string | undefined {
  if (config.api_key) return config.api_key;
  const envVar = ENV_VAR_MAP[config.provider];
  return envVar ? process.env[envVar] : undefined;
}

export async function resolveMaxTokens(config: LlmConfig, provider: LlmProvider): Promise<number> {
  if (typeof config.max_tokens === 'number') return config.max_tokens;
  const detected = await provider.getContextWindowSize();
  return detected ?? 8192;
}

/** Retry-aware fetch. Retries once on 429 with 2s backoff. */
export async function apiFetch(url: string, init: RequestInit, providerName: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 && attempt === 0) {
        debugWrite(`[${providerName}] rate limited, retry in 2s`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return res;
    } catch (err) {
      debugWrite(`[${providerName}] fetch error attempt=${attempt}: ${(err as Error).message}`);
      if (attempt === 1) throw err;
    }
  }
  throw new Error('unreachable');
}
