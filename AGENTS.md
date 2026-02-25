# Agent Instructions — Yggdrasil Repository

You work on the Yggdrasil repository: an open-source product (CLI + infrastructure) that gives repositories persistent semantic memory for AI agents. This repo both implements Yggdrasil and uses it on itself (dogfooding).

## Context — Where Things Live

| Path                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `docs/idea/`            | Spec — source of truth. tools.md = schemas, operations. engine.md = algorithms.     |
| `source/cli/`           | Implementation — CLI code. Must match spec.                                         |
| `.yggdrasil/model/cli/` | Semantic memory — describes intended CLI. Code materializes it.                       |
| `docs/`                 | User docs — for adopters.                                                           |

## Constraints

- Never edit generated rules (platform-specific rules files, or the Yggdrasil section in `AGENTS.md`). To change the rules content: edit `source/cli/src/templates/rules.ts` (content) or `source/cli/src/templates/platform.ts` (frontmatter), then build and run `yg init --platform <name> --upgrade`.
- When modifying `docs/` or any `*.md`, run `npx markdownlint-cli2 "**/*.md" ".markdownlint-cli2.jsonc"` and fix issues.

## Adding Support for a New Agent

To add a new platform (e.g. a new IDE or agent): add it to `source/cli/src/templates/platform.ts` — implement `installFor<Platform>` to write the rules file to the agent's expected location.

## Version Bump & Changelog

When releasing changes:

1. **Bump version** in `source/cli/package.json` (patch/minor/major per [semver](https://semver.org/)).
2. Run `npm install` in `source/cli/` to update `package-lock.json`.
3. **Always update `CHANGELOG.md`** — every release must have a corresponding entry. Add new section at the top (below `## [Unreleased]` if present, or directly under the header). Use format from [Keep a Changelog](https://keepachangelog.com/).

## Quality Gate

Run `scripts/repo-check.sh` from repo root before finishing. It is the canonical fail-fast entrypoint.

## When Evaluating `yg validate` or `scripts/repo-check.sh`

Consider both:

1. **Product** — Is the command correct and useful for adopters?
2. **Dogfood** — Is this repo's semantic memory mature enough? Gaps are expected.
