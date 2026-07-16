import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readTextFile, atomicWriteTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';

export interface Migration {
  to: string;
  description: string;
  run(yggRoot: string): Promise<MigrationResult>;
}

export interface MigrationResult {
  actions: string[];
  warnings: string[];
  /** When false, the runner skips updateConfigVersion. Defaults to true. */
  bumpVersion?: boolean;
}

/**
 * Detect Yggdrasil version from yg-config.yaml.
 * Returns semver string or null if no config found.
 */
export async function detectVersion(yggRoot: string): Promise<string | null> {
  const root = toPosixPath(yggRoot.trim());
  const configPath = path.join(root, 'yg-config.yaml');
  try {
    const content = await readTextFile(configPath);
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
 * Update version field in yg-config.yaml.
 */
export async function updateConfigVersion(yggRoot: string, version: string): Promise<void> {
  const root = toPosixPath(yggRoot.trim());
  const configPath = path.join(root, 'yg-config.yaml');
  const content = await readTextFile(configPath);
  const updated = content.match(/^version:\s/m)
    ? content.replace(/^version:\s.*$/m, `version: "${version}"`)
    : `version: "${version}"\n` + content;
  await atomicWriteTextFile(configPath, updated);
}
