import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { Document, parse as yamlParse, parseDocument, stringify as yamlStringify, isMap, isScalar } from 'yaml';
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
const CLI_PROVIDERS: ReviewerProvider[] = ['claude-code', 'codex', 'gemini-cli', 'copilot-cli'];
/** The model names the copilot-cli reviewer accepts (it refuses any other at run time). */
const COPILOT_MODEL_NAME = /^[A-Za-z0-9._:-]+$/;
/** Every valid --provider value (free CLI-agent providers first, then API/local). */
export const ALL_PROVIDERS: ReviewerProvider[] = [...CLI_PROVIDERS, ...API_PROVIDERS];
/** Env var each API provider reads its key from, for non-interactive init. */
const API_KEY_ENV: Partial<Record<ReviewerProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};
const CLAUDE_CODE_ALIASES = [
  { value: 'haiku', label: 'haiku' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
];

// ---------------------------------------------------------------------------
// Reviewer configuration flow
// ---------------------------------------------------------------------------

function needsApiKey(provider: ReviewerProvider): boolean {
  return !CLI_PROVIDERS.includes(provider) && provider !== 'ollama';
}

function needsEndpoint(provider: ReviewerProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}

/**
 * The key the interactive flow will use, and whether init should store it.
 * A key that came from the provider's environment variable is used for the
 * model list and the connection test but never copied to disk: the reviewer
 * reads the same variable at run time, so a second copy in yg-secrets.yaml
 * would only be one more place for the secret to leak from.
 */
export interface ApiKeyAnswer {
  key: string;
  fromEnv: boolean;
}

/**
 * Ask for an API key without echoing it. The provider's environment variable
 * is read first: when it is set, an empty answer uses it, so a person who has
 * already exported the key never has to paste it. When it is not set, the
 * answer is required and is stored in yg-secrets.yaml. `offerEnv: false` is the
 * retry after the environment key was rejected, where falling back to the same
 * key again would only fail again.
 */
export async function promptApiKey(
  provider: ReviewerProvider,
  opts: { offerEnv?: boolean } = {},
): Promise<ApiKeyAnswer> {
  const envVar = API_KEY_ENV[provider];
  const envKey = opts.offerEnv === false ? undefined : (envVar ? process.env[envVar] : undefined)?.trim() || undefined;
  // An OpenAI-compatible server may take no key (a local vLLM, LM Studio or llama.cpp).
  const keyless = provider === 'openai-compatible' ? ' — leave empty for a keyless server' : '';
  const message = envKey
    ? `API key for ${provider} (press Enter to use $${envVar}, which is set; it is not copied to disk)`
    : `API key for ${provider} (input hidden; stored in .yggdrasil/yg-secrets.yaml, which is gitignored${envVar ? `; or cancel and export ${envVar}` : ''})${keyless}`;
  const key = await p.password({
    message,
    validate: (v) => (!envKey && provider !== 'openai-compatible' && (v ?? '').trim().length === 0 ? 'API key cannot be empty' : undefined),
  });
  assertNotCancelled(key);
  const typed = (key ?? '').trim();
  if (typed.length === 0 && envKey) return { key: envKey, fromEnv: true };
  return { key: typed, fromEnv: false };
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
  } else if (provider === 'copilot-cli') {
    hint = ' (one your Copilot plan allows, e.g. auto; the CLI refuses any other)';
  }
  const model = await p.text({
    message: `Enter model name${hint}`,
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Model name cannot be empty' : undefined),
  });
  assertNotCancelled(model);
  return model.trim();
}

/**
 * The answer "no reviewer for now" — a first-class outcome of the selection
 * below, not a failure to choose. Script rules, dependency control and the CI
 * gate all work with nothing configured, so a person who does not want to pick
 * a judge yet must be able to say so and still land on a working project.
 */
const NO_REVIEWER = 'none';

export interface ReviewerChoice {
  provider: ReviewerProvider;
  model: string;
  /** A key the person typed — the only kind init ever writes to yg-secrets.yaml. */
  apiKey?: string;
  endpoint?: string;
  /**
   * True when the flow asked for the key and got an answer (typed, the
   * environment variable, or deliberately none), so a key stored earlier
   * must not outrank it.
   */
  keyAnswered?: boolean;
}

export async function runReviewerConfigFlow(): Promise<ReviewerChoice | null> {
  // 1. Provider selection.
  // Free, no-key options come first and the installed-agent path is the default:
  // most adopters already run an agent CLI (Claude Code / Codex / Gemini), so the
  // reviewer needs no separate API key or bill. API providers follow for those who
  // want a dedicated key, and the deliberate "not yet" answer comes last.
  const selection = await p.select<ReviewerProvider | typeof NO_REVIEWER>({
    message: 'Which provider should verify your code?',
    initialValue: 'claude-code' as ReviewerProvider,
    options: [
      { value: 'claude-code' as ReviewerProvider, label: 'Claude Code', hint: 'CLI — free, no API key; uses installed claude' },
      { value: 'codex' as ReviewerProvider, label: 'Codex', hint: 'CLI — free, no API key; uses installed codex' },
      { value: 'gemini-cli' as ReviewerProvider, label: 'Gemini CLI', hint: 'CLI — free, no API key; uses installed gemini' },
      { value: 'copilot-cli' as ReviewerProvider, label: 'GitHub Copilot CLI', hint: 'CLI — no API key; uses installed copilot and your Copilot plan' },
      { value: 'ollama' as ReviewerProvider, label: 'Ollama', hint: 'Local — no API costs; needs a local install' },
      { value: 'anthropic' as ReviewerProvider, label: 'Anthropic', hint: 'API key — Claude models' },
      { value: 'openai' as ReviewerProvider, label: 'OpenAI', hint: 'API key — GPT models' },
      { value: 'google' as ReviewerProvider, label: 'Google', hint: 'API key — Gemini models' },
      { value: 'openai-compatible' as ReviewerProvider, label: 'OpenAI-compatible', hint: 'API key — custom endpoint' },
      { value: NO_REVIEWER, label: 'None for now', hint: 'Script rules, dependency control and the CI gate work without one' },
    ],
  });
  assertNotCancelled(selection);
  if (selection === NO_REVIEWER) return null;
  const provider: ReviewerProvider = selection;

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
    const testResult = await testCliProvider(provider, model);
    s.stop(testResult.ok ? `${provider} works` : `${provider} cannot review yet`);

    if (!testResult.ok) {
      p.log.warning(`${provider} cannot review on this machine: ${testResult.error}`);
      p.log.info('You can fix it later. Configuration will be saved.');
    }

    return { provider, model };
  }

  // API providers
  let apiKey = '';
  let keyFromEnv = false;
  if (needsApiKey(provider)) {
    ({ key: apiKey, fromEnv: keyFromEnv } = await promptApiKey(provider));
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
    ({ key: apiKey, fromEnv: keyFromEnv } = await promptApiKey(provider, { offerEnv: !keyFromEnv }));
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

  // Only a key the person typed is stored; one read from the environment stays there.
  return { provider, model, apiKey: keyFromEnv ? undefined : apiKey || undefined, endpoint, keyAnswered: needsApiKey(provider) };
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
const BOOTSTRAP_TIER_NAME = 'standard';

/**
 * The `parallel` value `yg init` writes for a CLI reviewer (claude-code,
 * codex, gemini-cli, copilot-cli) when the config does not set one yet.
 * The engine default is 1, and at one call at a time a first fill of a few
 * hundred pairs at 10-40 s each takes hours; nothing told the adopter that
 * the fix is one key. Four is the middle ground for a CLI reviewer: each call
 * is its own local process under the developer's own subscription, so the
 * limits that bite are that subscription's rate limit and the machine's
 * memory, not an API key's throughput tier — and four processes stay well
 * inside both while cutting the first fill's wall time about fourfold. API
 * providers are left at the default: their safe concurrency is set by the
 * key's rate-limit tier, which init cannot see.
 */
export const INIT_CLI_PARALLEL = 4;

const INIT_PARALLEL_COMMENT =
  ` How many reviewer calls run at once (engine default 1). yg init wrote ${INIT_CLI_PARALLEL} for a\n` +
  ` CLI reviewer: each call is its own local process under your subscription, and ${INIT_CLI_PARALLEL}\n` +
  ` cuts a first fill's wall time about ${INIT_CLI_PARALLEL}x while staying inside its rate limit.\n` +
  ` A tier with consensus N makes up to parallel x N calls at once. Lower it if\n` +
  ` the reviewer reports rate limiting; raise it if your plan allows more.`;

/**
 * Write the bootstrap reviewer tier into yg-config.yaml, editing the file as a
 * YAML document so everything else in it survives: the explanatory comments init
 * wrote (the absent-coverage note among them), a quoted `version`, the flow style
 * of a list. A fresh reviewer lands where init's placeholder comment ("Reviewer
 * configuration added by: yg init") sits, before `debug:`; an existing
 * reviewer section is replaced in place.
 */
export async function writeReviewerConfig(
  yggRoot: string,
  config: { provider: ReviewerProvider; model: string; endpoint?: string },
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let content = '';
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to read ${configPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] writeReviewerConfig: ${configPath} not found (${e.message}), starting fresh`);
  }
  const parsed = parseDocument(content);
  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse ${configPath}: ${parsed.errors[0].message}`);
  }
  // A missing or empty file (or a non-mapping) starts from an empty mapping.
  const doc: Document = isMap(parsed.contents) ? parsed : new Document({});

  // Build reviewer section with a single-tier default.
  const tierConfig: Record<string, unknown> = { model: config.model };
  if (config.endpoint) {
    tierConfig.endpoint = config.endpoint;
  }
  if (API_PROVIDERS.includes(config.provider)) {
    tierConfig.temperature = 0;
  }
  const reviewer = {
    tiers: {
      [BOOTSTRAP_TIER_NAME]: {
        provider: config.provider,
        consensus: 1,
        max_prompt_chars: 50000,
        config: tierConfig,
      },
    },
  };

  const map = doc.contents as unknown as { items: Array<{ key: unknown }> };
  if (doc.has('reviewer')) {
    doc.set('reviewer', doc.createNode(reviewer));
  } else {
    const pair = doc.createPair('reviewer', reviewer);
    const debugIdx = map.items.findIndex((p) => isScalar(p.key) && p.key.value === 'debug');
    if (debugIdx >= 0) {
      // Take over init's placeholder comment, which sits above `debug:`.
      const debugKey = map.items[debugIdx].key as { commentBefore?: string | null; spaceBefore?: boolean };
      const placeholder = debugKey.commentBefore ?? '';
      if (/Reviewer configuration added by: yg init/.test(placeholder)) {
        (pair.key as { commentBefore?: string }).commentBefore = placeholder.replace(/\n+$/, '');
        debugKey.commentBefore = null;
      }
      (pair.key as { spaceBefore?: boolean }).spaceBefore = true;
      debugKey.spaceBefore = true;
      map.items.splice(debugIdx, 0, pair);
    } else {
      map.items.push(pair);
    }
  }

  // A CLI reviewer gets a sensible `parallel` (see INIT_CLI_PARALLEL) — only
  // when the config has none: a value someone chose is never overwritten.
  if (CLI_PROVIDERS.includes(config.provider) && !doc.has('parallel')) {
    const parallelPair = doc.createPair('parallel', INIT_CLI_PARALLEL);
    (parallelPair.key as { commentBefore?: string }).commentBefore = INIT_PARALLEL_COMMENT;
    (parallelPair.key as { spaceBefore?: boolean }).spaceBefore = true;
    const reviewerIdx = map.items.findIndex((p) => isScalar(p.key) && p.key.value === 'reviewer');
    map.items.splice(reviewerIdx >= 0 ? reviewerIdx + 1 : map.items.length, 0, parallelPair);
  }

  await writeFile(configPath, doc.toString(), 'utf-8');
}

// ---------------------------------------------------------------------------
// Write API key to yg-secrets.yaml
// ---------------------------------------------------------------------------

/** Read yg-secrets.yaml as a plain mapping; an absent file is an empty one. */
async function readSecretsRaw(secretsPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(secretsPath, 'utf-8');
    const parsed = yamlParse(content) as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${secretsPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] readSecretsRaw: ${secretsPath} not found (${e.message}), starting fresh`);
    return {};
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function writeSecretsFile(
  yggRoot: string,
  apiKey: string,
): Promise<void> {
  const secretsPath = path.join(yggRoot, 'yg-secrets.yaml');
  const raw = await readSecretsRaw(secretsPath);

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
// Keep the stored key bound to the reviewer it was given for
// ---------------------------------------------------------------------------

/**
 * Where the bootstrap tier sends its requests: the provider and the endpoint,
 * with yg-secrets.yaml's overrides applied over yg-config.yaml exactly as the
 * config parser merges them. `undefined` when no such tier is configured.
 */
export interface ReviewerTarget {
  provider: string;
  endpoint?: string;
}

function tierOf(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const reviewer = raw.reviewer;
  if (!isPlainRecord(reviewer) || !isPlainRecord(reviewer.tiers)) return undefined;
  const tier = reviewer.tiers[BOOTSTRAP_TIER_NAME];
  return isPlainRecord(tier) ? tier : undefined;
}

function stringField(o: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The bootstrap tier's target as it stands on disk now. Read with plain YAML,
 * never the full config parser: init must be able to rewrite a config that
 * the parser would refuse.
 */
export async function readReviewerTarget(yggRoot: string): Promise<ReviewerTarget | undefined> {
  let committed: Record<string, unknown> = {};
  try {
    const parsed = yamlParse(await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8')) as unknown;
    if (isPlainRecord(parsed)) committed = parsed;
  } catch (err) {
    debugWrite(`[init] readReviewerTarget: yg-config.yaml unreadable (${(err as Error).message})`);
  }
  const overlay = await readSecretsRaw(path.join(yggRoot, 'yg-secrets.yaml'));
  return mergedTarget(tierOf(committed), tierOf(overlay));
}

function mergedTarget(
  committedTier: Record<string, unknown> | undefined,
  overlayTier: Record<string, unknown> | undefined,
): ReviewerTarget | undefined {
  const provider = stringField(overlayTier, 'provider') ?? stringField(committedTier, 'provider');
  if (provider === undefined) return undefined;
  const cfg = (t: Record<string, unknown> | undefined) => (isPlainRecord(t?.config) ? t.config : undefined);
  const endpoint = stringField(cfg(overlayTier), 'endpoint') ?? stringField(cfg(committedTier), 'endpoint');
  return { provider, ...(endpoint !== undefined ? { endpoint } : {}) };
}

/**
 * The target the bootstrap tier will have once init writes `next` into
 * yg-config.yaml: yg-secrets.yaml's own provider or endpoint override, when it
 * sets one, still wins over what init writes.
 */
export async function targetAfterWrite(yggRoot: string, next: ReviewerTarget): Promise<ReviewerTarget> {
  const overlayTier = tierOf(await readSecretsRaw(path.join(yggRoot, 'yg-secrets.yaml')));
  const committedTier: Record<string, unknown> = {
    provider: next.provider,
    config: next.endpoint !== undefined ? { endpoint: next.endpoint } : {},
  };
  return mergedTarget(committedTier, overlayTier) ?? next;
}

export function sameTarget(a: ReviewerTarget | undefined, b: ReviewerTarget | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.provider === b.provider && (a.endpoint ?? '') === (b.endpoint ?? '');
}

/**
 * Settle the stored key after init wrote a reviewer: `prev` is the target read
 * before the write. A stored key stays only when nothing else answered for
 * the key this run and the tier still sends to the same provider and endpoint
 * — the one case where keeping it cannot send it anywhere new.
 */
export async function settleStoredKey(
  yggRoot: string,
  prev: ReviewerTarget | undefined,
  choice: { provider: ReviewerProvider; endpoint?: string; apiKey?: string; keyAnswered: boolean },
): Promise<StoredKeyOutcome> {
  const next = await targetAfterWrite(yggRoot, { provider: choice.provider, ...(choice.endpoint ? { endpoint: choice.endpoint } : {}) });
  const keepStored = !choice.keyAnswered && sameTarget(prev, next);
  return reconcileSecretsKey(yggRoot, { apiKey: choice.apiKey, keepStored });
}

/**
 * The notice init prints about the key once settleStoredKey has run, so what
 * it says matches what the reviewer will actually send. `undefined` when
 * there is nothing to add to the environment-only keyWarning.
 */
export function storedKeyNotice(
  outcome: StoredKeyOutcome,
  prev: ReviewerTarget | undefined,
  keyEnvVar: string | undefined,
): IssueMessage | undefined {
  if (outcome === 'removed') {
    const was = prev ? ` (stored while the tier used ${prev.provider}${prev.endpoint ? ` at ${prev.endpoint}` : ''})` : '';
    return {
      what: `Removed the api_key .yggdrasil/yg-secrets.yaml held for this tier${was}.`,
      why: keyEnvVar
        ? `A key stored there outranks $${keyEnvVar}, so it — not the key you exported — would have been sent.`
        : 'A key stored there outranks the environment and goes to whatever provider and endpoint the tier names, so a key given for one reviewer is never kept for another.',
      next: keyEnvVar
        ? `Nothing to do: the reviewer reads $${keyEnvVar} at run time.`
        : 'If the new reviewer needs a key, export its environment variable or add config.api_key to this tier in .yggdrasil/yg-secrets.yaml.',
    };
  }
  if (outcome === 'kept') {
    return {
      what: 'Kept the api_key .yggdrasil/yg-secrets.yaml already holds for this tier; the reviewer will send it.',
      why: 'The tier still names the same provider and endpoint that key was stored for, and a key in yg-secrets.yaml outranks the environment variable.',
      next: 'Nothing to do. To use an environment variable instead, delete config.api_key from this tier in .yggdrasil/yg-secrets.yaml.',
    };
  }
  return undefined;
}

/** What reconcileSecretsKey did to the bootstrap tier's stored key. */
export type StoredKeyOutcome =
  /** A key the person typed was written. */
  | 'stored'
  /** A key already stored for the same provider and endpoint was left in place. */
  | 'kept'
  /** The stored key was deleted: it was given for another reviewer, or it would outrank the one chosen now. */
  | 'removed'
  /** No key is stored and none was typed. */
  | 'none';

/**
 * Bring `reviewer.tiers.<bootstrap>.config.api_key` in yg-secrets.yaml in line
 * with the reviewer init has just configured.
 *
 * The overlay's key outranks the provider's environment variable at run time
 * (see resolveApiKey), so a key left behind there by an earlier configuration
 * would be sent to whatever the tier now names — another provider's key to a
 * different company, or any key to an arbitrary endpoint. A stored key
 * therefore survives only when the caller says it may (`keepStored`, which it
 * grants only for an unchanged provider and endpoint with no other key chosen);
 * otherwise it is deleted. A typed key replaces it. Only the key is touched:
 * any other override in the file stays exactly as it was, and a file left with
 * nothing in it is removed.
 */
export async function reconcileSecretsKey(
  yggRoot: string,
  opts: { apiKey?: string; keepStored: boolean },
): Promise<StoredKeyOutcome> {
  if (opts.apiKey) {
    await writeSecretsFile(yggRoot, opts.apiKey);
    return 'stored';
  }
  const secretsPath = path.join(yggRoot, 'yg-secrets.yaml');
  const raw = await readSecretsRaw(secretsPath);
  const tier = tierOf(raw);
  const config = isPlainRecord(tier?.config) ? tier.config : undefined;
  if (config === undefined || !Object.hasOwn(config, 'api_key')) return 'none';
  if (opts.keepStored) return 'kept';

  delete config.api_key;
  // Prune the containers the key alone was holding up, innermost first.
  const reviewer = raw.reviewer as Record<string, unknown>;
  const tiers = reviewer.tiers as Record<string, unknown>;
  if (Object.keys(config).length === 0) delete (tier as Record<string, unknown>).config;
  if (Object.keys(tier as Record<string, unknown>).length === 0) delete tiers[BOOTSTRAP_TIER_NAME];
  if (Object.keys(tiers).length === 0) delete reviewer.tiers;
  if (Object.keys(reviewer).length === 0) delete raw.reviewer;

  if (Object.keys(raw).length === 0) {
    await unlink(secretsPath);
  } else {
    await writeFile(secretsPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
  }
  return 'removed';
}

// ---------------------------------------------------------------------------
// Shared flag+env → reviewer config resolver (non-interactive init paths)
// ---------------------------------------------------------------------------

export interface ResolvedReviewerConfig {
  provider: ReviewerProvider;
  model: string;
  endpoint?: string;
  /**
   * The provider's environment variable when it holds a key. The key itself is
   * never part of the result: the reviewer reads the same variable at run
   * time, so init has no reason to hold it, and nothing to copy to disk.
   */
  keyEnvVar?: string;
}

export type ResolveReviewerResult =
  | { ok: true; config: ResolvedReviewerConfig; keyWarning?: IssueMessage }
  | { ok: false; issue: IssueMessage };

/**
 * Resolve a reviewer config from flags + env for the non-interactive (pure-CLI)
 * init paths. Applies the model/endpoint defaults and looks for the API key
 * ONLY in the provider's env var (never a flag), reporting whether it is set
 * but never returning the key, so this path cannot copy it to disk. The
 * keyWarning describes the environment alone; persistReviewerConfig corrects
 * it against yg-secrets.yaml. Returns structured data — it
 * NEVER writes to stderr or exits; the command layer (init.ts) renders the
 * result via buildIssueMessage so error emission stays in the `command` node.
 */
export function resolveReviewerConfigFromFlags(opts: {
  provider: ReviewerProvider;
  model?: string;
  endpoint?: string;
}): ResolveReviewerResult {
  const { provider } = opts;

  let model = opts.model?.trim();
  if (!model) {
    if (provider === 'claude-code') {
      model = 'sonnet';
    } else {
      return { ok: false, issue: {
        what: `--model is required for provider '${provider}'.`,
        why: provider === 'copilot-cli'
          ? "copilot-cli has no default model: the organisation's Copilot policy decides which models a seat may use, and the CLI refuses any other instead of substituting one."
          : CLI_PROVIDERS.includes(provider)
            ? 'yg init writes the model into yg-config.yaml and picks one itself only for claude-code (sonnet). A tier whose config.model is left out falls back to a built-in model at run time (see the configuration reference), but init asks you to name the one you want.'
            : `An API provider has no default model; the tier must name one its account can call.`,
        next: provider === 'copilot-cli'
          ? `Re-run naming a model your Copilot plan allows, e.g. yg init --provider copilot-cli --model auto (auto lets Copilot pick).`
          : `Re-run naming a model: yg init --provider ${provider} --model <name>.`,
      } };
    }
  }
  if (provider === 'copilot-cli' && !COPILOT_MODEL_NAME.test(model)) {
    return { ok: false, issue: {
      what: `--model '${model}' is not a model name copilot-cli can pass on.`,
      why: "The copilot-cli reviewer refuses a model name with characters other than letters, digits, '.', '_', ':' and '-', because on Windows the name reaches a shell.",
      next: 'Re-run naming a model your Copilot plan allows, e.g. yg init --provider copilot-cli --model auto (auto lets Copilot pick).',
    } };
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

  let keyEnvVar: string | undefined;
  let keyWarning: IssueMessage | undefined;
  if (needsApiKey(provider)) {
    const envVar = API_KEY_ENV[provider];
    const envKey = (envVar ? process.env[envVar] : undefined)?.trim() || undefined;
    if (envKey) keyEnvVar = envVar;
    if (!envKey && provider === 'openai-compatible') {
      keyWarning = {
        what: `No API key found in $${envVar}; the reviewer will call ${endpoint} without one.`,
        why: 'An OpenAI-compatible server may need no key (a local vLLM, LM Studio or llama.cpp), so the key is optional for this provider.',
        next: `If the server wants a key, set ${envVar} or add config.api_key to this tier in .yggdrasil/yg-secrets.yaml. Note that ${envVar} is also the key the openai provider reads.`,
      };
    } else if (!envKey) {
      keyWarning = {
        what: `No API key found${envVar ? ` in $${envVar}` : ''}; wrote the config without one.`,
        why: 'An API provider needs a key before the reviewer can run; init records the config anyway so setup is not blocked.',
        next: `Set ${envVar ?? 'the provider API key environment variable'} (or add the key to .yggdrasil/yg-secrets.yaml) before running yg check --approve.`,
      };
    }
  }

  return { ok: true, config: { provider, model, endpoint, ...(keyEnvVar ? { keyEnvVar } : {}) }, keyWarning };
}

// ---------------------------------------------------------------------------
// Non-interactive availability probe (flag path)
// ---------------------------------------------------------------------------

/**
 * The flag path's counterpart to the wizard's installation check: for a CLI
 * provider, whether its binary runs on this machine. Returns a warning to print
 * when it does not — the configuration is still written, as in the wizard, so a
 * project can be set up before the CLI is installed — and nothing when it does.
 * API providers are not contacted here; their missing key is reported by the
 * resolver's own warning.
 */
export async function probeReviewerFromFlags(config: ResolvedReviewerConfig): Promise<IssueMessage | undefined> {
  if (!CLI_PROVIDERS.includes(config.provider)) return undefined;
  const result = await testCliProvider(config.provider, config.model);
  if (result.ok) return undefined;
  return {
    what: `The ${config.provider} reviewer cannot run on this machine: ${result.error ?? 'its CLI did not answer'}.`,
    why: 'The configuration was written anyway, so the project is set up; until the CLI runs, yg check --approve leaves every reviewer-rule pair unverified.',
    next: `Install or fix the CLI, then run yg check --approve.`,
  };
}
