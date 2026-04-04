import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LlmConfig } from '../model/types.js';

/**
 * Load yg-secrets.yaml from .yggdrasil/ and extract LLM secrets.
 * Returns partial LLM config with only fields present in secrets file.
 * Returns undefined if no secrets file exists.
 */
export async function loadSecrets(rootPath: string): Promise<Partial<LlmConfig> | undefined> {
  const secretsPath = join(rootPath, 'yg-secrets.yaml');
  let content: string;
  try {
    content = await readFile(secretsPath, 'utf-8');
  } catch {
    return undefined; // No secrets file — graceful
  }

  const raw = parseYaml(content) as Record<string, unknown> | null;
  if (!raw?.llm) return undefined;

  const llmRaw = raw.llm as Record<string, unknown>;
  const partial: Partial<LlmConfig> = {};

  if (typeof llmRaw.api_key === 'string') partial.api_key = llmRaw.api_key;
  if (typeof llmRaw.provider === 'string') partial.provider = llmRaw.provider as LlmConfig['provider'];
  if (typeof llmRaw.model === 'string') partial.model = llmRaw.model;
  if (typeof llmRaw.endpoint === 'string') partial.endpoint = llmRaw.endpoint;
  if (typeof llmRaw.temperature === 'number') partial.temperature = llmRaw.temperature;
  if (typeof llmRaw.consensus === 'number') partial.consensus = llmRaw.consensus;
  if (llmRaw.max_tokens !== undefined) partial.max_tokens = llmRaw.max_tokens as LlmConfig['max_tokens'];

  return Object.keys(partial).length > 0 ? partial : undefined;
}

/** Merge base LLM config with secrets overrides */
export function mergeLlmConfig(base: LlmConfig, secrets: Partial<LlmConfig>): LlmConfig {
  return { ...base, ...secrets };
}
