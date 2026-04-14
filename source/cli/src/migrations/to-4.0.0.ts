import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';

const NODE_ARTIFACTS = ['responsibility.md', 'interface.md', 'internals.md'];

function posix(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export async function migrateTo4(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  await splitArchitecture(yggRoot, actions);
  await cleanConfig(yggRoot, actions);

  const modelDir = path.join(yggRoot, 'model');
  if (await dirExists(modelDir)) {
    await processNodesRecursive(modelDir, actions, warnings);
  }

  const flowsDir = path.join(yggRoot, 'flows');
  if (await dirExists(flowsDir)) {
    await processFlows(flowsDir, actions);
  }

  const aspectsDir = path.join(yggRoot, 'aspects');
  if (await dirExists(aspectsDir)) {
    await processAspects(aspectsDir, actions);
  }

  const driftDir = path.join(yggRoot, '.drift-state');
  if (await dirExists(driftDir)) {
    await resetDriftState(driftDir, actions);
  }

  return { actions, warnings };
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function splitArchitecture(
  yggRoot: string,
  actions: string[],
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const content = await readFile(configPath, 'utf-8');
  const config = parseYaml(content) as Record<string, unknown>;

  if (config.node_types) {
    const archData = { node_types: config.node_types };
    const archPath = path.join(yggRoot, 'yg-architecture.yaml');
    await writeFile(archPath, stringifyYaml(archData, { lineWidth: 0 }), 'utf-8');
    actions.push('Extracted node_types to yg-architecture.yaml');
  }
}

async function cleanConfig(
  yggRoot: string,
  actions: string[],
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const content = await readFile(configPath, 'utf-8');
  const config = parseYaml(content) as Record<string, unknown>;

  delete config.name;
  delete config.node_types;

  const quality = config.quality as Record<string, unknown> | undefined;
  if (quality) {
    delete quality.min_artifact_length;
    delete quality.context_budget;
    if (Object.keys(quality).length === 0) {
      delete config.quality;
    }
  }

  if (config.parallel === undefined) {
    config.parallel = 1;
    actions.push('Added parallel: 1 to config');
  }

  config.version = '4.0.0';

  await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), 'utf-8');
  actions.push('Cleaned config: removed name, node_types, obsolete quality fields; set version to 4.0.0');
}

async function processNodesRecursive(
  dir: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await processNodesRecursive(fullPath, actions, warnings);
      continue;
    }

    if (entry.name === 'yg-node.yaml') {
      await rewriteNodeYaml(fullPath, actions, warnings);
      continue;
    }

    if (NODE_ARTIFACTS.includes(entry.name)) {
      await rm(fullPath);
      actions.push(`Deleted node artifact: ${posix(fullPath)}`);
    }
  }
}

function flattenAspects(
  aspects: unknown[],
  warnings: string[],
  nodePath: string,
): string[] {
  const result: string[] = [];
  for (const item of aspects) {
    if (typeof item === 'string') {
      result.push(item);
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (typeof obj.aspect === 'string') {
        result.push(obj.aspect);
        if (Array.isArray(obj.exceptions) && obj.exceptions.length > 0) {
          warnings.push(`Dropped aspect exceptions for "${obj.aspect}" in ${posix(nodePath)}`);
        }
        if (Array.isArray(obj.anchors) && obj.anchors.length > 0) {
          warnings.push(`Dropped aspect anchors for "${obj.aspect}" in ${posix(nodePath)}`);
        }
      }
    }
  }
  return result;
}

async function rewriteNodeYaml(
  filePath: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const node = parseYaml(content) as Record<string, unknown>;
  let changed = false;

  // Flatten aspects
  if (Array.isArray(node.aspects) && node.aspects.length > 0) {
    const first = node.aspects[0];
    if (first && typeof first === 'object') {
      node.aspects = flattenAspects(node.aspects, warnings, filePath);
      changed = true;
    }
  }

  // Flatten mapping
  if (node.mapping && typeof node.mapping === 'object' && !Array.isArray(node.mapping)) {
    const mappingObj = node.mapping as Record<string, unknown>;
    if (Array.isArray(mappingObj.paths)) {
      node.mapping = mappingObj.paths;
      changed = true;
    }
  }

  // Remove blackbox
  if ('blackbox' in node) {
    delete node.blackbox;
    changed = true;
  }

  // Strip v3 relation fields: consumes (now port-based) and failure
  if (Array.isArray(node.relations)) {
    for (const rel of node.relations) {
      if (rel && typeof rel === 'object') {
        const r = rel as Record<string, unknown>;
        if ('consumes' in r) { delete r.consumes; changed = true; }
        if ('failure' in r) { delete r.failure; changed = true; }
        if ('event_name' in r) { delete r.event_name; changed = true; }
      }
    }
  }

  if (changed) {
    await writeFile(filePath, stringifyYaml(node, { lineWidth: 0 }), 'utf-8');
    actions.push(`Rewrote node: ${posix(filePath)}`);
  }
}

async function processFlows(
  dir: string,
  actions: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const descPath = path.join(dir, entry.name, 'description.md');
    try {
      await rm(descPath);
      actions.push(`Deleted flow artifact: ${posix(descPath)}`);
    } catch {
      // file doesn't exist, skip
    }
  }
}

async function processAspects(
  dir: string,
  actions: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const aspectPath = path.join(dir, entry.name, 'yg-aspect.yaml');
    try {
      const content = await readFile(aspectPath, 'utf-8');
      const aspect = parseYaml(content) as Record<string, unknown>;
      if ('stability' in aspect) {
        delete aspect.stability;
        await writeFile(aspectPath, stringifyYaml(aspect, { lineWidth: 0 }), 'utf-8');
        actions.push(`Removed stability from aspect: ${posix(aspectPath)}`);
      }
    } catch {
      // file doesn't exist, skip
    }
  }
}

async function resetDriftState(
  dir: string,
  actions: string[],
): Promise<void> {
  await resetDriftStateRecursive(dir, actions);
}

async function resetDriftStateRecursive(
  dir: string,
  actions: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await resetDriftStateRecursive(fullPath, actions);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      await rm(fullPath);
      actions.push(`Deleted drift state: ${posix(fullPath)}`);
    }
  }
}
