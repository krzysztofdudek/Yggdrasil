import type { LlmConfig } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { redactedTail } from '../utils/redact.js';
import { withheldCommittedEndpoint } from '../utils/known-providers.js';

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

/**
 * The key a hosted provider sends. Precedence: the tier's `config.api_key`
 * (in practice from the gitignored yg-secrets.yaml overlay) outranks the
 * provider's environment variable. That is why `yg init` never writes an
 * environment key to the overlay, and removes a stored key whenever the tier
 * it belongs to is pointed at another provider or endpoint: a key left there
 * would win over the variable and travel to the new target. No key at all when
 * the tier's endpoint is a committed one the key is withheld from (see
 * withheldCommittedEndpoint).
 */
export function resolveApiKey(config: LlmConfig): string | undefined {
  if (keyBlockReason(config) !== undefined) return undefined;
  // A stored key withheld from a committed openai-compatible endpoint leaves
  // that provider's own variable, which exists for exactly that endpoint.
  if (config.api_key && withheldCommittedEndpoint(config) === undefined) return config.api_key;
  const envVar = ENV_VAR_MAP[config.provider];
  return envVar ? process.env[envVar] : undefined;
}

/**
 * Why no key may be sent for this tier at all, or undefined when one may: the
 * yg-secrets.yaml overlay is tracked by git (nothing in it is local), or the
 * tier's endpoint is a committed one the key is withheld from (see
 * withheldCommittedEndpoint) and no key remains that may go there.
 */
export function keyBlockReason(config: LlmConfig): string | undefined {
  if (config.secretsTracked === true) {
    return 'key withheld: .yggdrasil/yg-secrets.yaml is tracked by git, so it is shared like the committed configuration and nothing in it is a local choice — no API key is sent for any tier until it is untracked (git rm --cached .yggdrasil/yg-secrets.yaml); nothing was sent';
  }
  const withheld = withheldCommittedEndpoint(config);
  if (withheld === undefined) return undefined;
  if (config.provider === 'openai-compatible') {
    if (process.env[ENV_VAR_MAP['openai-compatible']]) return undefined;
    return `key withheld: config.endpoint (${withheld}) comes from the committed yg-config.yaml, and the api_key this tier holds in yg-secrets.yaml is not sent to an endpoint named only there — if the endpoint is yours, name it for this tier in .yggdrasil/yg-secrets.yaml (config.endpoint), or set OPENAI_COMPATIBLE_API_KEY; nothing was sent`;
  }
  return `key withheld: config.endpoint (${withheld}) comes from the committed yg-config.yaml and is not ${config.provider}'s own endpoint, so no API key is sent there — if the endpoint is yours, name it for this tier in .yggdrasil/yg-secrets.yaml (config.endpoint) to send the key; nothing was sent`;
}

/** Why a hosted provider is unavailable: no key may be sent for the tier, or there is none. */
export function unavailableKeyReason(config: LlmConfig): string {
  return keyBlockReason(config) ?? missingKeyReason(config.provider);
}

/** Where the key goes, for a message that says it is missing or refused. */
function keySource(provider: string): string {
  const envVar = Object.hasOwn(ENV_VAR_MAP, provider) ? ENV_VAR_MAP[provider] : undefined;
  return `${envVar ? `${envVar}, or ` : ''}config.api_key for this tier in .yggdrasil/yg-secrets.yaml`;
}

/** The reason an API provider without a key gives for being unavailable. */
function missingKeyReason(provider: string): string {
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
