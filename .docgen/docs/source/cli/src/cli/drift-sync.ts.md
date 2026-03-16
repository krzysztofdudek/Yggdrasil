Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the `drift-sync` command without restating obvious language-level details.

---

# `drift-sync` Command

The `drift-sync` command records the current file-hash state for one or more graph nodes after drift has been resolved. It is designed for tools that track file‑system drift by comparing stored hashes against the current state of mapped files.

This command integrates with the project’s graph model, drift‑detection logic, and drift‑state storage. It ensures that the drift state remains accurate and that obsolete drift records are removed when syncing the entire graph.

---

## Purpose

`drift-sync` exists to:

- Update the stored drift state for selected nodes so future drift detection reflects the current file system.
- Allow targeted or bulk synchronization depending on workflow needs.
- Ensure drift state storage remains clean by removing orphaned state files when syncing all nodes.
- Validate node paths and mapping configurations before attempting synchronization.

It is not a drift detector itself; instead, it finalizes drift resolution by writing updated hashes.

---

## Command Usage

### Basic Invocation

```bash
drift-sync --node <path>
```

Synchronizes a single node’s drift state.

### Recursive Sync

```bash
drift-sync --node <path> --recursive
```

Synchronizes the specified node and all of its descendant nodes (based on path prefix).

### Sync All Mapped Nodes

```bash
drift-sync --all
```

Synchronizes every node in the graph that has at least one mapping. After syncing, orphaned drift-state files are removed.

### Required Options

You must specify **either**:

- `--node <path>`  
- `--all`

If neither is provided, the command exits with an error.

---

## Behavior Overview

### Graph Loading

The command loads the project graph from the current working directory. All node resolution and mapping checks are performed against this graph.

### Node Selection Logic

#### When `--all` is used
- Every node with at least one normalized mapping path is included.
- Nodes are sorted for deterministic output.

#### When `--node` is used
- The provided path is normalized (removing leading `./` and trailing slashes).
- If the node does not exist in the graph, `syncDriftState` is invoked to trigger its own error handling.
- If `--recursive` is provided, all descendant nodes (sharing the same prefix) are included.

### Drift Synchronization

For each selected node:

- Nodes without mappings are skipped unless:
  - The user explicitly targeted the node (non‑recursive, non‑all), in which case `syncDriftState` is called to surface the appropriate error.
- `syncDriftState` returns both the previous and current hash.
- A short hash preview is printed (`first 8 chars`).

### Garbage Collection (only with `--all`)

After syncing all mapped nodes:

- A set of valid node paths is constructed.
- `garbageCollectDriftState` removes drift-state files that no longer correspond to any mapped node.
- Removed paths are printed in dimmed output.

### Error Handling

Any thrown error is caught and printed to stderr. The process exits with status `1` to signal failure.

---

## Output Format

For each synchronized node:

```
Synchronized: <node-path>
  Hash: <old-hash> -> <new-hash>
```

For removed orphaned drift-state files:

```
Removed orphaned drift state: <path>
```

Errors are printed as:

```
Error: <message>
```

---

## When to Use `drift-sync`

Use this command when:

- You have resolved drift manually and want to update the stored hash.
- You want to ensure the drift-state store reflects the current state of all mapped nodes.
- You need to clean up drift-state files after structural changes to the graph.

It is especially useful in CI pipelines or developer workflows where drift detection is part of a validation step.

---

If you'd like, I can also generate a shorter README‑style version or integrate this into existing project documentation.