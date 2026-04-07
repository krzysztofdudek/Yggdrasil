import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
} from '../model/types.js';

const DEFAULT_QUALITY: QualityConfig = {
  min_artifact_length: 50,
  max_direct_relations: 10,
  context_budget: { warning: 10000, error: 20000, own_warning: undefined },
};

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`yg-config.yaml: file is empty or not a valid YAML mapping`);
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`yg-config.yaml: missing or invalid 'name' field`);
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
      `yg-config.yaml: quality.context_budget.error (${quality.context_budget.error}) must be >= warning (${quality.context_budget.warning})`,
    );
  }

  if (quality.context_budget.own_warning !== undefined && quality.context_budget.own_warning <= 0) {
    throw new Error('quality.context_budget.own_warning must be a positive number');
  }

  // Parse llm section (optional)
  let llm: LlmConfig | undefined;
  if (raw.llm !== undefined) {
    const llmRaw = raw.llm as Record<string, unknown>;
    const provider = llmRaw.provider as string;
    if (!['ollama', 'openai', 'anthropic'].includes(provider)) {
      throw new Error(`yg-config.yaml: llm.provider must be 'ollama', 'openai', or 'anthropic', got '${provider}'`);
    }
    const model = llmRaw.model as string;
    if (!model || typeof model !== 'string') {
      throw new Error(`yg-config.yaml: llm.model must be a non-empty string`);
    }
    const consensus = (llmRaw.consensus as number) ?? 1;
    if (!Number.isInteger(consensus) || consensus < 1 || consensus % 2 === 0) {
      throw new Error(`yg-config.yaml: llm.consensus must be a positive odd integer >= 1, got ${consensus}`);
    }
    const maxTokens = llmRaw.max_tokens ?? 'auto';
    if (maxTokens !== 'auto' && (typeof maxTokens !== 'number' || maxTokens < 1)) {
      throw new Error(`yg-config.yaml: llm.max_tokens must be 'auto' or a positive number`);
    }

    llm = {
      provider: provider as LlmConfig['provider'],
      model,
      endpoint: typeof llmRaw.endpoint === 'string' ? llmRaw.endpoint : undefined,
      temperature: typeof llmRaw.temperature === 'number' ? llmRaw.temperature : 0,
      consensus,
      max_tokens: maxTokens as LlmConfig['max_tokens'],
      verify_artifacts: llmRaw.verify_artifacts === true,
      context_length_field: typeof llmRaw.context_length_field === 'string' ? llmRaw.context_length_field : undefined,
    };
  }

  return {
    version,
    name: (raw.name as string).trim(),
    quality,
    llm,
  };
}
