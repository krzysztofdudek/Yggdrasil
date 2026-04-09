import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
} from '../model/graph.js';

const DEFAULT_QUALITY: QualityConfig = {
  min_artifact_length: 50,
  max_direct_relations: 10,
  context_budget: { warning: 10000, error: 20000, own_warning: undefined },
};

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`${filename}: file is empty or not a valid YAML mapping`);
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`${filename}: missing or invalid 'name' field`);
  }

  const qualityRaw = raw.quality as Record<string, unknown> | undefined;
  const quality: QualityConfig = qualityRaw
    ? {
        min_artifact_length:
          (qualityRaw.min_artifact_length as number) ?? DEFAULT_QUALITY.min_artifact_length,
        max_direct_relations:
          (qualityRaw.max_direct_relations as number) ?? DEFAULT_QUALITY.max_direct_relations,
        context_budget: {
          warning:
            (qualityRaw.context_budget as Record<string, number>)?.warning ??
            DEFAULT_QUALITY.context_budget.warning,
          error:
            (qualityRaw.context_budget as Record<string, number>)?.error ??
            DEFAULT_QUALITY.context_budget.error,
          own_warning: (qualityRaw.context_budget as Record<string, number | undefined>)?.own_warning,
        },
      }
    : DEFAULT_QUALITY;

  if (quality.context_budget.error < quality.context_budget.warning) {
    throw new Error(
      `${filename}: quality.context_budget.error (${quality.context_budget.error}) must be >= warning (${quality.context_budget.warning})`,
    );
  }

  if (quality.context_budget.own_warning !== undefined && quality.context_budget.own_warning <= 0) {
    throw new Error(`${filename}: quality.context_budget.own_warning must be a positive number`);
  }

  // Known provider names
  const KNOWN_PROVIDERS = ['ollama', 'claude-code'] as const;
  // Known general keys under reviewer:
  const GENERAL_KEYS = new Set(['active', 'verify_aspects', 'verify_artifacts', 'consensus']);

  // Parse reviewer: section (or legacy llm: fallback)
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
    name: (raw.name as string).trim(),
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
  const verifyAspects = generalConfig.verify_aspects !== false; // default true
  const verifyArtifacts = generalConfig.verify_artifacts !== false; // default true
  const consensus = (generalConfig.consensus as number) ?? 1;
  if (!Number.isInteger(consensus) || consensus < 1 || consensus % 2 === 0) {
    throw new Error(`${filename}: reviewer.consensus must be a positive odd integer >= 1, got ${consensus}`);
  }

  // Normalize provider-specific config to flat LlmConfig
  const pc = selectedProvider.config;

  if (selectedProvider.name === 'ollama') {
    const model = pc.model as string;
    if (!model || typeof model !== 'string') {
      throw new Error(`${filename}: reviewer.ollama.model must be a non-empty string`);
    }
    const maxTokens = pc.max_tokens ?? 'auto';
    if (maxTokens !== 'auto' && (typeof maxTokens !== 'number' || maxTokens < 1)) {
      throw new Error(`${filename}: reviewer.ollama.max_tokens must be 'auto' or a positive number`);
    }
    return {
      provider: 'ollama',
      model,
      endpoint: typeof pc.endpoint === 'string' ? pc.endpoint : undefined,
      temperature: typeof pc.temperature === 'number' ? pc.temperature : 0,
      consensus,
      max_tokens: maxTokens as LlmConfig['max_tokens'],
      verify_aspects: verifyAspects,
      verify_artifacts: verifyArtifacts,
      context_length_field: typeof pc.context_length_field === 'string' ? pc.context_length_field : undefined,
    };
  }

  if (selectedProvider.name === 'claude-code') {
    const model = typeof pc.model === 'string' ? pc.model : 'haiku';
    return {
      provider: 'claude-code',
      model,
      endpoint: undefined,
      temperature: 0,
      consensus,
      max_tokens: 'auto',
      verify_aspects: verifyAspects,
      verify_artifacts: verifyArtifacts,
    };
  }

  throw new Error(`${filename}: unknown provider '${selectedProvider.name}'`);
}

