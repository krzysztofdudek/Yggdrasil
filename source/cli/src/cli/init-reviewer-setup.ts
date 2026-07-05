import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { fetchAnthropicModels, fetchOpenAIModels, fetchGoogleModels, fetchOllamaModels } from '../llm/model-fetcher.js';
import { testApiProvider, testCliProvider } from '../llm/reviewer-test.js';
import type { ReviewerProvider } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { debugWrite } from '../utils/debug-log.js';

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

export function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Provider vocabulary
// ---------------------------------------------------------------------------

const API_PROVIDERS: ReviewerProvider[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'ollama'];
const CLI_PROVIDERS: ReviewerProvider[] = ['claude-code', 'codex', 'gemini-cli'];
/** Every valid --provider value (free CLI-agent providers first, then API/local). */
export const ALL_PROVIDERS: ReviewerProvider[] = [...CLI_PROVIDERS, ...API_PROVIDERS];
/** Env var each API provider reads its key from, for non-interactive init. */
export const API_KEY_ENV: Partial<Record<ReviewerProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};
const CLAUDE_CODE_ALIASES = [
  { value: 'haiku', label: 'haiku' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
];

// ---------------------------------------------------------------------------
// Reviewer configuration flow
// ---------------------------------------------------------------------------

export function needsApiKey(provider: ReviewerProvider): boolean {
  return !CLI_PROVIDERS.includes(provider) && provider !== 'ollama';
}

export function needsEndpoint(provider: ReviewerProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}

async function promptApiKey(provider: ReviewerProvider): Promise<string> {
  const envVars: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    'openai-compatible': 'OPENAI_API_KEY',
  };
  const envVar = envVars[provider];
  const hint = envVar ? ` (or set ${envVar} env var)` : '';
  const key = await p.text({
    message: `API key for ${provider}${hint}`,
    placeholder: 'Stored in .yggdrasil/yg-secrets.yaml (gitignored)',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'API key cannot be empty' : undefined),
  });
  assertNotCancelled(key);
  return key.trim();
}

async function promptEndpoint(provider: ReviewerProvider): Promise<string> {
  const defaultEndpoint = provider === 'ollama' ? 'http://localhost:11434' : undefined;
  const endpoint = await p.text({
    message: provider === 'ollama'
      ? 'Ollama endpoint URL'
      : 'Endpoint URL (OpenAI-compatible API)',
    placeholder: defaultEndpoint,
    defaultValue: defaultEndpoint,
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Endpoint cannot be empty' : undefined),
  });
  assertNotCancelled(endpoint);
  return endpoint.trim();
}

async function fetchModels(
  provider: ReviewerProvider,
  apiKey: string,
  endpoint?: string,
): Promise<{ ok: boolean; models: string[]; error?: string; is401?: boolean }> {
  let result;
  switch (provider) {
    case 'anthropic':
      result = await fetchAnthropicModels(apiKey);
      break;
    case 'openai':
    case 'openai-compatible':
      result = await fetchOpenAIModels(apiKey, endpoint);
      break;
    case 'google':
      result = await fetchGoogleModels(apiKey);
      break;
    case 'ollama':
      result = await fetchOllamaModels(endpoint);
      break;
    default:
      return { ok: false, models: [], error: `Unsupported provider for model fetch: ${provider}` };
  }
  const is401 = !result.ok && result.error?.includes('401');
  return { ...result, is401 };
}

async function promptModelFromList(models: string[]): Promise<string> {
  const model = await p.select<string>({
    message: 'Select a model',
    options: models.map((m) => ({ value: m, label: m })),
  });
  assertNotCancelled(model);
  return model;
}

async function promptModelText(provider: ReviewerProvider): Promise<string> {
  let hint = '';
  if (provider === 'codex') {
    hint = ' (see https://platform.openai.com/docs/models)';
  } else if (provider === 'gemini-cli') {
    hint = ' (see https://ai.google.dev/gemini-api/docs/models)';
  }
  const model = await p.text({
    message: `Enter model name${hint}`,
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Model name cannot be empty' : undefined),
  });
  assertNotCancelled(model);
  return model.trim();
}

export async function runReviewerConfigFlow(): Promise<{
  provider: ReviewerProvider;
  model: string;
  apiKey?: string;
  endpoint?: string;
}> {
  // 1. Provider selection.
  // Free, no-key options come first and the installed-agent path is the default:
  // most adopters already run an agent CLI (Claude Code / Codex / Gemini), so the
  // reviewer needs no separate API key or bill. API providers follow for those who
  // want a dedicated key.
  const provider = await p.select<ReviewerProvider>({
    message: 'Which provider should verify your code?',
    initialValue: 'claude-code' as ReviewerProvider,
    options: [
      { value: 'claude-code' as ReviewerProvider, label: 'Claude Code', hint: 'CLI — free, no API key; uses installed claude' },
      { value: 'codex' as ReviewerProvider, label: 'Codex', hint: 'CLI — free, no API key; uses installed codex' },
      { value: 'gemini-cli' as ReviewerProvider, label: 'Gemini CLI', hint: 'CLI — free, no API key; uses installed gemini' },
      { value: 'ollama' as ReviewerProvider, label: 'Ollama', hint: 'Local — no API costs; needs a local install' },
      { value: 'anthropic' as ReviewerProvider, label: 'Anthropic', hint: 'API key — Claude models' },
      { value: 'openai' as ReviewerProvider, label: 'OpenAI', hint: 'API key — GPT models' },
      { value: 'google' as ReviewerProvider, label: 'Google', hint: 'API key — Gemini models' },
      { value: 'openai-compatible' as ReviewerProvider, label: 'OpenAI-compatible', hint: 'API key — custom endpoint' },
    ],
  });
  assertNotCancelled(provider);

  // CLI providers: no API key needed
  if (CLI_PROVIDERS.includes(provider)) {
    // Model selection for CLI providers
    let model: string;
    if (provider === 'claude-code') {
      const selected = await p.select<string>({
        message: 'Select model alias',
        options: CLAUDE_CODE_ALIASES,
      });
      assertNotCancelled(selected);
      model = selected;
    } else {
      model = await promptModelText(provider);
    }

    // Validate CLI is installed
    const s = p.spinner();
    s.start(`Checking ${provider} installation...`);
    const testResult = await testCliProvider(provider);
    s.stop(testResult.ok ? `${provider} found` : `${provider} not found`);

    if (!testResult.ok) {
      p.log.warning(`${provider} not found on PATH: ${testResult.error}`);
      p.log.info('You can install it later. Configuration will be saved.');
    }

    return { provider, model };
  }

  // API providers
  let apiKey = '';
  if (needsApiKey(provider)) {
    apiKey = await promptApiKey(provider);
  }

  let endpoint: string | undefined;
  if (needsEndpoint(provider)) {
    endpoint = await promptEndpoint(provider);
  }

  // Fetch models
  const s = p.spinner();
  s.start('Fetching available models...');
  let fetchResult = await fetchModels(provider, apiKey, endpoint);

  // On 401: re-prompt API key once
  if (fetchResult.is401 && needsApiKey(provider)) {
    s.stop('Authentication failed (401).');
    p.log.warning('Invalid API key. Please try again.');
    apiKey = await promptApiKey(provider);
    s.start('Retrying model fetch...');
    fetchResult = await fetchModels(provider, apiKey, endpoint);
  }

  let model: string;
  if (fetchResult.ok && fetchResult.models.length > 0) {
    s.stop(`Found ${fetchResult.models.length} models.`);
    model = await promptModelFromList(fetchResult.models);
  } else {
    s.stop(fetchResult.error ? `Could not fetch models: ${fetchResult.error}` : 'No models found.');
    p.log.info('Enter model name manually.');
    model = await promptModelText(provider);
  }

  // Validation test
  const testSpinner = p.spinner();
  testSpinner.start('Testing connection...');
  const testResult = await testApiProvider(provider, apiKey, model, endpoint);
  testSpinner.stop(testResult.ok ? 'Connection successful.' : 'Connection test failed.');

  if (!testResult.ok) {
    p.log.warning(`Test failed: ${testResult.error}`);
    p.log.info('Configuration will be saved anyway. You can fix it later.');
  }

  return { provider, model, apiKey: apiKey || undefined, endpoint };
}

// ---------------------------------------------------------------------------
// Write reviewer config into yg-config.yaml
// ---------------------------------------------------------------------------

/**
 * Name of the single tier `yg init` bootstraps. Shared by writeReviewerConfig
 * (which defines the tier in yg-config.yaml) and writeSecretsFile (which writes
 * the tier's api_key into the yg-secrets.yaml overlay) so the two never drift —
 * the secrets file is a 1:1 deep-merge overlay over the config and must address
 * the SAME tier.
 */
export const BOOTSTRAP_TIER_NAME = 'standard';

export async function writeReviewerConfig(
  yggRoot: string,
  config: { provider: ReviewerProvider; model: string; endpoint?: string },
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${configPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] writeReviewerConfig: ${configPath} not found (${e.message}), starting fresh`);
  }

  // Build reviewer section with a single-tier default.
  const tierConfig: Record<string, unknown> = { model: config.model };
  if (config.endpoint) {
    tierConfig.endpoint = config.endpoint;
  }
  if (API_PROVIDERS.includes(config.provider)) {
    tierConfig.temperature = 0;
  }

  raw.reviewer = {
    tiers: {
      [BOOTSTRAP_TIER_NAME]: {
        provider: config.provider,
        consensus: 1,
        max_prompt_chars: 50000,
        config: tierConfig,
      },
    },
  };

  await writeFile(configPath, yamlStringify(raw), 'utf-8');
}

// ---------------------------------------------------------------------------
// Write API key to yg-secrets.yaml
// ---------------------------------------------------------------------------

export async function writeSecretsFile(
  yggRoot: string,
  apiKey: string,
): Promise<void> {
  const secretsPath = path.join(yggRoot, 'yg-secrets.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(secretsPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${secretsPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] writeSecretsFile: ${secretsPath} not found (${e.message}), starting fresh`);
  }

  // yg-secrets.yaml is a 1:1 deep-merge overlay over yg-config.yaml — it mirrors
  // the SAME shape. The API key belongs to the tier's `config:` block (where the
  // reviewer reads it from the resolved tier), NOT a provider-level bucket: the
  // reviewer: section accepts only `default` and `tiers`, and distinct tiers may
  // use distinct providers — so the credential is per-tier, not per-provider.
  if (!raw.reviewer || typeof raw.reviewer !== 'object') {
    raw.reviewer = {};
  }
  const reviewerSection = raw.reviewer as Record<string, unknown>;
  if (!reviewerSection.tiers || typeof reviewerSection.tiers !== 'object') {
    reviewerSection.tiers = {};
  }
  const tiers = reviewerSection.tiers as Record<string, unknown>;
  if (!tiers[BOOTSTRAP_TIER_NAME] || typeof tiers[BOOTSTRAP_TIER_NAME] !== 'object') {
    tiers[BOOTSTRAP_TIER_NAME] = {};
  }
  const tier = tiers[BOOTSTRAP_TIER_NAME] as Record<string, unknown>;
  if (!tier.config || typeof tier.config !== 'object') {
    tier.config = {};
  }
  (tier.config as Record<string, unknown>).api_key = apiKey;

  await writeFile(secretsPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Shared flag+env → reviewer config resolver (non-interactive init paths)
// ---------------------------------------------------------------------------

export interface ResolvedReviewerConfig {
  provider: ReviewerProvider;
  model: string;
  endpoint?: string;
  apiKey?: string;
}

export type ResolveReviewerResult =
  | { ok: true; config: ResolvedReviewerConfig; keyWarning?: IssueMessage }
  | { ok: false; issue: IssueMessage };

/**
 * Resolve a reviewer config from flags + env for the non-interactive (pure-CLI)
 * init paths. Applies the model/endpoint defaults and reads the API key ONLY
 * from the provider's env var (never a flag). Returns structured data — it
 * NEVER writes to stderr or exits; the command layer (init.ts) renders the
 * result via buildIssueMessage so error emission stays in the `command` node.
 */
export function resolveReviewerConfigFromFlags(opts: {
  platform?: string;
  provider: ReviewerProvider;
  model?: string;
  endpoint?: string;
}): ResolveReviewerResult {
  const { provider } = opts;
  const platHint = opts.platform ? ` --platform ${opts.platform}` : ' --platform <name>';

  let model = opts.model?.trim();
  if (!model) {
    if (provider === 'claude-code') {
      model = 'sonnet';
    } else {
      return { ok: false, issue: {
        what: `--model is required for provider '${provider}'.`,
        why: 'Only claude-code has a built-in default model (sonnet); other providers must name the model explicitly.',
        next: `Re-run naming a model: yg init --provider ${provider} --model <name>${platHint}.`,
      } };
    }
  }

  let endpoint = opts.endpoint?.trim() || undefined;
  if (needsEndpoint(provider) && !endpoint) {
    if (provider === 'ollama') {
      endpoint = 'http://localhost:11434';
    } else {
      return { ok: false, issue: {
        what: `--endpoint is required for provider '${provider}'.`,
        why: 'An OpenAI-compatible provider has no default base URL — the reviewer needs an endpoint to call.',
        next: `Re-run naming an endpoint: yg init --provider ${provider} --model ${model} --endpoint <url>.`,
      } };
    }
  }

  let apiKey: string | undefined;
  let keyWarning: IssueMessage | undefined;
  if (needsApiKey(provider)) {
    const envVar = API_KEY_ENV[provider];
    apiKey = (envVar ? process.env[envVar] : undefined)?.trim() || undefined;
    if (!apiKey) {
      keyWarning = {
        what: `No API key found${envVar ? ` in $${envVar}` : ''}; wrote the config without one.`,
        why: 'An API provider needs a key before the reviewer can run; init records the config anyway so setup is not blocked.',
        next: `Set ${envVar ?? 'the provider API key environment variable'} (or add the key to .yggdrasil/yg-secrets.yaml) before running yg check --approve.`,
      };
    }
  }

  return { ok: true, config: { provider, model, endpoint, apiKey }, keyWarning };
}
