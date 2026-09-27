// =============================================================================
// GUARD — the docs field tables are rendered from the file-format schemas.
//
// Every YAML file the CLI reads is described once, as a schema object in
// source/cli/src/utils/file-formats*.ts: its parser takes its accepted keys from
// it and checks value types against it (tests/unit/repo/file-format-conformance
// holds the two together), and `yg schemas read <name>` prints its field table.
// The docs pages carry the same table between `file-schema:<name>` markers —
// generated, so a page can neither list a key the parser refuses nor miss one it
// reads. This test renders each table and fails on any difference;
// `npm run schemas:update` (generated-files.update.ts) rewrites them. This test
// only reads.
//
// Hermetic & fast: reads files and imports the schemas; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';
import { renderFieldTable } from '../../../src/utils/file-schema.js';
import { blockPattern, docsPages, renderBlock } from './file-schema-blocks.js';

describe('the docs field tables are rendered from the file-format schemas', () => {
  for (const format of FILE_FORMATS) {
    it(`docs carry the ${format.name} field table exactly once, as rendered`, () => {
      const pages = docsPages().filter((p) => blockPattern(format.name).test(readFileSync(p, 'utf-8')));
      expect(pages.map((p) => path.basename(p)), `no docs page (or more than one) carries the ${format.name} field table`).toHaveLength(1);
      const page = pages[0];
      const text = readFileSync(page, 'utf-8');
      const rendered = renderBlock(format.name);
      const current = text.match(blockPattern(format.name))![0];
      expect(current, `the ${format.name} field table in docs/${path.basename(page)} differs from the schema — run npm run schemas:update in source/cli`).toBe(rendered);
    });
  }

  it('names no format the CLI does not read', () => {
    const known = new Set(FILE_FORMATS.map((f) => f.name));
    const named: string[] = [];
    for (const page of docsPages()) {
      for (const m of readFileSync(page, 'utf-8').matchAll(/<!-- file-schema:([a-z-]+):start/g)) if (!known.has(m[1])) named.push(`${path.basename(page)}: ${m[1]}`);
    }
    expect(named).toEqual([]);
  });

  it('every field has a one-line meaning', () => {
    for (const format of FILE_FORMATS) {
      const table = renderFieldTable(format);
      expect(table, format.name).not.toMatch(/\|\s*\|\s*$/m);
    }
  });
});
