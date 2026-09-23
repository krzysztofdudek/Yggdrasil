import type { LlmConfig } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { redactedTail } from '../utils/redact.js';

const ENV_VAR_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  // Its own variable, never OPENAI_API_KEY: an OpenAI-compatible endpoint is any
  // server the config names, and an OpenAI key must never be sent to a third party.
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

/** How long a hosted API call may take when the tier sets no config.timeout. */
export const DEFAULT_API_TIMEOUT_MS = 60_000;

export function resolveApiKey(config: LlmConfig): string | undefined {
  if (config.api_key) return config.api_key;
  const envVar = ENV_VAR_MAP[config.provider];
  return envVar ? process.env[envVar] : undefined;
}

/** Where the key goes, for a message that says it is missing or refused. */
function keySource(provider: string): string {
  const envVar = Object.hasOwn(ENV_VAR_MAP, provider) ? ENV_VAR_MAP[provider] : undefined;
  return `${envVar ? `${envVar}, or ` : ''}config.api_key for this tier in .yggdrasil/yg-secrets.yaml`;
}

/** The reason an API provider without a key gives for being unavailable. */
export function missingKeyReason(provider: string): string {
  return `no API key: set ${keySource(provider)} — nothing was sent`;
}

/**
 * A failed HTTP answer, classified so the reader knows which knob to turn: the
 * key (401/403), the model name or endpoint path (404, and the 400 most APIs
 * give an unknown model), the plan's rate limit (429, already retried once), or
 * the provider's own servers (5xx). Only the status line is used — never the
 * body, which could carry response content.
 */
export function describeHttpFailure(provider: string, status: number, statusText: string, model: string): string {
  const head = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  if (status === 401) return `${head} — the API key was refused: check ${keySource(provider)}`;
  if (status === 403) return `${head} — access denied: the key lacks permission for model '${model}', or the account or organisation policy blocks it`;
  if (status === 404) return `${head} — not found: model '${model}' does not exist for this key, or config.endpoint points at the wrong path`;
  if (status === 400 || status === 422) return `${head} — request rejected: most often an unknown model name ('${model}') or a parameter this model does not accept`;
  if (status === 429) return `${head} — rate limit or quota exhausted, still refused after one retry; wait, or raise the plan's limit`;
  if (status >= 500) return `${head} — the provider's server failed; retry later`;
  return head;
}

/**
 * A request that got no HTTP answer at all: the timeout that aborted it, or the
 * network error underneath fetch's generic "fetch failed" (connection refused,
 * unknown host). The URL is reduced to its origin, so no query string is echoed.
 */
export function describeFetchFailure(err: unknown, url: string, timeoutMs: number): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  let where = url;
  try { where = new URL(url).origin; } catch { debugWrite(`[api-utils] describeFetchFailure: not a URL: ${url}`); }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `no response from ${where} within ${Math.round(timeoutMs / 1000)}s — raise config.timeout (seconds) for this tier, or check the server`;
  }
  const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return `could not reach ${where}: ${redactedTail(String(cause), 200)} — check config.endpoint and the network`;
}

/** Retry-aware fetch. Retries once on 429 with 2s backoff. */
export async function apiFetch(url: string, init: RequestInit, providerName: string, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
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
