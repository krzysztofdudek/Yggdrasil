// =============================================================================
// NOT A TEST — the developer command that rewrites the generated files.
//
// Five sets of files in this repository are generated from one source each, and a
// guard test fails when the committed file differs from what the source
// renders. The guards only read; this module is where the files are written.
// Each step below is one npm script in source/cli/package.json, which runs it
// through its own Vitest config (vitest.update.config.ts, the only config that
// collects *.update.ts; `npm test` never runs it) and then runs the step's guard
// against what it wrote:
//
//   glossary:update       docs/glossary.md          glossary-sync.test.ts
//   codes:update          the issue-code tables     issue-code-tables.test.ts
//   schemas:update        the docs field tables     file-schema-tables.test.ts
//   json-schemas:update   docs/public/schemas/      json-contract-schemas.test.ts
//   prose:baseline        e2e-prose-baseline.json   e2e-prose-ratchet.test.ts
//
// The golden output corpus (golden:update) is written by the e2e sibling,
// tests/e2e/golden-corpus.update.ts, and the CLI reference's flag tables and
// knowledge topic (cli-reference:update) by tests/e2e/cli-reference.update.ts,
// through the same config.
//
// Vitest is only the TypeScript runner here: the renderers import the CLI's
// TypeScript sources, which plain node cannot load. Every step renders from
// the committed sources alone, so the same tree always writes the same bytes.
// =============================================================================

import { it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { schemaFileName } from '../../support/json-schema-validate.js';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';
import { blockPattern, docsPages, renderBlock } from './file-schema-blocks.js';
import { loadGlossary, PAGE_PATH, render } from './glossary-page.js';
import { DOCS_PAGE, END, KNOWLEDGE_TABLE, renderDocsBlock, renderKnowledgeModule, START } from './issue-code-render.js';
import { deriveDocumentSchemas, PUBLISHED_SCHEMAS_DIR, schemaFileText } from './json-schema-from-types.js';
import { BASELINE_PATH, currentCounts, loweredBaselineText, readBaseline } from './prose-baseline.js';

it('glossary:update', () => {
  writeFileSync(PAGE_PATH, render(loadGlossary().entries));
});

it('codes:update', () => {
  const page = readFileSync(DOCS_PAGE, 'utf-8');
  const start = page.indexOf(START);
  const end = page.indexOf(END);
  if (start === -1 || end < start) throw new Error(`${DOCS_PAGE} has no issue-codes start and end markers`);
  writeFileSync(DOCS_PAGE, page.slice(0, start) + renderDocsBlock() + page.slice(end + END.length));
  writeFileSync(KNOWLEDGE_TABLE, renderKnowledgeModule());
});

it('schemas:update', () => {
  for (const format of FILE_FORMATS) {
    const pages = docsPages().filter((p) => blockPattern(format.name).test(readFileSync(p, 'utf-8')));
    if (pages.length !== 1) throw new Error(`no docs page (or more than one) carries the ${format.name} field table: ${pages.map((p) => path.basename(p)).join(', ')}`);
    const text = readFileSync(pages[0], 'utf-8');
    writeFileSync(pages[0], text.replace(blockPattern(format.name), () => renderBlock(format.name)));
  }
});

it('json-schemas:update', () => {
  mkdirSync(PUBLISHED_SCHEMAS_DIR, { recursive: true });
  for (const [id, schema] of deriveDocumentSchemas()) writeFileSync(path.join(PUBLISHED_SCHEMAS_DIR, schemaFileName(id)), schemaFileText(schema));
}, 120000);

it('prose:baseline', () => {
  writeFileSync(BASELINE_PATH, loweredBaselineText(readBaseline(), currentCounts()), 'utf-8');
});
