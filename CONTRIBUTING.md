# Contributing to Yggdrasil

Thank you for your interest in contributing to Yggdrasil!

Questions? Email <me@chrisdudek.com>.

## Prerequisites

- Node.js 22+
- npm 10+
- Git

## Development Setup

### Option A: Dev Container (recommended)

1. Open the repository in VS Code / Cursor
2. When prompted, click "Reopen in Container"
3. Wait for the container to build (first time takes ~2 minutes)
4. The CLI will be available as `yg` globally

### Option B: Local

```bash
cd source/cli
npm install
npm run build
npm link    # makes `yg` available globally
```

## Development Workflow

1. Create a feature branch: `git checkout -b feature/my-change`
2. Make changes — update the graph (`.yggdrasil/`) and/or code as needed
3. Run tests: `cd source/cli && npm test`
4. Run linter: `npm run lint`
5. Build: `npm run build`
6. Submit a PR against `main`

### Updating rules or templates

After modifying `source/cli/src/templates/` (rules, commands, adapters), run `yg init` and select "Upgrade rules and schemas" to refresh the rules file in this repo. The CLI is npm-linked, so it picks up local changes.

## Repository Quality Check (recommended before PR)

Run the unified repository validation from root:

```bash
scripts/repo-check.sh
```

VS Code task equivalent:

- `Repo: Check All` (defined in `Yggdrasil.code-workspace`)

This flow is fail-fast and covers CLI typecheck/lint/build/test, docs build, markdown lint, and `yg check`.

## Pull Request Guidelines

- Include tests for new functionality
- Update documentation if behavior changes
- Keep PRs focused — one feature/fix per PR
- Ensure CI passes before requesting review

## Code Style

- TypeScript strict mode
- ESM modules (`import`/`export`, not `require`)
- Prettier for formatting (runs on save if configured)
- ESLint for static analysis

## AI Contribution Disclosure

If you used AI tools to generate code for your contribution, please note this in the PR description. This is not a restriction — just transparency.

## Architecture

See [docs/](docs/) for guides and specifications.
See [source/cli/README.md](source/cli/README.md) for CLI architecture overview.

### Dogfooding

Yggdrasil uses its own mechanism — the `.yggdrasil/` directory at the project root holds the architecture graph with aspects that enforce rules on the CLI's own source code. The agent rules file (installed by `yg init`) instructs the agent how to work with the graph.
