import { defineConfig } from 'vitest/config';

// Runs the generated-file update steps (tests/unit/repo/generated-files.update.ts
// and its e2e sibling tests/e2e/golden-corpus.update.ts) and nothing else: the
// npm scripts glossary:update, codes:update, schemas:update, json-schemas:update,
// prose:baseline and golden:update each pick one step by name. The main config
// never collects *.update.ts, so `npm test` only reads. The steps run under the
// main config's setup (the git-fixture isolation and the per-run TMPDIR), so the
// golden corpus is recorded in the same environment its guard replays it in.
export default defineConfig({
  test: {
    include: ['tests/**/*.update.ts'],
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/support/global-tmpdir.ts'],
    testTimeout: 30000,
  },
});
