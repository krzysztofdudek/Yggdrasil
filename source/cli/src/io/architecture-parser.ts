// yg-suppress(silent-missing-files) Reads a declared, expected graph file; a missing one is a real graph error, so throwing is correct. silent-missing-files governs the loader's optional-directory handling (aspects/, flows/), not parser reads of expected files.
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ArchitectureDef, ArchitectureNodeType, AspectStatus, RelationType } from '../model/graph.js';
import type { FileWhenPredicate } from '../model/file-when.js';
import { parseAspectAttachment } from '../utils/when-parser.js';
import { parseFileWhen } from '../utils/file-when-parser.js';
import type { WhenPredicate } from '../model/when.js';
import { describeUnknownKeys, findUnknownKeys } from '../utils/known-keys.js';

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
export const ARCHITECTURE_NODE_TYPE_KEYS = [
  'description',
  'aspects',
  'parents',
  'relations',
  'log_required',
  'when',
  'enforce',
] as const;

/**
 * The keys the top level of yg-architecture.yaml accepts. The same reasoning as
 * a type entry's: a misspelled `node_type:` would load an EMPTY type system with
 * no word, and every node would then fail against types that were never read.
 */
export const ARCHITECTURE_KEYS = ['node_types'] as const;

export async function parseArchitecture(filePath: string): Promise<ArchitectureDef> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (raw && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`yg-architecture.yaml: file must be a YAML mapping (or empty/omitted)`);
  }
  const unknownTop = raw ? findUnknownKeys(raw, ARCHITECTURE_KEYS) : [];
  if (unknownTop.length > 0) {
    throw new Error(`yg-architecture.yaml: ${describeUnknownKeys('', unknownTop, ARCHITECTURE_KEYS)}`);
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

    const unknownKeys = findUnknownKeys(entry, ARCHITECTURE_NODE_TYPE_KEYS);
    if (unknownKeys.length > 0) {
      throw new Error(`yg-architecture.yaml: ${describeUnknownKeys(`node_types.${typeName}`, unknownKeys, ARCHITECTURE_NODE_TYPE_KEYS)}`);
    }

    // A list written as a single value (`aspects: audit`, `parents: module`) is
    // not a list with one entry — refused, like an unknown key, rather than
    // dropped: dropping it would remove the default rule or the parent
    // constraint it names without a word.
    for (const listKey of ['aspects', 'parents'] as const) {
      const value = entry[listKey];
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.${listKey} must be a list (got ${JSON.stringify(value)}). ` +
            `A single value is not read as a one-entry list, so it would be ignored. Write it as ${listKey}: [${typeof value === 'string' ? value : '<entry>'}].`,
        );
      }
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
