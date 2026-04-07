---
title: CLI Reference
---

You do not need to run these commands in day-to-day use.
Your AI agent runs them automatically.

This page is for people who want to inspect or debug the repo's semantic memory.

---

## Core workflow (4)

| Command | Purpose |
|---------|---------|
| `yg context --file <path>` / `--node <path>` `[--full]` | Assemble context package |
| `yg impact --file <path>` / `--node <path>` / `--aspect <id>` / `--flow <name>` | Blast radius analysis |
| `yg check` | Unified gate — everything wrong, always global |
| `yg approve --node <paths...> [--reviewed "reason"]` / `--aspect <id>` / `--flow <name>` | Record baseline after review |

### `yg context`

Shows the exact context package your agent reads before working on a node. Output is a
two-section YAML format: a structural map (topology, relationships, aspects, flows) followed
by an artifact registry (file paths). Default mode returns paths only — agents read files
individually using their file-reading tool. Alias: `build-context`.

```bash
yg context --node <node-path> [--full]
yg context --file <file-path> [--full]
```

- `--file <path>` — Resolves the owning node automatically, then assembles context. Prints
  owner mapping to stderr. If the file has no graph coverage but other files in the same
  directory are mapped, lists candidate nodes with file counts and a hint to use `--node`.
  Exits 1 if no coverage. Mutually exclusive with `--node`.
- `--full` — Appends artifact file contents below a `---` separator in XML-style tags, for
  environments without file reading capabilities

### `yg impact`

Shows the blast radius of changes to a node, aspect, or flow.
`--file` resolves the owning node automatically, then proceeds as `--node`.

```bash
yg impact --node <path>
yg impact --file <path>
yg impact --aspect <id>
yg impact --flow <name>
```

- `--node` — Show reverse dependencies, descendants, structural dependents of descendants, flows, aspects, and co-aspect nodes
- `--file` — Resolve owner, then proceed as `--node`
- `--aspect` — Show all nodes where this aspect is effective (own, hierarchy, flow, or implied), plus structural dependents of affected nodes
- `--flow` — Show all participants and their descendants, plus structural dependents of participants

Exactly one of `--node`, `--file`, `--aspect`, or `--flow` is required.

### `yg check`

Unified gate combining structural integrity, drift detection, coverage, and completeness.

```bash
yg check
```

Outputs: header (project, counts, coverage), errors grouped by category
(drift, cascade, structural, coverage, completeness), warnings (budget, structure),
result (PASS/FAIL with category counts), and suggested next command.

Exit code 0 if fully clean, 1 if any errors found.

### `yg approve`

Records the current file state as the new baseline after review.
Alias: `drift-sync`.

```bash
yg approve --node <path>
yg approve --node <path1> <path2> <path3>
yg approve --node <path> --reviewed "reason text"
yg approve --aspect <id> [--reviewed "reason"]
yg approve --flow <name> [--reviewed "reason"]
```

Exactly one of `--node`, `--aspect`, or `--flow` is required.

- `--node <paths...>` — One or more node paths to approve. When a single node has no mapping,
  CLI redirects to batch-approve its children with cascade drift.
- `--aspect <id>` — Batch approve all nodes with cascade drift from this aspect.
- `--flow <name>` — Batch approve all nodes with cascade drift from this flow.
- `--reviewed "reason"` — Bypasses the three-axis gate (when only one side changed), but
  the reviewer still verifies aspects (E055) and artifact freshness (E056) if configured.
  Provides audit trail.

---

## Navigation (5)

| Command | Purpose |
|---------|---------|
| `yg select <query> [--limit <n>]` | Find relevant nodes, aspects, and flows |
| `yg tree [--root <path>] [--depth <n>]` | Graph structure |
| `yg aspects` | List aspects |
| `yg flows` | List flows |
| `yg owner --file <path>` | Quick ownership lookup |

### `yg select`

Find graph nodes, aspects, and flows relevant to a task description.

```bash
yg select <query> [--limit <n>]
```

Uses weighted keyword matching against node artifacts (responsibility x3, interface x2,
aspects x2, others x1). Falls back to flow-based selection when no nodes match directly.

- `<query>` — Natural-language task description (positional argument)
- `--limit <n>` — Maximum results per section (default: 5)

Output: structured text with three sections:

- **Nodes** — scored by keyword match against artifacts
- **Aspects** — annotated `(matched)` when directly relevant to the query,
  or `(N nodes)` when the aspect governs returned nodes. Each entry includes
  a `read:` path to its content file.
- **Flows** — annotated `(matched)` when directly relevant, or `(N nodes)`
  when participants overlap with returned nodes. Each entry includes a `read:`
  path to its description file.

### `yg tree`

Prints the full structure of the semantic memory.

```bash
yg tree [--root <path>] [--depth <n>]
```

- `--root <path>` — Show only subtree rooted at this path
- `--depth <n>` — Maximum depth

### `yg aspects`

Lists all defined aspects with metadata.

```bash
yg aspects
```

Output: YAML format with fields: `id`, `name`, `description`, `implies`.

### `yg flows`

Lists all defined flows with metadata.

```bash
yg flows
```

Output: YAML format with fields: `name`, `nodes` (participants), `aspects`.

### `yg owner`

Finds which memory node owns a given file. Path is relative to repository root.
Quick ownership check — use `yg context --file` when you need the full context package.

```bash
yg owner --file <path>
```

---

## Setup (1)

| Command | Purpose |
|---------|---------|
| `yg init [--platform <name>] [--upgrade]` | Initialize or upgrade |

```bash
yg init [--platform <name>] [--upgrade]
```

Creates `.yggdrasil/` and installs the platform instruction file.

- `--platform <name>` — Agent platform (default: `generic`). Values: `cursor`, `claude-code`, `copilot`, `cline`, `roocode`, `codex`, `windsurf`, `aider`, `gemini`, `amp`, `generic`
- `--upgrade` — Refresh rules only when `.yggdrasil/` already exists
