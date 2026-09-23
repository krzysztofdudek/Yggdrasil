import path from 'node:path';
import { readTextFile, atomicWriteTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';
import { parseSchemaVersionText, type SchemaVersionField } from '../io/config-parser.js';

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
 * Read the schema `version:` field of `<yggRoot>/yg-config.yaml` through the one
 * shared reader. Null when the file is missing, unreadable, or not a YAML
 * mapping — the config parser reports those; this answers only what the version
 * field holds.
 */
export async function readSchemaVersion(yggRoot: string): Promise<SchemaVersionField | null> {
  const root = toPosixPath(yggRoot.trim());
  const configPath = path.join(root, 'yg-config.yaml');
  let content: string;
  try {
    content = await readTextFile(configPath);
  } catch {
    return null;
  }
  return parseSchemaVersionText(content);
}

/**
 * The declared schema version when it is a string (trimmed), else null — absent,
 * not a string, or no readable config. Callers that must tell those cases apart
 * use {@link readSchemaVersion}.
 */
export async function detectVersion(yggRoot: string): Promise<string | null> {
  const read = await readSchemaVersion(yggRoot);
  return read?.kind === 'string' ? read.value : null;
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
