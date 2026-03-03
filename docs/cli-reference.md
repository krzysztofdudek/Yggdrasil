---
title: CLI Reference
---

You do not need to run these commands in day-to-day use.
Your AI agent runs them automatically.

This page is for people who want to inspect or debug the repo's semantic memory.

---

## Setup

```bash
yg init [--platform <name>] [--upgrade]
```

Creates `.yggdrasil/` and installs the platform instruction file.

- `--platform <name>` — Agent platform (default: `generic`). Values: `cursor`, `claude-code`, `copilot`, `cline`, `roocode`, `codex`, `windsurf`, `aider`, `gemini`, `amp`, `generic`
- `--upgrade` — Refresh rules only when `.yggdrasil/` already exists

---

## Inspection

```bash
yg status
```

Summary: nodes, warnings, drift status.

```bash
yg tree [--root <path>] [--depth <n>]
```

Prints the full structure of the semantic memory.

- `--root <path>` — Show only subtree rooted at this path
- `--depth <n>` — Maximum depth

```bash
yg build-context --node <node-path>
```

Shows the exact context package your agent reads before working on a node (plain text with
XML-like tags).

```bash
yg owner --file <path>
```

Finds which memory node owns a given file. Path is relative to repository root.

```bash
yg deps --node <path> [--depth <n>] [--type <structural|event|all>]
```

Shows direct and transitive node dependencies.

- `--depth <n>` — Maximum depth for tree
- `--type <type>` — Relation filter: `structural`, `event`, `all` (default: `all`)

---

### `yg preflight`

Unified diagnostic report combining journal, drift, status, and validation.

```bash
yg preflight [--quick]
```

Outputs:

- **Journal** — pending entries from previous sessions
- **Drift** — nodes with source or graph drift (skipped with `--quick`)
- **Status** — node, aspect, flow, and mapping counts
- **Validation** — structural errors and completeness warnings

- `--quick` — Skip drift detection for faster results (useful for large repos)

Exit code 0 if fully clean, 1 if journal entries, drift, or validation errors found.

---

## Validation

```bash
yg validate [--scope <scope>]
```

Checks the memory for structural errors and quality warnings.
Exit code 1 on errors — useful as a CI merge gate.

- `--scope <scope>` — `all` or node-path; includes descendant nodes (default: `all`)

---

## Aspects

```bash
yg aspects
```

Lists all defined aspects with metadata.

Output: YAML format with fields: `id`, `name`, `description`, `implies`.

---

## Flows

```bash
yg flows
```

Lists all defined flows with metadata.

Output: YAML format with fields: `name`, `nodes` (participants), `aspects`.

---

## Drift detection

```bash
yg drift [--scope <scope>] [--drifted-only] [--limit <n>]
```

Detects source and graph drift — files that changed outside the semantic memory (source drift)
and graph artifacts that changed without a corresponding `drift-sync` (graph drift).

- `--scope <scope>` — `all` or node-path; includes descendant nodes (default: `all`)
- `--drifted-only` — Show only nodes with drift (hide ok entries)
- `--limit <n>` — Maximum entries to show per section (truncated sections show remaining count)

```bash
yg drift-sync --node <path> [--recursive]
yg drift-sync --all
```

Records current file hash after resolving drift.

- `--recursive` — Also sync all descendant nodes
- `--all` — Sync all nodes with mappings

---

## Impact analysis

```bash
yg impact --node <path> [--simulate]
yg impact --aspect <id> [--simulate]
yg impact --flow <name> [--simulate]
```

Shows the blast radius of changes to a node, aspect, or flow.

- `--node` — Show reverse dependencies, descendants, flows, aspects, and co-aspect nodes
- `--aspect` — Show all nodes where this aspect is effective (own, hierarchy, flow, or implied)
- `--flow` — Show all participants and their descendants
- `--simulate` — Simulate context package impact (compare HEAD vs current)

Exactly one of `--node`, `--aspect`, or `--flow` is required.

---

## Journal

```bash
yg journal-add --note <text> [--target <node-path>]
```

Adds a note to the session journal.

```bash
yg journal-read
```

Lists pending journal entries.

```bash
yg journal-archive
```

Archives journal after consolidating notes to graph.
