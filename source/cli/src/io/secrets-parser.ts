import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LlmConfig } from '../model/types.js';

/**
 * Load yg-secrets.yaml from .yggdrasil/ and extract reviewer secrets.
 * Returns partial LLM config with only fields present in secrets file.
 * Returns undefined if no secrets file exists or no matching section.
 */
export async function loadSecrets(rootPath: string, providerName?: string): Promise<Partial<LlmConfig> | undefined> {
  const secretsPath = join(rootPath, 'yg-secrets.yaml');
  let content: string;
  try {
    content = await readFile(secretsPath, 'utf-8');
  } catch {
    return undefined; // No secrets file — graceful
  }

  const raw = parseYaml(content) as Record<string, unknown> | null;
  if (!raw) return undefined;

  // Try new reviewer: format first
  if (raw.reviewer && typeof raw.reviewer === 'object') {
    const reviewerRaw = raw.reviewer as Record<string, unknown>;
    const providerKey = providerName ?? 'ollama';
    const providerSection = reviewerRaw[providerKey] as Record<string, unknown> | undefined;
    if (!providerSection || typeof providerSection !== 'object') return undefined;
    return extractSecretFields(providerSection);
  }

  return undefined;
}

function extractSecretFields(raw: Record<string, unknown>): Partial<LlmConfig> | undefined {
  const partial: Partial<LlmConfig> = {};

  if (typeof raw.api_key === 'string') partial.api_key = raw.api_key;
  if (typeof raw.provider === 'string') partial.provider = raw.provider as LlmConfig['provider'];
  if (typeof raw.model === 'string') partial.model = raw.model;
  if (typeof raw.endpoint === 'string') partial.endpoint = raw.endpoint;
  if (typeof raw.temperature === 'number') partial.temperature = raw.temperature;
  if (typeof raw.consensus === 'number') partial.consensus = raw.consensus;
  if (raw.max_tokens !== undefined) partial.max_tokens = raw.max_tokens as LlmConfig['max_tokens'];

  return Object.keys(partial).length > 0 ? partial : undefined;
}

/** Merge base LLM config with secrets overrides */
export function mergeLlmConfig(base: LlmConfig, secrets: Partial<LlmConfig>): LlmConfig {
  return { ...base, ...secrets };
}
