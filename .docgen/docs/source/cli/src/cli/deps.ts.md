Below is clean, comprehensive Markdown documentation tailored to the code you provided. It focuses on purpose, behavior, and usage without restating trivial implementation details.

---

# `registerDepsCommand`

Registers the `deps` command in a Commander-based CLI.  
This command inspects a Yggdrasil model graph and prints a dependency tree for a specific node, including both direct and transitive relationships.

---

## Purpose

The command provides a structured view of how a given model node depends on others. It is designed for debugging, auditing, and understanding graph structure within a Yggdrasil project. By delegating graph loading and tree formatting to dedicated modules, the command acts as a thin integration layer between user input and the underlying dependency‑resolution logic.

---

## Command Overview

### `deps`

Displays the dependency tree for a node located under `.yggdrasil/model/`.

#### Options

| Option | Description |
|--------|-------------|
| `--node <path>` | Required. Path to the node relative to `.yggdrasil/model/`. |
| `--depth <n>` | Optional. Limits how deep the dependency tree is expanded. Useful for large graphs. |
| `--type <type>` | Optional. Filters dependency edges by relation type. Accepted values: `structural`, `event`, `all`. Defaults to `all`. |

---

## Behavior

### Graph Loading

The command loads the project graph from the current working directory using `loadGraph()`.  
If the graph cannot be loaded, the command reports the error and exits with a non‑zero status.

### Node Path Normalization

The provided node path is sanitized to avoid common user mistakes:

- Leading `./` is removed.
- Trailing slashes are stripped.
- Internal formatting is left untouched to preserve the intended node identifier.

This ensures consistent lookup behavior regardless of how the user types the path.

### Relation Type Filtering

The `--type` option is validated against the allowed values.  
Invalid values do not cause an error; instead, the command silently falls back to `all`.  
This prevents unnecessary failures while still giving users control over filtering.

### Dependency Tree Generation

The command delegates tree construction to `formatDependencyTree()`, passing:

- The loaded graph
- The normalized node path
- A configuration object containing:
  - `depth` (if provided)
  - `relationType` (validated filter)

The resulting text is written directly to `stdout`.

### Error Handling

Any unexpected error during execution:

- Is printed to `stderr` with a clear message
- Causes the process to exit with status code `1`

This ensures predictable behavior in scripting or CI environments.

---

## Usage Examples

### Show all dependencies for a node

```bash
cli-tool deps --node domain/user
```

### Limit tree depth

```bash
cli-tool deps --node domain/user --depth 2
```

### Filter by relation type

```bash
cli-tool deps --node domain/user --type structural
```

---

## When to Use This Command

Use `deps` when you need to:

- Understand how a node fits into the broader model
- Investigate unexpected transitive dependencies
- Audit structural or event‑driven relationships
- Debug circular or overly deep dependency chains

It is particularly helpful during refactoring or when onboarding to a complex model.

---

If you'd like, I can also generate documentation for the related modules (`loadGraph`, `formatDependencyTree`) or produce a combined README section.