import { defineConfig } from 'vitest/config';

/**
 * Config for tests with external dependencies (Ollama, APIs, etc.).
 * Run manually: npm run test:external
 * NOT included in default test run or CI.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.external.test.ts'],
  },
});
