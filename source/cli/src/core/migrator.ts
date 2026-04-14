import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { gt, valid, compare } from 'semver';

export interface Migration {
  to: string;
  description: string;
  run(yggRoot: string): Promise<MigrationResult>;
}

export interface MigrationResult {
  actions: string[];
  warnings: string[];
}

/**
 * Detect Yggdrasil version from yg-config.yaml.
 * Returns semver string or null if no config found.
 */
export async function detectVersion(yggRoot: string): Promise<string | null> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  try {
    const content = await readFile(configPath, 'utf-8');
    const raw = parseYaml(content) as Record<string, unknown>;
    if (raw && typeof raw === 'object' && typeof raw.version === 'string') {
      return raw.version.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run all applicable migrations sequentially.
 * A migration is applicable when its target version is strictly greater than currentVersion.
 */
export async function runMigrations(
  currentVersion: string,
  migrations: Migration[],
  yggRoot: string,
): Promise<MigrationResult[]> {
  const cVer = valid(currentVersion);
  if (!cVer) return [];

  const applicable = migrations
    .filter((m) => {
      const mVer = valid(m.to);
      if (!mVer) return false;
      return gt(mVer, cVer);
    })
    .sort((a, b) => compare(valid(a.to)!, valid(b.to)!));

  const results: MigrationResult[] = [];
  for (const migration of applicable) {
    const result = await migration.run(yggRoot);
    results.push(result);
  }
  return results;
}

/**
 * Update version field in yg-config.yaml.
 */
export async function updateConfigVersion(yggRoot: string, version: string): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const content = await readFile(configPath, 'utf-8');
  const updated = content.match(/^version:\s/m)
    ? content.replace(/^version:\s.*$/m, `version: "${version}"`)
    : `version: "${version}"\n` + content;
  await writeFile(configPath, updated, 'utf-8');
}
