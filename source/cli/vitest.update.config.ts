import { defineConfig } from 'vitest/config';

// Runs the generated-file update steps (tests/unit/repo/generated-files.update.ts)
// and nothing else: the npm scripts glossary:update, codes:update,
// schemas:update, json-schemas:update and prose:baseline each pick one step by
// name. The main config never collects *.update.ts, so `npm test` only reads.
export default defineConfig({
  test: {
    include: ['tests/**/*.update.ts'],
    testTimeout: 30000,
  },
});
