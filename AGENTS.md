# Agent Instructions — Yggdrasil Repository

You work on the Yggdrasil repository: an open-source product (CLI + infrastructure) that gives repositories persistent semantic memory for AI agents. This repo both implements Yggdrasil and uses it on itself (dogfooding).

## Context — Where Things Live

| Path                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `docs/idea/`            | Spec — source of truth. tools.md = schemas, operations. engine.md = algorithms.     |
| `source/cli/`           | Implementation — CLI code. Must match spec.                                         |
| `.yggdrasil/model/cli/` | Semantic memory — describes intended CLI. Code materializes it.                       |
| `docs/`                 | User docs — for adopters.                                                           |
| `.plans/`               | Agent working dir — design docs and implementation plans. **Ignore skill paths** (e.g. `docs/plans/`) — always use `<root>/.plans/YYYY-MM-DD-<topic>-design.md` and `.plans/YYYY-MM-DD-<topic>-plan.md`. Gitignored; not committed. |

## Constraints

- Never edit generated rules (platform-specific rules files, or the Yggdrasil section in `AGENTS.md`). To change the rules content: edit `source/cli/src/templates/rules.ts` (content) or `source/cli/src/templates/platform.ts` (frontmatter), then build and run `yg init --platform <name> --upgrade`.
- **Ignore generated rules files** for understanding: `.yggdrasil/agent-rules.md`, `.cursor/rules/yggdrasil.mdc`, etc. are auto-generated output. Never read or search them. The source of truth for rules content is `source/cli/src/templates/rules.ts`.
- When modifying `docs/` or any `*.md`, run `npx markdownlint-cli2 "**/*.md" ".markdownlint-cli2.jsonc"` and fix issues.
- **Always reflect changes in corresponding documentation.** When modifying code behavior, algorithms, or data structures, identify and update all documentation that describes the changed behavior — `docs/idea/` (spec), `docs/` (user docs), and `.yggdrasil/` (graph metadata). Changes to the spec or engine behavior are not complete until every document describing that behavior is consistent.

## Adding Support for a New Agent

To add a new platform (e.g. a new IDE or agent): add it to `source/cli/src/templates/platform.ts` — implement `installFor<Platform>` to write the rules file to the agent's expected location.

## Version Bump & Changelog

- **Changelog is always updated.** Every code or behavior change gets an entry under `## [Unreleased]` in `CHANGELOG.md`. This happens as part of normal work — do not wait for a release.
- **Version bumps only on explicit user request.** Never bump the version in `source/cli/package.json` unless the user explicitly asks for a release. When they do:
  1. Bump version (patch/minor/major per [semver](https://semver.org/)).
  2. Run `npm install` in `source/cli/` to update `package-lock.json`.
  3. Move `[Unreleased]` entries to the new version section in `CHANGELOG.md`.

## Quality Gate

Run `scripts/repo-check.sh` from repo root before finishing. It is the canonical fail-fast entrypoint.

## When Evaluating `yg validate` or `scripts/repo-check.sh`

Consider both:

1. **Product** — Is the command correct and useful for adopters?
2. **Dogfood** — Is this repo's semantic memory mature enough? Gaps are expected.
