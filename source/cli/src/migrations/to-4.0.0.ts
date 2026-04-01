import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';

export async function migrateToV4(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  const modelDir = path.join(yggRoot, 'model');
  if (!(await fileExists(modelDir))) {
    return { actions, warnings };
  }

  await transformNodeFiles(modelDir, actions, warnings);

  return { actions, warnings };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
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
      await migrateNodeAnchors(fullPath, actions, warnings);
    }
  }
}

async function migrateNodeAnchors(filePath: string, actions: string[], warnings: string[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  const doc = parseYaml(content) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') {
    warnings.push(`Skipped ${filePath}: not a valid YAML object`);
    return;
  }

  if (!Array.isArray(doc.aspects)) return;

  let changed = false;

  for (const aspectEntry of doc.aspects as unknown[]) {
    if (typeof aspectEntry !== 'object' || aspectEntry === null) continue;
    const entry = aspectEntry as Record<string, unknown>;
    if (!Array.isArray(entry.anchors)) continue;

    // Old format: bare string array — convert each string to a typed realization object
    const converted: Record<string, { regex: string }> = {};
    let hasStrings = false;
    for (const anchor of entry.anchors as unknown[]) {
      if (typeof anchor === 'string' && anchor.trim() !== '') {
        converted[anchor] = { regex: anchor };
        hasStrings = true;
      }
    }

    if (hasStrings) {
      entry.anchors = converted;
      changed = true;
    }
  }

  if (changed) {
    await writeFile(filePath, stringifyYaml(doc, { lineWidth: 120 }), 'utf-8');
    const nodeDir = path.basename(path.dirname(filePath));
    actions.push(`Migrated bare-string anchors in ${nodeDir}/yg-node.yaml`);
  }
}
