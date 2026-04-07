# CLI Module Responsibility

The CLI module covers the `@chrisdudek/yg` package — a deterministic command-line tool that implements Yggdrasil's persistent semantic memory for repositories. Reference: docs/concept/foundation.md, engine.md, tools.md.

## Architecture

The CLI is organized in a layered architecture with clear separation of concerns:

| Layer | Path | Role |
| ----- | ---- | ---- |
| `entry/` | `bin.ts` | CLI bootstrap — registers all commands with Commander and invokes the program |
| `commands/` | `cli/` | Command handlers — thin orchestration wrappers that parse options, call core, format output, handle errors |
| `core/` | `core/` | Domain logic — graph loading, context assembly, validation, drift detection, dependency resolution |
| `io/` | `io/` | Filesystem I/O — YAML parsing, file reading, drift-state persistence |
| `model/` | `model/` | Shared TypeScript type definitions — graph, config, node, aspect, flow, drift, validation types |
| `formatters/` | `formatters/` | Output formatting — structured output for context packages, validation results, dependency trees |
| `templates/` | `templates/` | Default config, schemas, and platform-specific agent rules (Cursor, Claude, Windsurf, etc.) |
| `utils/` | `utils/` | Shared utilities — path normalization, SHA-256 hashing, token estimation |

## In scope

- Registering and executing 10 commands: init, build-context, check, approve, impact, tree, owner, aspects, flows, select
- Loading the graph from `.yggdrasil/` (config, model, aspects, flows, schemas)
- Building context packages per the 5-step algorithm (docs/concept/engine.md)
- Validating structural integrity and completeness signals
- Detecting drift between graph mappings and file hashes (SHA-256)
- Resolving dependency order for materialization (topological sort of structural relations)

## Out of scope

- User-domain business logic (the graph is generic)
- Integration with external APIs or network services
- Writing to graph files (model, aspects, flows) — tools read and validate only; agent writes
- Capturing user intent (specify/clarify/plan) — that is process tooling, not this CLI

## Terminology

User-facing terminology uses "reviewer" (config key `reviewer:`, CLI messages "Verifying aspects with reviewer"). Internal TypeScript code uses "LLM" (`LlmConfig`, `LlmProvider`, `llm/` directory, `llmSkipped`). The YAML key `reviewer:` is parsed into the `llm` field on `YggConfig`. This split is deliberate: "reviewer" describes the role (what it does for the user); "LLM" describes the implementation (what it is technically). Renaming internal types would be churn across 20+ files with no user-visible benefit.

## Invariant

Tools never write yg-node.yaml or artifacts. Exception: init creates bootstrap structure; approve writes .drift-state.
