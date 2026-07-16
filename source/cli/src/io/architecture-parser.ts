// yg-suppress(silent-missing-files) Reads a declared, expected graph file; a missing one is a real graph error, so throwing is correct. silent-missing-files governs the loader's optional-directory handling (aspects/, flows/), not parser reads of expected files.
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ArchitectureDef, ArchitectureNodeType, AspectStatus, RelationType } from '../model/graph.js';
import type { FileWhenPredicate } from '../model/file-when.js';
import { parseAspectAttachment } from '../utils/when-parser.js';
import { parseFileWhen } from '../utils/file-when-parser.js';
import type { WhenPredicate } from '../model/when.js';

const VALID_RELATION_TYPES: Set<string> = new Set(['uses', 'calls', 'extends', 'implements', 'emits', 'listens']);

/**
 * The complete set of keys a single `node_types.<name>` entry may declare. An
 * unknown key is almost always a typo (`parent` for `parents`, `aspect` for
 * `aspects`, `relation` for `relations`) — and a silently-ignored typo drops an
 * intended architectural constraint without any warning, exactly the failure the
 * non-string-array guard below also defends against. Rejecting loudly turns a
 * silent no-op into a blocking, fixable error. Mirrors the unknown-key rejection
 * the config parser already applies to reviewer/tier blocks.
 */
const VALID_NODE_TYPE_KEYS: Set<string> = new Set([
  'description',
  'aspects',
  'parents',
  'relations',
  'log_required',
  'when',
  'enforce',
]);

export async function parseArchitecture(filePath: string): Promise<ArchitectureDef> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (raw && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`yg-architecture.yaml: file must be a YAML mapping (or empty/omitted)`);
  }

  const nodeTypesRaw = raw?.node_types;
  if (
    nodeTypesRaw !== undefined &&
    nodeTypesRaw !== null &&
    (typeof nodeTypesRaw !== 'object' || Array.isArray(nodeTypesRaw))
  ) {
    throw new Error(`yg-architecture.yaml: 'node_types' must be a YAML mapping (or empty/omitted)`);
  }
  const nodeTypesObj = (nodeTypesRaw ?? {}) as Record<string, unknown>;

  const nodeTypes: Record<string, ArchitectureNodeType> = {};
  for (const [typeName, val] of Object.entries(nodeTypesObj)) {
    if (typeName === '*') {
      throw new Error(
        `yg-architecture.yaml: node type name '*' is reserved — '*' is the any-target wildcard in relation lists and cannot be used as a node type name.`,
      );
    }

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

    const unknownKeys = Object.keys(entry).filter((k) => !VALID_NODE_TYPE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName} has unknown ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys.map((k) => `'${k}'`).join(', ')}. ` +
          `A misspelled key (e.g. 'parent' for 'parents', 'aspect' for 'aspects') is silently ignored, dropping the constraint you intended. ` +
          `Valid keys: ${Array.from(VALID_NODE_TYPE_KEYS).join(', ')}. Fix or remove the offending ${unknownKeys.length === 1 ? 'key' : 'keys'}.`,
      );
    }

    let aspects: string[] | undefined;
    let aspectWhens: Record<string, WhenPredicate> | undefined;
    let aspectStatus: Record<string, AspectStatus> | undefined;
    if (Array.isArray(entry.aspects)) {
      aspects = [];
      for (let i = 0; i < (entry.aspects as unknown[]).length; i++) {
        const parsed = parseAspectAttachment(
          (entry.aspects as unknown[])[i],
          `yg-architecture.yaml: node_types.${typeName}.aspects[${i}]`,
        );
        aspects.push(parsed.id);
        if (parsed.when) {
          (aspectWhens ??= {})[parsed.id] = parsed.when;
        }
        if (parsed.status) {
          (aspectStatus ??= {})[parsed.id] = parsed.status;
        }
      }
      if (aspects.length === 0) aspects = undefined;
    }

    const parents = Array.isArray(entry.parents)
      ? assertStringArray(
          entry.parents as unknown[],
          `yg-architecture.yaml: node_types.${typeName}.parents`,
          'parent type name',
        )
      : undefined;

    const { lists: relations, relationDefault } = parseRelations(entry.relations, typeName);

    let logRequired: boolean | undefined;
    if (entry.log_required !== undefined) {
      if (typeof entry.log_required !== 'boolean') {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.log_required must be boolean, got ${typeof entry.log_required}`,
        );
      }
      logRequired = entry.log_required;
    }

    let when: FileWhenPredicate | undefined;
    if (entry.when !== undefined) {
      when = parseFileWhen(entry.when, `yg-architecture.yaml: node_types.${typeName}.when`, 'node-type-when');
    }

    let enforce: 'strict' | undefined;
    if (entry.enforce !== undefined) {
      if (entry.enforce !== 'strict') {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.enforce must be 'strict' (got: ${JSON.stringify(entry.enforce)})`,
        );
      }
      enforce = 'strict';
    }

    nodeTypes[typeName] = {
      description: entry.description as string,
      aspects,
      ...(aspectWhens && { aspectWhens }),
      ...(aspectStatus && { aspectStatus }),
      parents: parents && parents.length > 0 ? parents : undefined,
      relations: relations,
      ...(relationDefault !== undefined && { relationDefault }),
      ...(logRequired !== undefined && { log_required: logRequired }),
      ...(when !== undefined && { when }),
      ...(enforce !== undefined && { enforce }),
    };
  }

  return {
    node_types: nodeTypes,
  };
}

function parseRelations(
  relationsRaw: unknown,
  typeName: string,
): { lists: Partial<Record<RelationType, string[]>> | undefined; relationDefault?: 'allow' | 'deny' } {
  if (relationsRaw === undefined) {
    return { lists: undefined };
  }

  if (typeof relationsRaw !== 'object' || Array.isArray(relationsRaw)) {
    throw new Error(`yg-architecture.yaml: node_types.${typeName}.relations must be an object`);
  }

  const relations: Partial<Record<RelationType, string[]>> = {};
  let relationDefault: 'allow' | 'deny' | undefined;

  for (const [key, value] of Object.entries(relationsRaw as Record<string, unknown>)) {
    if (key === 'default') {
      if (value !== 'allow' && value !== 'deny') {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.relations.default must be 'allow' or 'deny' (got: ${JSON.stringify(value)})`,
        );
      }
      relationDefault = value;
      continue;
    }

    if (!VALID_RELATION_TYPES.has(key)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations: unknown relation type '${key}' (valid types: ${Array.from(VALID_RELATION_TYPES).join(', ')}; or 'default')`,
      );
    }

    if (!Array.isArray(value)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations.${key} must be an array`,
      );
    }

    const targetStrings = assertStringArray(
      value as unknown[],
      `yg-architecture.yaml: node_types.${typeName}.relations.${key}`,
      'target type name',
    );
    // Preserve empty lists: [] means "deny all targets for this relation type".
    relations[key as RelationType] = targetStrings;
  }

  const hasLists = Object.keys(relations).length > 0;
  return { lists: hasLists ? relations : {}, relationDefault };
}

/**
 * Validate that every entry in `arr` is a string, throwing a structured error
 * naming the field, each offending value, and its index when any entry is not.
 *
 * Non-string entries must fail loud rather than be silently dropped: a dropped
 * type/target name removes an intended architectural constraint without notice.
 */
function assertStringArray(arr: unknown[], fieldPath: string, itemLabel: string): string[] {
  const offenders = arr
    .map((value, index) => ({ value, index }))
    .filter((e) => typeof e.value !== 'string');
  if (offenders.length > 0) {
    const detail = offenders
      .map((e) => `index ${e.index}: ${JSON.stringify(e.value)} (${typeof e.value})`)
      .join('; ');
    throw new Error(
      `${fieldPath} contains non-string ${offenders.length === 1 ? 'entry' : 'entries'} [${detail}]. ` +
        `Every entry must be a string ${itemLabel}; non-string entries would be silently dropped and weaken architecture enforcement. ` +
        `Fix or remove the offending ${offenders.length === 1 ? 'entry' : 'entries'}.`,
    );
  }
  return arr as string[];
}
