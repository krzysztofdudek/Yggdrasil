import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { NodeMeta, PortDef, Relation, RelationType } from '../model/graph.js';

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
    throw new Error(`yg-node.yaml at ${filePath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`yg-node.yaml at ${filePath}: missing or empty 'name'`);
  }
  if (!raw.type || typeof raw.type !== 'string' || raw.type.trim() === '') {
    throw new Error(`yg-node.yaml at ${filePath}: missing or empty 'type'`);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;
  const relations = parseRelations(raw.relations, filePath);
  const mapping = parseMapping(raw.mapping, filePath);
  const aspects = parseAspects(raw.aspects, filePath);
  const ports = parsePorts(raw.ports, filePath);

  return {
    name: (raw.name as string).trim(),
    type: (raw.type as string).trim(),
    description,
    aspects,
    relations: relations.length > 0 ? relations : undefined,
    mapping,
    ports,
  };
}

function parseAspects(raw: unknown, filePath: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`yg-node.yaml at ${filePath}: 'aspects' must be an array`);
  }
  if (raw.length === 0) return undefined;

  const result: string[] = [];
  const seenAspects = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];

    let aspectId: string;

    if (typeof item === 'string') {
      // New format: flat string array
      aspectId = item.trim();
      if (aspectId === '') {
        throw new Error(
          `yg-node.yaml at ${filePath}: aspects[${i}] must be a non-empty string`,
        );
      }
    } else if (typeof item === 'object' && item !== null) {
      throw new Error(
        `yg-node.yaml at ${filePath}: aspects must be an array of strings.`,
      );
    } else {
      throw new Error(`yg-node.yaml at ${filePath}: aspects[${i}] must be a string`);
    }

    if (seenAspects.has(aspectId)) {
      throw new Error(
        `yg-node.yaml at ${filePath}: duplicate aspect '${aspectId}' in aspects list`,
      );
    }
    seenAspects.add(aspectId);
    result.push(aspectId);
  }

  return result.length > 0 ? result : undefined;
}

function parseRelations(raw: unknown, filePath: string): Relation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`yg-node.yaml at ${filePath}: 'relations' must be an array`);
  }

  const result: Relation[] = [];
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index];
    if (typeof r !== 'object' || r === null) {
      throw new Error(`yg-node.yaml at ${filePath}: relations[${index}] must be an object`);
    }
    const obj = r as Record<string, unknown>;
    const target = obj.target;
    const type = obj.type;

    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error(
        `yg-node.yaml at ${filePath}: relations[${index}].target must be a non-empty string`,
      );
    }
    if (!isValidRelationType(type)) {
      throw new Error(`yg-node.yaml at ${filePath}: relations[${index}].type is invalid`);
    }

    const rel: Relation = {
      target: target.trim(),
      type: type as RelationType,
    };
    if (Array.isArray(obj.consumes)) {
      rel.consumes = (obj.consumes as unknown[]).filter((c): c is string => typeof c === 'string');
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
    throw new Error(`yg-node.yaml at ${filePath}: '${fieldName}' must be non-empty`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`yg-node.yaml at ${filePath}: '${fieldName}' must be relative to repository root`);
  }
  return normalized;
}

function parseMapping(rawMapping: unknown, filePath: string): string[] | undefined {
  if (!rawMapping) return undefined;

  if (!Array.isArray(rawMapping)) {
    throw new Error(
      `yg-node.yaml at ${filePath}: mapping must be an array of file/directory paths.`,
    );
  }

  if (rawMapping.length === 0) {
    throw new Error(`yg-node.yaml at ${filePath}: mapping array must not be empty`);
  }

  const paths: string[] = [];
  for (let i = 0; i < rawMapping.length; i++) {
    const entry = rawMapping[i];
    if (typeof entry === 'object' && entry !== null) {
      throw new Error(
        `yg-node.yaml at ${filePath}: mapping[${i}] is an object. ` +
        `Mapping must be a flat list of file/directory paths.`,
      );
    }
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(
        `yg-node.yaml at ${filePath}: mapping[${i}] must be a non-empty string (file or directory path)`,
      );
    }
    paths.push(validateRelativePath(entry, filePath, `mapping[${i}]`));
  }

  return paths;
}

function parsePorts(rawPorts: unknown, filePath: string): Record<string, PortDef> | undefined {
  if (!rawPorts || rawPorts === null) return undefined;

  if (typeof rawPorts !== 'object' || Array.isArray(rawPorts)) {
    throw new Error(`yg-node.yaml at ${filePath}: ports must be a mapping of port names to definitions`);
  }

  const ports: Record<string, PortDef> = {};
  for (const [name, raw] of Object.entries(rawPorts as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name} must be an object`);
    }
    const obj = raw as Record<string, unknown>;

    if (typeof obj.description !== 'string' || obj.description.trim() === '') {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.description must be a non-empty string`);
    }

    if (!Array.isArray(obj.aspects)) {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.aspects must be an array`);
    }

    const aspects = (obj.aspects as unknown[]).map((a, i) => {
      if (typeof a !== 'string' || a.trim() === '') {
        throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.aspects[${i}] must be a non-empty string`);
      }
      return a.trim();
    });

    ports[name] = { description: obj.description.trim(), aspects };
  }

  return Object.keys(ports).length > 0 ? ports : undefined;
}
