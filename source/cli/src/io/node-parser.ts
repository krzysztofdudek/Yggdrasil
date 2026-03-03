import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { NodeMeta, NodeMapping, Relation, RelationType } from '../model/types.js';

const RELATION_TYPES: RelationType[] = [
  'uses',
  'calls',
  'extends',
  'implements',
  'emits',
  'listens',
];

function isValidRelationType(t: unknown): t is RelationType {
  return typeof t === 'string' && RELATION_TYPES.includes(t as RelationType);
}

export async function parseNodeYaml(filePath: string): Promise<NodeMeta> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`node.yaml at ${filePath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`node.yaml at ${filePath}: missing or empty 'name'`);
  }
  if (!raw.type || typeof raw.type !== 'string' || raw.type.trim() === '') {
    throw new Error(`node.yaml at ${filePath}: missing or empty 'type'`);
  }

  const relations = parseRelations(raw.relations, filePath);
  const mapping = parseMapping(raw.mapping, filePath);

  return {
    name: (raw.name as string).trim(),
    type: (raw.type as string).trim(),
    aspects: parseStringArray(raw.aspects) ?? parseStringArray(raw.tags),
    blackbox: (raw.blackbox as boolean) ?? false,
    relations: relations.length > 0 ? relations : undefined,
    mapping,
  };
}

function parseStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const arr = val.filter((v): v is string => typeof v === 'string');
  return arr.length > 0 ? arr : undefined;
}

function parseRelations(raw: unknown, filePath: string): Relation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`node.yaml at ${filePath}: 'relations' must be an array`);
  }

  const result: Relation[] = [];
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index];
    if (typeof r !== 'object' || r === null) {
      throw new Error(`node.yaml at ${filePath}: relations[${index}] must be an object`);
    }
    const obj = r as Record<string, unknown>;
    const target = obj.target;
    const type = obj.type;

    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error(
        `node.yaml at ${filePath}: relations[${index}].target must be a non-empty string`,
      );
    }
    if (!isValidRelationType(type)) {
      throw new Error(`node.yaml at ${filePath}: relations[${index}].type is invalid`);
    }

    const rel: Relation = {
      target: target.trim(),
      type: type as RelationType,
    };
    if (Array.isArray(obj.consumes)) {
      rel.consumes = (obj.consumes as unknown[]).filter((c): c is string => typeof c === 'string');
    }
    if (typeof obj.failure === 'string') {
      rel.failure = obj.failure;
    }
    if (typeof obj.event_name === 'string' && obj.event_name.trim()) {
      rel.event_name = obj.event_name.trim();
    }
    result.push(rel);
  }
  return result;
}

function validateRelativePath(pathValue: string, filePath: string, fieldName: string): string {
  const normalized = pathValue.trim();
  if (normalized === '') {
    throw new Error(`node.yaml at ${filePath}: '${fieldName}' must be non-empty`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`node.yaml at ${filePath}: '${fieldName}' must be relative to repository root`);
  }
  return normalized;
}

function parseMapping(rawMapping: unknown, filePath: string): NodeMapping | undefined {
  if (!rawMapping || typeof rawMapping !== 'object') return undefined;

  const obj = rawMapping as Record<string, unknown>;

  // Unified format: mapping.paths — list of files and/or directories (type auto-detected at runtime)
  if (Array.isArray(obj.paths) && obj.paths.length > 0) {
    const paths = (obj.paths as unknown[])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => validateRelativePath(p, filePath, 'mapping.paths[]'));
    if (paths.length === 0) {
      throw new Error(`node.yaml at ${filePath}: mapping.paths must be a non-empty array`);
    }
    return { paths };
  }

  if (obj.paths !== undefined || obj.type !== undefined || obj.path !== undefined) {
    throw new Error(
      `node.yaml at ${filePath}: mapping must have paths (array of file/directory paths)`,
    );
  }

  return undefined;
}
