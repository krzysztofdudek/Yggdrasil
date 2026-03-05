import { readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';

const KNOWN_TYPE_DESCRIPTIONS: Record<string, string> = {
  module: 'Business logic unit with clear domain responsibility',
  service: 'Component providing functionality to other nodes',
  library: 'Shared utility code with no domain knowledge',
  infrastructure: 'Guards, middleware, interceptors — invisible in call graphs but affect blast radius',
};

const STANDARD_ARTIFACTS = {
  'responsibility.md': {
    required: 'always' as const,
    description: 'What this node is responsible for, and what it is not',
    included_in_relations: true,
  },
  'interface.md': {
    required: { when: 'has_incoming_relations' },
    description: 'Public API — methods, parameters, return types, contracts, failure modes, exposed data structures',
    included_in_relations: true,
  },
  'internals.md': {
    required: 'never' as const,
    description: 'How the node works and why — algorithms, business rules, state machines, design decisions with rejected alternatives',
  },
};

export async function migrateTo2(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  // Step 1: Read and rename config (idempotent: fallback to yg-config.yaml if already renamed)
  const oldConfigPath = path.join(yggRoot, 'config.yaml');
  const newConfigPath = path.join(yggRoot, 'yg-config.yaml');
  let configContent: string;

  const oldConfigExists = await fileExists(oldConfigPath);
  if (oldConfigExists) {
    configContent = await readFile(oldConfigPath, 'utf-8');
    await rename(oldConfigPath, newConfigPath);
    actions.push('Renamed config.yaml → yg-config.yaml');
  } else {
    // Already renamed (idempotent)
    configContent = await readFile(newConfigPath, 'utf-8');
  }

  const raw = parseYaml(configContent) as Record<string, unknown>;

  // Step 2: Transform node_types
  const nodeTypesRaw = raw.node_types;
  const nodeTypes: Record<string, { description: string; required_aspects?: string[] }> = {};

  if (Array.isArray(nodeTypesRaw)) {
    for (const typeName of nodeTypesRaw) {
      if (typeof typeName === 'string') {
        const desc = KNOWN_TYPE_DESCRIPTIONS[typeName];
        if (desc) {
          nodeTypes[typeName] = { description: desc };
        } else {
          nodeTypes[typeName] = { description: 'TODO: add description' };
          warnings.push(`Unknown node type '${typeName}' — needs a description`);
        }
      }
    }
    actions.push('Converted node_types from array to object format');
  } else if (nodeTypesRaw && typeof nodeTypesRaw === 'object') {
    for (const [name, val] of Object.entries(nodeTypesRaw as Record<string, unknown>)) {
      const entry = val as Record<string, unknown>;
      const desc = KNOWN_TYPE_DESCRIPTIONS[name] ?? (typeof entry?.description === 'string' ? entry.description : 'TODO: add description');
      nodeTypes[name] = { description: desc };
      if (entry?.required_aspects) {
        nodeTypes[name].required_aspects = entry.required_aspects as string[];
      }
      if (!KNOWN_TYPE_DESCRIPTIONS[name] && (!entry?.description || entry.description === 'TODO: add description')) {
        warnings.push(`Unknown node type '${name}' — needs a description`);
      }
    }
  }

  // Add infrastructure if missing
  if (!nodeTypes.infrastructure) {
    nodeTypes.infrastructure = { description: KNOWN_TYPE_DESCRIPTIONS.infrastructure };
    actions.push('Added infrastructure node type');
  }

  // Step 3: Migrate stack/standards to root node internals.md (idempotent: checks for existing section)
  const stackRaw = raw.stack as Record<string, string> | undefined;
  const standardsRaw = raw.standards as string | undefined;

  if (stackRaw || standardsRaw) {
    await migrateStackStandards(yggRoot, stackRaw, standardsRaw, actions);
  }

  // Step 4: Write new config (always overwrite — idempotent since output is deterministic)
  const newConfig: Record<string, unknown> = {
    version: '2.0.0',
    name: raw.name,
    node_types: nodeTypes,
    artifacts: STANDARD_ARTIFACTS,
  };
  if (raw.quality) {
    newConfig.quality = raw.quality;
  }
  await writeFile(newConfigPath, stringifyYaml(newConfig, { lineWidth: 120 }), 'utf-8');
  actions.push('Updated config: version, artifacts, removed stack/standards');

  // Step 5: Rename and transform model files
  const modelDir = path.join(yggRoot, 'model');
  if (await fileExists(modelDir)) {
    // Rename must happen before transform — transformNodeFiles only processes yg-node.yaml
    await renameFilesRecursively(modelDir, 'node.yaml', 'yg-node.yaml', actions);
    await transformNodeFiles(modelDir, actions, warnings);
  }

  // Step 6: Rename aspect files
  const aspectsDir = path.join(yggRoot, 'aspects');
  if (await fileExists(aspectsDir)) {
    await renameFilesRecursively(aspectsDir, 'aspect.yaml', 'yg-aspect.yaml', actions);
  }

  // Step 7: Rename flow files
  const flowsDir = path.join(yggRoot, 'flows');
  if (await fileExists(flowsDir)) {
    await renameFilesRecursively(flowsDir, 'flow.yaml', 'yg-flow.yaml', actions);
  }

  // Step 8: Rename schema files (idempotent: skip if source missing or destination exists)
  const schemasDir = path.join(yggRoot, 'schemas');
  if (await fileExists(schemasDir)) {
    for (const name of ['config.yaml', 'node.yaml', 'aspect.yaml', 'flow.yaml']) {
      const oldPath = path.join(schemasDir, name);
      const newPath = path.join(schemasDir, `yg-${name}`);
      if ((await fileExists(oldPath)) && !(await fileExists(newPath))) {
        await rename(oldPath, newPath);
        actions.push(`Renamed schemas/${name} → yg-${name}`);
      }
    }
  }

  // Step 9: Delete drift state (idempotent: silently skip if already gone)
  const driftStatePath = path.join(yggRoot, '.drift-state');
  if (await fileExists(driftStatePath)) {
    await rm(driftStatePath);
    actions.push('Deleted .drift-state (requires fresh yg drift-sync --all)');
  }

  return { actions, warnings };
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function migrateStackStandards(
  yggRoot: string,
  stack: Record<string, string> | undefined,
  standards: string | undefined,
  actions: string[],
): Promise<void> {
  const modelDir = path.join(yggRoot, 'model');
  if (!(await fileExists(modelDir))) return;

  const lines: string[] = [];
  if (stack && Object.keys(stack).length > 0) {
    lines.push('## Technology Stack');
    lines.push('');
    for (const [key, value] of Object.entries(stack)) {
      lines.push(`- **${key}:** ${value}`);
    }
    lines.push('');
  }
  if (standards) {
    lines.push('## Standards');
    lines.push('');
    lines.push(standards);
    lines.push('');
  }

  if (lines.length === 0) return;

  // Check if root node exists; create if not
  const rootNodeYgPath = path.join(modelDir, 'yg-node.yaml');
  const rootNodeOldPath = path.join(modelDir, 'node.yaml');
  const hasRootNode = (await fileExists(rootNodeYgPath)) || (await fileExists(rootNodeOldPath));

  if (!hasRootNode) {
    await writeFile(rootNodeYgPath, stringifyYaml({ name: 'Root', type: 'module' }), 'utf-8');
    await writeFile(path.join(modelDir, 'responsibility.md'), 'TBD\n', 'utf-8');
    actions.push('Created root node in model/ for stack/standards migration');
  }

  // Write internals.md — idempotent: skip if marker already present
  const internalsPath = path.join(modelDir, 'internals.md');
  const existingInternals = (await fileExists(internalsPath)) ? await readFile(internalsPath, 'utf-8') : '';

  // Unique HTML comment marker — invisible in rendered Markdown, never false-triggers
  const MIGRATION_MARKER = '<!-- migrated-stack-standards-v2 -->';
  if (existingInternals.includes(MIGRATION_MARKER)) {
    return;
  }
  const markerLine = MIGRATION_MARKER + '\n';
  const newContent = existingInternals
    ? existingInternals.trimEnd() + '\n\n' + markerLine + lines.join('\n')
    : markerLine + lines.join('\n');
  await writeFile(internalsPath, newContent, 'utf-8');
  actions.push('Migrated stack/standards to model/internals.md');
}

async function renameFilesRecursively(
  dir: string,
  oldName: string,
  newName: string,
  actions: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await renameFilesRecursively(fullPath, oldName, newName, actions);
    } else if (entry.name === oldName) {
      const destPath = path.join(dir, newName);
      // Idempotent: skip if destination already exists (previous run)
      if (!(await fileExists(destPath))) {
        await rename(fullPath, destPath);
        actions.push(`Renamed ${oldName} → ${newName} in ${dir}`);
      }
    }
  }
}

async function transformNodeFiles(dir: string, actions: string[], warnings: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await transformNodeFiles(fullPath, actions, warnings);
    } else if (entry.name === 'yg-node.yaml') {
      await transformSingleNode(fullPath, actions, warnings);
    }
  }
}

async function transformSingleNode(filePath: string, actions: string[], warnings: string[]): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    warnings.push(`Skipped ${filePath}: not a valid YAML object`);
    return;
  }

  let changed = false;

  // Convert aspects from string array to object array (idempotent: check first element type)
  if (Array.isArray(raw.aspects) && raw.aspects.length > 0 && typeof raw.aspects[0] === 'string') {
    const aspectExceptions = (raw.aspect_exceptions ?? {}) as Record<string, string[]>;
    const anchors = (raw.anchors ?? {}) as Record<string, string[]>;

    raw.aspects = (raw.aspects as string[]).map((id) => {
      const entry: Record<string, unknown> = { aspect: id };
      if (aspectExceptions[id]) entry.exceptions = aspectExceptions[id];
      if (anchors[id]) entry.anchors = anchors[id];
      return entry;
    });

    delete raw.aspect_exceptions;
    delete raw.anchors;
    changed = true;
  }

  // Remove tags (idempotent: only if present)
  if (raw.tags !== undefined) {
    delete raw.tags;
    changed = true;
  }

  if (changed) {
    await writeFile(filePath, stringifyYaml(raw, { lineWidth: 120 }), 'utf-8');
    actions.push(`Transformed ${path.basename(path.dirname(filePath))}/yg-node.yaml`);
  }
}
