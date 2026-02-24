import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SchemaDef } from '../model/types.js';

export async function parseSchema(filePath: string): Promise<SchemaDef> {
  const content = await readFile(filePath, 'utf-8');
  parseYaml(content); // validate YAML is parseable
  const schemaType = path.basename(filePath, path.extname(filePath));
  return { schemaType };
}
