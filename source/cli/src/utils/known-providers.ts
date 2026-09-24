export const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli', 'copilot-cli',
] as const;

/**
 * The first-party API providers: each has one canonical endpoint, and the key
 * it sends is read from its own environment variable when no config.api_key is
 * set. `yg check` compares a committed config.endpoint against these (see
 * core/checks/credentials.ts); the providers themselves default to the same
 * endpoints (llm/anthropic.ts, llm/openai.ts, llm/google.ts).
 */
export const FIRST_PARTY_PROVIDERS: Readonly<Record<'anthropic' | 'openai' | 'google', { endpoint: string; envVar: string }>> = {
  anthropic: { endpoint: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY' },
  openai: { endpoint: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY' },
  google: { endpoint: 'https://generativelanguage.googleapis.com/v1beta', envVar: 'GOOGLE_API_KEY' },
};
