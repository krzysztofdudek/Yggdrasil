export const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli', 'copilot-cli',
] as const;

/**
 * The model a tier's config.model falls back to when the tier omits it. Only
 * these CLI providers have one; every other provider — copilot-cli included,
 * whose seat policy decides which models it may use — must name its model. The
 * parser reads it, `yg init` writes the same model when --model is omitted for
 * claude-code (one default, so a tier written by init and a tier with the key
 * left out are judged by the same model), and the texts that name the providers
 * with a fallback (the config schema's required column, the issue-code fix) are
 * built from it.
 */
export const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  'claude-code': 'sonnet',
  'codex': 'o4-mini',
  'gemini-cli': 'gemini-2.5-flash',
};

/** The providers with a built-in model fallback, as prose: "claude-code, codex and gemini-cli". */
export function providersWithDefaultModel(): string {
  const names = Object.keys(PROVIDER_DEFAULT_MODELS);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The first-party API providers: each has one canonical endpoint, and the key
 * it sends is read from its own environment variable when no config.api_key is
 * set. `yg check` compares a committed config.endpoint against these (see
 * core/checks/credentials.ts and committedKeyEndpoint below) and warns about
 * one that is not the provider's own; the key is still sent. The providers
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
 * The endpoint named only in the committed yg-config.yaml that a tier sends the
 * developer's key to, when `yg check` should say so; undefined when there is
 * nothing to point out.
 *
 * The key is the developer's own — their environment variable, or a
 * config.api_key — while yg-config.yaml is shared: whoever last changed the
 * committed file decides where that key travels on the next
 * `yg check --approve`. That is allowed; the key is sent. The warning only
 * makes the destination visible on every check:
 *   - a first-party tier (anthropic, openai, google) at any endpoint other than
 *     the provider's own canonical one (plain http included), whatever the
 *     key's source;
 *   - an openai-compatible tier holding a `config.api_key` (in practice stored
 *     in yg-secrets.yaml for some earlier reviewer), which a committed switch
 *     of the provider carries to the server the committed file names.
 * An endpoint the tier names in yg-secrets.yaml is the developer's own choice
 * and is not pointed out. ollama and the CLI providers send no key.
 */
export function committedKeyEndpoint(config: {
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
