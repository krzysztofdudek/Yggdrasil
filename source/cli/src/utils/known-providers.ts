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
 * The committed endpoint a first-party provider (anthropic, openai, google)
 * refuses to send its key to, or undefined when the key may go.
 *
 * The key is the developer's own — their environment variable, or their
 * yg-secrets.yaml — while yg-config.yaml is shared: whoever last changed the
 * committed file would otherwise decide where that key travels on the next
 * `yg check --approve`. So a first-party key goes only to the provider's own
 * endpoint, or to an endpoint the developer names locally: the tier's
 * `config.endpoint` in yg-secrets.yaml (the same URL as the committed one is
 * the explicit way to accept it). The overlay's value then wins, so a later
 * change to the committed endpoint cannot move the key either. Other providers
 * are out of scope: openai-compatible exists to call the endpoint the tier
 * names and reads its own variable for that purpose; ollama and the CLI
 * providers send no key.
 */
export function withheldCommittedEndpoint(config: { provider: string; endpoint?: string; endpointSource?: 'committed' | 'local' }): string | undefined {
  const firstParty = firstPartyProvider(config.provider);
  if (!firstParty || config.endpoint === undefined || config.endpointSource !== 'committed') return undefined;
  return isCanonicalEndpoint(firstParty, config.endpoint) ? undefined : config.endpoint.trim();
}
