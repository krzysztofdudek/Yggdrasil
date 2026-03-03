import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  ArtifactConfig,
  QualityConfig,
  NodeTypeConfig,
} from '../model/types.js';

const DEFAULT_QUALITY: QualityConfig = {
  min_artifact_length: 50,
  max_direct_relations: 10,
  context_budget: { warning: 10000, error: 20000 },
};

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`config.yaml: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`config.yaml: missing or invalid 'name' field`);
  }

  const nodeTypesRaw = raw.node_types;
  if (!Array.isArray(nodeTypesRaw) || nodeTypesRaw.length === 0) {
    throw new Error(`config.yaml: 'node_types' must be a non-empty array`);
  }
  const nodeTypes: NodeTypeConfig[] = nodeTypesRaw.map((item) => {
    if (typeof item === 'string') {
      return { name: item };
    }
    if (
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      typeof (item as { name: unknown }).name === 'string'
    ) {
      const obj = item as { name: string; required_aspects?: unknown; required_tags?: unknown };
      const requiredAspects = Array.isArray(obj.required_aspects)
        ? (obj.required_aspects as unknown[]).filter((t): t is string => typeof t === 'string')
        : Array.isArray(obj.required_tags)
          ? (obj.required_tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined;
      return {
        name: obj.name,
        required_aspects: requiredAspects && requiredAspects.length > 0 ? requiredAspects : undefined,
      };
    }
    throw new Error(
      `config.yaml: node_types entry must be string or { name, required_aspects? }`,
    );
  });

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
    if (key === 'node.yaml') {
      throw new Error(`config.yaml: artifact name 'node.yaml' is reserved`);
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
        (typeof when === 'string' &&
          (when.startsWith('has_aspect:') || when.startsWith('has_tag:')));
      if (!validWhen) {
        throw new Error(
          `config.yaml: artifact '${key}' has invalid 'required.when': must be has_incoming_relations, has_outgoing_relations, or has_aspect:<name>`,
        );
      }
    }
    artifactsMap[key] = {
      required: required as ArtifactConfig['required'],
      description: (a.description as string) ?? '',
      structural_context: (a.structural_context as boolean) ?? false,
    };
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
      }
    : DEFAULT_QUALITY;

  if (quality.context_budget.error < quality.context_budget.warning) {
    throw new Error(
      `config.yaml: quality.context_budget.error (${quality.context_budget.error}) must be >= warning (${quality.context_budget.warning})`,
    );
  }

  return {
    name: (raw.name as string).trim(),
    stack: (raw.stack as Record<string, string>) ?? {},
    standards: typeof raw.standards === 'string' ? raw.standards : '',
    node_types: nodeTypes,
    artifacts: artifactsMap,
    quality,
  };
}
