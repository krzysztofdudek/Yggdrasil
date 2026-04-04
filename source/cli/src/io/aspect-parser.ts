import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { AspectDef, ClaimAnchor } from '../model/types.js';
import { readArtifacts } from './artifact-reader.js';

export async function parseAspect(
  aspectDir: string,
  aspectYamlPath: string,
  id: string,
): Promise<AspectDef> {
  const idTrimmed = id?.trim() ?? '';
  if (!idTrimmed) {
    throw new Error(`Aspect id must be non-empty (relative path in aspects/)`);
  }
  const content = await readFile(aspectYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Aspect file ${aspectYamlPath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`Aspect file ${aspectYamlPath}: missing or empty 'name'`);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  const artifacts = await readArtifacts(aspectDir, ['yg-aspect.yaml']);

  let implies: string[] | undefined;
  if (raw.implies !== undefined) {
    if (!Array.isArray(raw.implies)) {
      throw new Error(`Aspect file ${aspectYamlPath}: 'implies' must be an array of strings`);
    }
    implies = (raw.implies as unknown[]).filter((t): t is string => typeof t === 'string');
  }

  // Parse anchors as claim objects (v4 format)
  let anchors: ClaimAnchor[] = [];
  if (raw.anchors !== undefined) {
    if (!Array.isArray(raw.anchors)) {
      throw new Error(`Aspect file ${aspectYamlPath}: 'anchors' must be an array`);
    }
    for (let i = 0; i < (raw.anchors as unknown[]).length; i++) {
      const entry = (raw.anchors as unknown[])[i];
      // Reject old string format
      if (typeof entry === 'string') {
        throw new Error(
          `Aspect file ${aspectYamlPath}: anchors[${i}] is a string '${entry}'. ` +
          `Anchors must be objects with {id, claim}. Run 'yg init --upgrade' to migrate.`
        );
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`Aspect file ${aspectYamlPath}: anchors[${i}] must be an object with {id, claim}`);
      }
      const obj = entry as Record<string, unknown>;
      if (typeof obj.id !== 'string' || obj.id.trim() === '') {
        throw new Error(`Aspect file ${aspectYamlPath}: anchors[${i}].id must be a non-empty string`);
      }
      if (typeof obj.claim !== 'string' || obj.claim.trim() === '') {
        throw new Error(`Aspect file ${aspectYamlPath}: anchors[${i}].claim must be a non-empty string`);
      }
      anchors.push({ id: obj.id.trim(), claim: obj.claim.trim() });
    }
  }

  // stability field not used — silently ignored if present in old configs

  return {
    name: (raw.name as string).trim(),
    id: idTrimmed,
    description,
    implies,
    anchors,
    artifacts,
  };
}
