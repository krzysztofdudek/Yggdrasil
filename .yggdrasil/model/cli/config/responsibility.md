# CLI Config Responsibility

Build tooling, linting, formatting, and package configuration for the `@chrisdudek/yg` CLI package. Defines how the TypeScript source is compiled, bundled, tested, linted, and published.

## Scope

- **`tsconfig.json`** — TypeScript compiler configuration. Target: ES2022, module system: NodeNext, strict mode enabled, outputs to `dist/`, sources from `src/`. Excludes `tests/` from compilation.
- **`tsup.config.ts`** — Bundle configuration using tsup. Entry: `src/bin.ts`, format: ESM, target: Node 22, generates declarations and sourcemaps. Post-build step runs `scripts/copy-templates.cjs` to copy template files into `dist/`.
- **`vitest.config.ts`** — Test runner configuration. Coverage via v8 provider targeting `src/**/*.ts`. Excludes thin CLI wrappers (tested via E2E subprocess), type-only files, and hard-to-cover platform-specific branches. Coverage thresholds: 85% lines, 90% functions, 69% branches, 82% statements.
- **`eslint.config.js`** — Flat ESLint config with `@typescript-eslint/recommended`. Enforces `no-unused-vars` with `argsIgnorePattern: ^_`. Ignores `dist/`, `coverage/`, config files, and minified JS.
- **`package.json`** — NPM package manifest. Binary name: `yg`. Declares scripts: `build` (tsup), `test` (vitest run), `lint` (eslint src/), `format` (prettier src/). Published as `@chrisdudek/yg`, public access.
- **`.prettierrc` / `.prettierignore`** — Prettier formatting rules.
- **`.npmrc` / `.npmignore`** — NPM publish configuration. Only `dist/` and `graph-schemas/` are included in the published package.
- **`scripts/`** — Build helper scripts (e.g., `copy-templates.cjs` for post-build template distribution).
- **`source/cli/.yggdrasil/`** — Inner Yggdrasil graph used by agents working inside the CLI subpackage; contains a self-referential copy of agent rules.
- **`source/cli/CLAUDE.md`** — Claude agent rules reference for CLI-scoped work.
- **`source/cli/README.md`** — User-facing package documentation.

## Out of scope

- Application source code (`src/`)
- Test files (`tests/`)
- Any runtime behavior of the CLI
