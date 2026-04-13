import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
} from '../model/graph.js';

const DEFAULT_QUALITY: QualityConfig = {
  max_direct_relations: 10,
};

const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli',
] as const;

const CLI_PROVIDERS = new Set(['claude-code', 'codex', 'gemini-cli']);

const PROVIDER_DEFAULTS: Record<string, Partial<LlmConfig>> = {
  'claude-code': { model: 'haiku' },
  'codex': { model: 'o4-mini' },
  'gemini-cli': { model: 'gemini-2.5-flash' },
};

const GENERAL_KEYS = new Set(['active', 'consensus']);

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`${filename}: file is empty or not a valid YAML mapping`);
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  const qualityRaw = raw.quality as Record<string, unknown> | undefined;
  const quality: QualityConfig = qualityRaw
    ? {
        max_direct_relations:
          (qualityRaw.max_direct_relations as number) ?? DEFAULT_QUALITY.max_direct_relations,
        max_mapping_source_files:
          qualityRaw.max_mapping_source_files !== undefined
            ? (qualityRaw.max_mapping_source_files as number)
            : undefined,
      }
    : DEFAULT_QUALITY;

  // Parse reviewer: section
  let llm: LlmConfig | undefined;

  if (raw.reviewer !== undefined) {
    llm = parseReviewerSection(raw.reviewer as Record<string, unknown>, KNOWN_PROVIDERS, GENERAL_KEYS, filename);
  }

  let parallel: number | undefined;
  if (raw.parallel !== undefined) {
    const p = raw.parallel as number;
    if (!Number.isInteger(p) || p < 1) {
      throw new Error(`${filename}: parallel must be a positive integer >= 1, got ${p}`);
    }
    parallel = p;
  }

  const debug = raw.debug === true ? true : undefined;

  return {
    version,
    quality,
    llm,
    parallel,
    debug,
  };
}

function parseReviewerSection(
  reviewerRaw: Record<string, unknown>,
  knownProviders: readonly string[],
  generalKeys: Set<string>,
  filename: string,
): LlmConfig | undefined {
  // Separate general keys from provider keys
  const generalConfig: Record<string, unknown> = {};
  const providerEntries: Array<{ name: string; config: Record<string, unknown> }> = [];

  for (const [key, value] of Object.entries(reviewerRaw)) {
    if (generalKeys.has(key)) {
      generalConfig[key] = value;
    } else if (knownProviders.includes(key)) {
      if (value && typeof value === 'object') {
        providerEntries.push({ name: key, config: value as Record<string, unknown> });
      }
    } else {
      throw new Error(
        `${filename}: unknown key '${key}' under reviewer:. Known general keys: ${[...generalKeys].join(', ')}. Known providers: ${knownProviders.join(', ')}.`,
      );
    }
  }

  // Provider discovery
  if (providerEntries.length === 0) return undefined;

  let selectedProvider: { name: string; config: Record<string, unknown> };

  if (generalConfig.active !== undefined) {
    const activeName = String(generalConfig.active);
    const found = providerEntries.find(p => p.name === activeName);
    if (!found) {
      throw new Error(
        `${filename}: reviewer.active is '${activeName}' but '${activeName}' is not configured under reviewer:.`,
      );
    }
    selectedProvider = found;
  } else if (providerEntries.length === 1) {
    selectedProvider = providerEntries[0];
  } else {
    throw new Error(
      `${filename}: multiple providers configured under reviewer: (${providerEntries.map(p => p.name).join(', ')}). Set reviewer.active to select one.`,
    );
  }

  // Extract general params
  const consensus = (generalConfig.consensus as number) ?? 1;
  if (!Number.isInteger(consensus) || consensus < 1 || consensus % 2 === 0) {
    throw new Error(`${filename}: reviewer.consensus must be a positive odd integer >= 1, got ${consensus}`);
  }

  // Normalize provider-specific config to flat LlmConfig
  return normalizeProviderConfig(selectedProvider.name, selectedProvider.config, { consensus }, filename);
}

function normalizeProviderConfig(
  providerName: string,
  pc: Record<string, unknown>,
  generalConfig: { consensus: number },
  filename: string,
): LlmConfig {
  const defaults = PROVIDER_DEFAULTS[providerName] ?? {};

  const model = (pc.model as string) ?? (defaults.model as string | undefined);
  if (!model || typeof model !== 'string') {
    throw new Error(`${filename}: reviewer.${providerName}.model must be a non-empty string`);
  }

  const maxTokens = pc.max_tokens ?? 'auto';
  if (maxTokens !== 'auto' && (typeof maxTokens !== 'number' || maxTokens < 1)) {
    throw new Error(`${filename}: reviewer.${providerName}.max_tokens must be 'auto' or positive number`);
  }

  const timeout = CLI_PROVIDERS.has(providerName) && typeof pc.timeout === 'number'
    ? pc.timeout : undefined;

  return {
    provider: providerName as LlmConfig['provider'],
    model,
    endpoint: typeof pc.endpoint === 'string' ? pc.endpoint : undefined,
    temperature: typeof pc.temperature === 'number' ? pc.temperature : 0,
    consensus: generalConfig.consensus,
    max_tokens: maxTokens as LlmConfig['max_tokens'],
    context_length_field: typeof pc.context_length_field === 'string' ? pc.context_length_field : undefined,
    timeout,
  };
}
