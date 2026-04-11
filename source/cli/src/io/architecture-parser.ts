import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ArchitectureDef, ArchitectureNodeType, RelationType } from '../model/graph.js';

const VALID_RELATION_TYPES: Set<string> = new Set(['uses', 'calls', 'extends', 'implements', 'emits', 'listens']);

export async function parseArchitecture(filePath: string): Promise<ArchitectureDef> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`yg-architecture.yaml: file is empty or not a valid YAML mapping`);
  }

  const nodeTypesRaw = raw.node_types;
  if (
    !nodeTypesRaw ||
    typeof nodeTypesRaw !== 'object' ||
    Array.isArray(nodeTypesRaw) ||
    Object.keys(nodeTypesRaw).length === 0
  ) {
    throw new Error(`yg-architecture.yaml: 'node_types' must be a non-empty object`);
  }

  const nodeTypes: Record<string, ArchitectureNodeType> = {};
  for (const [typeName, val] of Object.entries(nodeTypesRaw)) {
    const entry = val as Record<string, unknown>;
    if (!entry || typeof entry !== 'object' || typeof entry.description !== 'string' || entry.description.trim() === '') {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName} must have a non-empty 'description' string`,
      );
    }

    if (entry.integration_aspects !== undefined) {
      throw new Error(
        `yg-architecture.yaml: node type '${typeName}' has unknown field 'integration_aspects'. Use ports on the target node instead.`,
      );
    }

    const aspects = Array.isArray(entry.aspects)
      ? (entry.aspects as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const parents = Array.isArray(entry.parents)
      ? (entry.parents as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const relations: Partial<Record<RelationType, string[]>> | undefined = parseRelations(entry.relations, typeName);

    nodeTypes[typeName] = {
      description: entry.description as string,
      aspects: aspects && aspects.length > 0 ? aspects : undefined,
      parents: parents && parents.length > 0 ? parents : undefined,
      relations: relations,
    };
  }

  return {
    node_types: nodeTypes,
  };
}

function parseRelations(
  relationsRaw: unknown,
  typeName: string,
): Partial<Record<RelationType, string[]>> | undefined {
  if (relationsRaw === undefined) {
    return undefined;
  }

  if (typeof relationsRaw !== 'object' || Array.isArray(relationsRaw)) {
    throw new Error(`yg-architecture.yaml: node_types.${typeName}.relations must be an object`);
  }

  const relations: Partial<Record<RelationType, string[]>> = {};

  for (const [relType, targets] of Object.entries(relationsRaw as Record<string, unknown>)) {
    if (!VALID_RELATION_TYPES.has(relType)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations: unknown relation type '${relType}' (valid types: ${Array.from(VALID_RELATION_TYPES).join(', ')})`,
      );
    }

    if (!Array.isArray(targets)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations.${relType} must be an array`,
      );
    }

    const targetStrings = (targets as unknown[]).filter((t): t is string => typeof t === 'string');
    if (targetStrings.length > 0) {
      relations[relType as RelationType] = targetStrings;
    }
  }

  return Object.keys(relations).length > 0 ? relations : {};
}
