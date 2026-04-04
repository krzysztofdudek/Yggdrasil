import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/bin.ts',
        'src/templates/**',
        'src/cli/**', // thin Commander.js wrappers — tested via E2E subprocess
        'src/model/types.ts', // type-only definitions — no runtime code
        'src/core/graph-from-git.ts', // git/archive — try/catch branches hard to cover
        'src/core/graph-loader.ts', // loadAspects/Flows/Knowledge/Templates — catch on missing dirs
        'src/llm/**', // LLM provider stubs — no runtime usage yet (Plan 3)
      ],
      thresholds: {
        lines: 85,
        functions: 90,
        branches: 69,
        statements: 82,
      },
    },
  },
});
