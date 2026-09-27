export const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli', 'copilot-cli',
] as const;

/**
 * The first-party API providers: each has one canonical endpoint, and the key
 * it sends is read from its own environment variable when no config.api_key is
 * set. `yg check` compares a committed config.endpoint against these (see
 * core/checks/credentials.ts), and the providers withhold their key from a
 * committed endpoint that is not one of them (withheldCommittedEndpoint below); the providers
 * default to the same endpoints (llm/anthropic.ts, llm/openai.ts, llm/google.ts).
 */
const FIRST_PARTY_PROVIDERS: Readonly<Record<'anthropic' | 'openai' | 'google', { endpoint: string; envVar: string }>> = {
  anthropic: { endpoint: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY' },
  openai: { endpoint: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY' },
  google: { endpoint: 'https://generativelanguage.googleapis.com/v1beta', envVar: 'GOOGLE_API_KEY' },
};

/** The first-party provider's own entry, or undefined for any other provider name. */
export function firstPartyProvider(provider: string): { endpoint: string; envVar: string } | undefined {
  return Object.hasOwn(FIRST_PARTY_PROVIDERS, provider)
    ? FIRST_PARTY_PROVIDERS[provider as keyof typeof FIRST_PARTY_PROVIDERS]
    : undefined;
}

/**
 * Whether `endpoint` is the first-party provider's own canonical endpoint
 * (trailing slashes aside). Plain http never is: every canonical endpoint is
 * https.
 */
function isCanonicalEndpoint(provider: { endpoint: string }, endpoint: string): boolean {
  return endpoint.trim().replace(/\/+$/, '') === provider.endpoint;
}

/**
 * The committed endpoint a tier refuses to send the developer's key to, or
 * undefined when the key may go.
 *
 * The key is the developer's own — their environment variable, or their
 * yg-secrets.yaml — while yg-config.yaml is shared: whoever last changed the
 * committed file would otherwise decide where that key travels on the next
 * `yg check --approve`. So a key goes to an endpoint named only in the
 * committed file in two cases alone: it is a first-party provider's own
 * canonical endpoint, or the key is `OPENAI_COMPATIBLE_API_KEY`, the variable
 * that exists for whatever server an openai-compatible tier names. Everything
 * else needs the endpoint named for the tier in yg-secrets.yaml — the same URL
 * as the committed one is the explicit way to accept it — and then the local
 * value wins, so a later committed change cannot move the key either:
 *   - a first-party tier (anthropic, openai, google) at any other endpoint,
 *     whatever the key's source;
 *   - an openai-compatible tier whose key is a `config.api_key` (in practice
 *     stored in yg-secrets.yaml for some earlier reviewer): switching the
 *     committed provider to openai-compatible must not carry it to a new server.
 * ollama and the CLI providers send no key.
 */
export function withheldCommittedEndpoint(config: {
  provider: string;
  endpoint?: string;
  endpointSource?: 'committed' | 'local';
  api_key?: string;
}): string | undefined {
  if (config.endpoint === undefined || config.endpointSource !== 'committed') return undefined;
  const firstParty = firstPartyProvider(config.provider);
  if (firstParty !== undefined) return isCanonicalEndpoint(firstParty, config.endpoint) ? undefined : config.endpoint.trim();
  if (config.provider === 'openai-compatible' && config.api_key) return config.endpoint.trim();
  return undefined;
}
