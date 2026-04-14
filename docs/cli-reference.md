---
title: CLI Reference
---

You do not need to run these commands in day-to-day use.
Your AI agent runs them automatically.

This page is for inspecting or debugging your graph and enforcement state.

---

## Core workflow (4)

| Command | Purpose |
|---------|---------|
| `yg context --file <path>` / `--node <path>` | Assemble context package |
| `yg impact --file <path>` / `--node <path>` / `--aspect <id>` / `--flow <name>` | Blast radius analysis |
| `yg check` | Unified gate — everything wrong, always global |
| `yg approve --node <paths...>` / `--aspect <id>` / `--flow <name>` | Record baseline after review |

### `yg context`

Shows the exact context package your agent reads before working on a node. Output is
structured text with `read:` pointers to content files. Agents read files individually
using their file-reading tool.

```bash
yg context --node <node-path>
yg context --file <file-path>
```

- `--file <path>` — Resolves the owning node automatically, then assembles context. Prints
  owner mapping to stderr. If the file has no graph coverage but other files in the same
  directory are mapped, lists candidate nodes with file counts and a hint to use `--node`.
  Exits 1 if no coverage. Mutually exclusive with `--node`.

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
(drift, cascade, structural, architecture, coverage, completeness), warnings,
result (PASS/FAIL with category counts), and suggested next command.

Exit code 0 if fully clean, 1 if any errors found.

### `yg approve`

Records the current file state as the new baseline after review.

```bash
yg approve --node <path>
yg approve --node <path1> <path2> <path3>
yg approve --aspect <id>
yg approve --flow <name>
yg approve --dry-run --node <path>
```

Exactly one of `--node`, `--aspect`, or `--flow` is required.

- `--node <paths...>` — One or more node paths to approve. When a single node has no mapping,
  CLI redirects to batch-approve its children with cascade drift.
- `--aspect <id>` — Batch approve all nodes with cascade drift from this aspect.
- `--flow <name>` — Batch approve all nodes with cascade drift from this flow.
- `--dry-run` — Show what would be sent to the reviewer (aspects, source files, prompt)
  without making the LLM call. Only works with `--node`.

---

## Navigation (4)

| Command | Purpose |
|---------|---------|
| `yg tree [--root <path>] [--depth <n>]` | Graph structure |
| `yg aspects` | List aspects |
| `yg flows` | List flows |
| `yg owner --file <path>` | Quick ownership lookup |

### `yg tree`

Prints all nodes with path, type, and description in a hierarchical tree.

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

Finds which node owns a given file. Path is relative to repository root.
Quick ownership check — use `yg context --file` when you need the full context package.

```bash
yg owner --file <path>
```

---

## Setup (1)

| Command | Purpose |
|---------|---------|
| `yg init` | Initialize or reconfigure |

```bash
yg init
yg init --upgrade --platform claude-code
```

Interactive wizard. On a new project: walks you through platform selection and
reviewer setup. On an existing project: offers upgrade, reviewer reconfiguration,
or platform change.

Non-interactive mode: `--upgrade --platform <name>` refreshes rules and schemas
without prompts. Useful in scripts and CI.
