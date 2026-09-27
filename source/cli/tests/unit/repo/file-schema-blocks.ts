// The docs field tables as rendered from the file-format schemas, shared by
// the guard that compares the committed tables with them
// (file-schema-tables.test.ts) and the command that rewrites them
// (generated-files.update.ts, run by `npm run schemas:update`). Reads the docs
// directory listing only; writes nothing.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';
import { renderFieldTable } from '../../../src/utils/file-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const startMarker = (name: string): string =>
  `<!-- file-schema:${name}:start — generated from the ${name} schema in source/cli/src/utils/file-formats*.ts; edit the schema, then run npm run schemas:update in source/cli -->`;
const endMarker = (name: string): string => `<!-- file-schema:${name}:end -->`;
export const blockPattern = (name: string): RegExp => new RegExp(`<!-- file-schema:${name}:start[^>]*-->[\\s\\S]*?<!-- file-schema:${name}:end -->`);

export function renderBlock(name: string): string {
  const format = FILE_FORMATS.find((f) => f.name === name)!;
  return `${startMarker(name)}\n\n${renderFieldTable(format, { html: true })}\n\n${endMarker(name)}`;
}

export function docsPages(): string[] {
  return readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).map((f) => path.join(DOCS_DIR, f));
}
