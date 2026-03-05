import { readFile, access } from 'node:fs/promises';
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
 * Detect the Yggdrasil version of a project.
 * Returns semver string, '1.4.3' for pre-version projects, or null if no config found.
 * Version field validation is intentionally deferred to the migration runner, not the config parser,
 * since migrating old configs is exactly the purpose of this module.
 */
export async function detectVersion(yggRoot: string): Promise<string | null> {
  // Try yg-config.yaml first
  const newConfigPath = path.join(yggRoot, 'yg-config.yaml');
  try {
    const content = await readFile(newConfigPath, 'utf-8');
    const raw = parseYaml(content) as Record<string, unknown>;
    if (raw && typeof raw === 'object' && typeof raw.version === 'string') {
      return raw.version.trim();
    }
    return '1.4.3'; // yg-config.yaml exists but no version field → pre-2.0.0
  } catch {
    // yg-config.yaml not found
  }

  // Try old config.yaml (1.x format)
  const oldConfigPath = path.join(yggRoot, 'config.yaml');
  try {
    await access(oldConfigPath);
    return '1.4.3';
  } catch {
    return null;
  }
}

/**
 * Run all applicable migrations sequentially.
 * A migration is applicable when its target version is strictly greater than currentVersion.
 * Migrations are sorted by target version ascending before running.
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
