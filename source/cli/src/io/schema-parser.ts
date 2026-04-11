import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SchemaDef } from '../model/graph.js';

export async function parseSchema(filePath: string): Promise<SchemaDef> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;
  if (raw != null && typeof raw !== 'object') {
    throw new Error(`${filename} at ${filePath}: expected YAML mapping or empty document`);
  }
  const rawName = path.basename(filePath, path.extname(filePath));
  const schemaType = rawName.startsWith('yg-') ? rawName.slice(3) : rawName;
  return { schemaType };
}
