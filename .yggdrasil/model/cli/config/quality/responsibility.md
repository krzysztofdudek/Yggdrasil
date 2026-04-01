# Quality Config — Responsibility

Code quality tooling configuration for the `@chrisdudek/yg` CLI package. Defines linting rules, test runner behavior, coverage thresholds, and formatting standards.

## Scope

- `eslint.config.js` — Flat ESLint config with `@typescript-eslint/recommended`. Enforces `no-unused-vars` with `argsIgnorePattern: ^_`. Ignores `dist/`, `coverage/`, config files, and minified JS.
- `vitest.config.ts` — Test runner configuration. Coverage via v8 provider targeting `src/**/*.ts`. Excludes thin CLI wrappers (tested via E2E subprocess), type-only files, and hard-to-cover platform-specific branches. Coverage thresholds: 85% lines, 90% functions, 69% branches, 82% statements.
- `.prettierrc` — Prettier formatting rules (indent, quotes, trailing commas).
- `.prettierignore` — Files excluded from Prettier formatting.

## Out of scope

- Build and bundle configuration (tsconfig, tsup) — belongs to `cli/config/build`
- Documentation and agent rules files — belongs to `cli/config/docs`
- Test files themselves — belong to `cli/tests` child nodes
