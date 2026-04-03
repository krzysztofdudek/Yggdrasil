import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { AnchorRealization, NodeAspectEntry, NodeMeta, NodeMapping, Relation, RelationType } from '../model/types.js';

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

  // Parse integration_anchors (optional string[])
  let integrationAnchors: string[] | undefined;
  if (raw.integration_anchors !== undefined) {
    if (!Array.isArray(raw.integration_anchors)) {
      throw new Error(`yg-node.yaml at ${filePath}: 'integration_anchors' must be an array of strings`);
    }
    integrationAnchors = (raw.integration_anchors as unknown[])
      .filter((a): a is string => typeof a === 'string' && a.trim() !== '');
  }

  // Parse integration_aspects (optional string[] in new format)
  let integrationAspects: string[] | undefined;
  if (raw.integration_aspects !== undefined) {
    if (!Array.isArray(raw.integration_aspects)) {
      throw new Error(`yg-node.yaml at ${filePath}: 'integration_aspects' must be an array of strings`);
    }
    integrationAspects = (raw.integration_aspects as unknown[])
      .filter((a): a is string => typeof a === 'string' && a.trim() !== '');
  }

  return {
    name: (raw.name as string).trim(),
    type: (raw.type as string).trim(),
    description,
    aspects,
    blackbox: (raw.blackbox as boolean) ?? false,
    relations: relations.length > 0 ? relations : undefined,
    mapping,
    integration_anchors: integrationAnchors,
    integration_aspects: integrationAspects,
  };
}

function parseAspects(raw: unknown, filePath: string): NodeAspectEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`yg-node.yaml at ${filePath}: 'aspects' must be an array`);
  }
  if (raw.length === 0) return undefined;

  const result: NodeAspectEntry[] = [];
  const seenAspects = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];

    // Support both old format (object with aspect key) and new format (flat string)
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
      // Old format (backward compatibility): object with aspect key
      const obj = item as Record<string, unknown>;
      if (typeof obj.aspect !== 'string' || obj.aspect.trim() === '') {
        throw new Error(
          `yg-node.yaml at ${filePath}: aspects[${i}].aspect must be a non-empty string`,
        );
      }
      aspectId = obj.aspect.trim();

      // Parse exceptions (optional string[]) — only in old format
      let exceptions: string[] | undefined;
      if (obj.exceptions !== undefined && obj.exceptions !== null) {
        if (!Array.isArray(obj.exceptions)) {
          throw new Error(
            `yg-node.yaml at ${filePath}: aspects[${i}].exceptions must be an array of strings`,
          );
        }
        exceptions = obj.exceptions.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
      }

      // Parse anchors — now a map of anchor ID to typed realization object
      let anchorsMap: Record<string, AnchorRealization> | undefined;
      if (obj.anchors !== undefined && obj.anchors !== null) {
        if (typeof obj.anchors !== 'object' || Array.isArray(obj.anchors)) {
          // Migration: bare string arrays are no longer valid
          throw new Error(
            `yg-node.yaml at ${filePath}: aspects[${i}].anchors must be an object mapping anchor IDs to typed realizations (e.g., { anchor-id: { regex: "pattern" } })`,
          );
        }
        anchorsMap = {};
        for (const [anchorId, realization] of Object.entries(obj.anchors as Record<string, unknown>)) {
          if (typeof realization !== 'object' || realization === null || Array.isArray(realization)) {
            throw new Error(
              `yg-node.yaml at ${filePath}: aspects[${i}].anchors.${anchorId} must be an object with a type property (e.g., { regex: "pattern" })`,
            );
          }
          anchorsMap[anchorId] = realization as AnchorRealization;
        }
      }

      // Build the entry from old format
      const entry: NodeAspectEntry = { aspect: aspectId };
      if (exceptions && exceptions.length > 0) {
        entry.exceptions = exceptions;
      }
      if (anchorsMap && Object.keys(anchorsMap).length > 0) {
        entry.anchors = anchorsMap;
      }

      if (seenAspects.has(aspectId)) {
        throw new Error(
          `yg-node.yaml at ${filePath}: duplicate aspect '${aspectId}' in aspects list`,
        );
      }
      seenAspects.add(aspectId);
      result.push(entry);
      continue;
    } else {
      throw new Error(`yg-node.yaml at ${filePath}: aspects[${i}] must be a string or object with 'aspect' key`);
    }

    // New format (flat string): just the aspect ID, no anchors/exceptions
    if (seenAspects.has(aspectId)) {
      throw new Error(
        `yg-node.yaml at ${filePath}: duplicate aspect '${aspectId}' in aspects list`,
      );
    }
    seenAspects.add(aspectId);
    result.push({ aspect: aspectId });
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
    if (typeof obj.failure === 'string') {
      rel.failure = obj.failure;
    }
    if (typeof obj.event_name === 'string' && obj.event_name.trim()) {
      rel.event_name = obj.event_name.trim();
    }

    // Parse anchors on relation (optional Record<string, AnchorRealization>)
    if (typeof obj.anchors === 'object' && obj.anchors !== null && !Array.isArray(obj.anchors)) {
      const anchorsMap: Record<string, AnchorRealization> = {};
      for (const [anchorId, realization] of Object.entries(obj.anchors as Record<string, unknown>)) {
        if (typeof realization !== 'object' || realization === null || Array.isArray(realization)) {
          throw new Error(
            `yg-node.yaml at ${filePath}: relations[${index}].anchors.${anchorId} must be an object with a type property`,
          );
        }
        anchorsMap[anchorId] = realization as AnchorRealization;
      }
      if (Object.keys(anchorsMap).length > 0) {
        rel.anchors = anchorsMap;
      }
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

function parseMapping(rawMapping: unknown, filePath: string): NodeMapping | undefined {
  if (!rawMapping || typeof rawMapping !== 'object') return undefined;

  const obj = rawMapping as Record<string, unknown>;

  // Unified format: mapping.paths — list of files and/or directories (type auto-detected at runtime)
  if (Array.isArray(obj.paths) && obj.paths.length > 0) {
    const paths = (obj.paths as unknown[])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => validateRelativePath(p, filePath, 'mapping.paths[]'));
    if (paths.length === 0) {
      throw new Error(`yg-node.yaml at ${filePath}: mapping.paths must be a non-empty array`);
    }
    return { paths };
  }

  if (obj.paths !== undefined || obj.type !== undefined || obj.path !== undefined) {
    throw new Error(
      `yg-node.yaml at ${filePath}: mapping must have paths (array of file/directory paths)`,
    );
  }

  return undefined;
}
