// =============================================================================
// NOT A TEST — the developer command that rewrites the generated parts of the
// CLI reference.
//
// `npm run cli-reference:update` in source/cli runs it through
// vitest.update.config.ts (the only config that collects *.update.ts; `npm test`
// never runs it), then runs the two guards against what it wrote. In order:
//
//   1. every flag table on docs/cli-reference.md (between
//      `<!-- flags: yg <command> -->` and `<!-- /flags -->`) is rendered again
//      from that command's `--help` — guard: tests/e2e/cli-reference-truth.test.ts;
//   2. the knowledge cli-reference topic (templates/knowledge/cli-reference-page.ts)
//      is rendered again from the page it just wrote — guard:
//      tests/unit/repo/knowledge-cli-reference.test.ts.
//
// It reads the flags from the built CLI (dist/bin.js), so build first. The
// siblings tests/unit/repo/generated-files.update.ts and golden-corpus.update.ts
// hold the other generated-file steps.
// =============================================================================

import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DOCS_CLI_REFERENCE, readHelpTree, renderFlagBlocks } from '../support/cli-help-tree.js';
import { KNOWLEDGE_CLI_REFERENCE_PAGE, renderKnowledgeCliReference } from '../support/cli-reference-knowledge.js';

it('cli-reference:update', async () => {
  const page = renderFlagBlocks(readFileSync(DOCS_CLI_REFERENCE, 'utf-8'), await readHelpTree());
  writeFileSync(DOCS_CLI_REFERENCE, page);
  writeFileSync(KNOWLEDGE_CLI_REFERENCE_PAGE, renderKnowledgeCliReference(page));
}, 120_000);
