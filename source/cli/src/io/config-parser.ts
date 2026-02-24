import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  ArtifactConfig,
  KnowledgeCategory,
  QualityConfig,
} from '../model/types.js';

const DEFAULT_QUALITY: QualityConfig = {
  min_artifact_length: 50,
  max_direct_relations: 10,
  context_budget: { warning: 10000, error: 20000 },
  knowledge_staleness_days: 90,
};

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`config.yaml: missing or invalid 'name' field`);
  }

  const nodeTypes = raw.node_types;
  if (!Array.isArray(nodeTypes) || nodeTypes.length === 0) {
    throw new Error(`config.yaml: 'node_types' must be a non-empty array`);
  }

  const artifacts = raw.artifacts;
  if (
    !artifacts ||
    typeof artifacts !== 'object' ||
    Array.isArray(artifacts) ||
    Object.keys(artifacts).length === 0
  ) {
    throw new Error(`config.yaml: 'artifacts' must be a non-empty object`);
  }

  const artifactsMap: Record<string, ArtifactConfig> = {};
  for (const [key, val] of Object.entries(artifacts)) {
    if (key === 'node') {
      throw new Error(`config.yaml: artifact name 'node' is reserved`);
    }
    const a = val as Record<string, unknown>;
    const required = a.required;
    if (
      required !== 'always' &&
      required !== 'never' &&
      (typeof required !== 'object' || !required || !('when' in required))
    ) {
      throw new Error(`config.yaml: artifact '${key}' has invalid 'required' field`);
    }
    if (typeof required === 'object' && required && 'when' in required) {
      const when = (required as { when: string }).when;
      const validWhen =
        when === 'has_incoming_relations' ||
        when === 'has_outgoing_relations' ||
        (typeof when === 'string' && when.startsWith('has_tag:'));
      if (!validWhen) {
        throw new Error(
          `config.yaml: artifact '${key}' has invalid 'required.when': must be has_incoming_relations, has_outgoing_relations, or has_tag:<name>`,
        );
      }
    }
    artifactsMap[key] = {
      required: required as ArtifactConfig['required'],
      description: (a.description as string) ?? '',
      structural_context: (a.structural_context as boolean) ?? false,
    };
  }

  if (!('knowledge_categories' in raw)) {
    throw new Error(
      `config.yaml: missing 'knowledge_categories' field (required, may be empty list)`,
    );
  }
  const knowledgeCategoriesRaw = raw.knowledge_categories;
  if (!Array.isArray(knowledgeCategoriesRaw)) {
    throw new Error(`config.yaml: 'knowledge_categories' must be an array`);
  }
  const knowledgeCategories = knowledgeCategoriesRaw as KnowledgeCategory[];
  const categoryNames = new Set<string>();
  for (const kc of knowledgeCategories) {
    if (!kc?.name || typeof kc.name !== 'string') continue;
    if (categoryNames.has(kc.name)) {
      throw new Error(`config.yaml: duplicate knowledge category '${kc.name}'`);
    }
    categoryNames.add(kc.name);
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
        },
        knowledge_staleness_days:
          (qualityRaw.knowledge_staleness_days as number) ??
          DEFAULT_QUALITY.knowledge_staleness_days,
      }
    : DEFAULT_QUALITY;

  if (quality.context_budget.error < quality.context_budget.warning) {
    throw new Error(
      `config.yaml: quality.context_budget.error (${quality.context_budget.error}) must be >= warning (${quality.context_budget.warning})`,
    );
  }

  if (!('tags' in raw)) {
    throw new Error(`config.yaml: missing 'tags' field (required, may be empty list)`);
  }
  const tags = raw.tags;
  if (!Array.isArray(tags)) {
    throw new Error(`config.yaml: 'tags' must be an array`);
  }
  const tagsList = (tags as unknown[]).filter((t): t is string => typeof t === 'string');

  return {
    name: (raw.name as string).trim(),
    stack: (raw.stack as Record<string, string>) ?? {},
    standards: typeof raw.standards === 'string' ? raw.standards : '',
    tags: tagsList,
    node_types: nodeTypes as string[],
    artifacts: artifactsMap,
    knowledge_categories: knowledgeCategories.filter((kc) => kc?.name),
    quality,
  };
}
