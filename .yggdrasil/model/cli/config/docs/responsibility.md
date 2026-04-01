# CLI Package Docs — Responsibility

Package-level documentation and build helper scripts for the `@chrisdudek/yg` CLI. Provides human- and agent-facing reference material and post-build automation.

## Scope

- `CLAUDE.md` — Claude agent rules reference for CLI-scoped work; routes agents to the inner `.yggdrasil/` graph.
- `README.md` — User-facing package documentation published to npm.
- `scripts/` — Build helper scripts, primarily `copy-templates.cjs` which copies template files from `src/templates/` into `dist/` as part of the post-build step.

## Out of scope

- Build and bundle configuration — belongs to `cli/config/build`
- Code quality tooling — belongs to `cli/config/quality`
- Application source code — belongs to `cli/core` and related nodes
