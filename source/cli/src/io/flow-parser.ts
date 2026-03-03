import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FlowDef } from '../model/types.js';
import { readArtifacts } from './artifact-reader.js';

export async function parseFlow(flowDir: string, flowYamlPath: string): Promise<FlowDef> {
  const content = await readFile(flowYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`flow.yaml at ${flowYamlPath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`flow.yaml at ${flowYamlPath}: missing or empty 'name'`);
  }

  const nodes = raw.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`flow.yaml at ${flowYamlPath}: 'nodes' must be a non-empty array`);
  }

  const nodePaths = (nodes as unknown[]).filter((n): n is string => typeof n === 'string');
  if (nodePaths.length === 0) {
    throw new Error(`flow.yaml at ${flowYamlPath}: 'nodes' must contain string node paths`);
  }

  let aspects: string[] | undefined;
  if (raw.aspects !== undefined) {
    if (!Array.isArray(raw.aspects)) {
      throw new Error(`flow.yaml at ${flowYamlPath}: 'aspects' must be an array of strings`);
    }
    const aspectTags = (raw.aspects as unknown[]).filter((a): a is string => typeof a === 'string');
    aspects = aspectTags.length > 0 ? aspectTags : [];
  }

  const artifacts = await readArtifacts(flowDir, ['flow.yaml']);

  return {
    path: path.basename(flowDir),
    name: (raw.name as string).trim(),
    nodes: nodePaths,
    ...(aspects !== undefined && { aspects }),
    artifacts,
  };
}
