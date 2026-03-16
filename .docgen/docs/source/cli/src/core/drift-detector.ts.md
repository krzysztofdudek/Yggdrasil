Below is comprehensive, purpose‑driven Markdown documentation for the provided module. It avoids restating what the code already makes obvious and instead focuses on intent, behavior, and usage patterns.

---

# Drift Detection & Synchronization Module

This module provides the core logic for detecting and synchronizing *drift* between a node’s expected file state (as recorded in drift metadata) and the actual state of files on disk. It is designed for systems where nodes map to sets of source files and generated graph files, and where changes must be tracked incrementally and efficiently.

The module exposes two primary operations:

- **`detectDrift`** — Analyze the entire graph (or a subtree) for drift.
- **`syncDriftState`** — Update the stored drift state for a single node after materialization or regeneration.

It also includes several internal helpers that support hashing, categorization, and child‑node exclusion logic.

---

## Overview of Drift Concepts

A node’s drift state is determined by comparing:

- **Source files** — Files mapped directly by the node.
- **Graph files** — Files generated under the project’s internal `.yggdrasil/` directory.
- **Stored drift metadata** — Hashes and modification times from the last `drift-sync`.

Drift is categorized into:

| Status | Meaning |
|--------|---------|
| `ok` | No drift detected; stored hash matches current canonical hash. |
| `source-drift` | Only source files changed. |
| `graph-drift` | Only graph files changed. |
| `full-drift` | Both source and graph files changed. |
| `missing` | All source mapping paths are gone. |
| `unmaterialized` | No drift state exists and files are missing. |

The system uses a **child‑wins model**, meaning descendant nodes own their mapping paths and override parent ownership for hashing purposes.

---

# `detectDrift(graph, filterNodePath?)`

Analyze nodes in the graph and produce a `DriftReport`.

## Purpose

`detectDrift` determines which nodes have diverged from their last recorded state. It is optimized to avoid unnecessary hashing by reusing stored mtimes and hashes when possible. It also ensures that missing source files are detected before hash comparison, preventing false positives.

## Behavior Summary

### Node Selection
- If `filterNodePath` is provided, only that node and its descendants are evaluated.
- Nodes without mapping paths are skipped.

### Handling Missing Drift State
If a node has no stored drift entry:
- If all mapping paths are missing → status: **`unmaterialized`**
- If any mapping path exists → status: **`source-drift`** (materialized but never synced)

### Missing Source Files
If all mapping paths are missing, regardless of stored state:
- Status: **`missing`**

### Hashing & File Tracking
- Collects all tracked files (source + graph).
- Excludes mapping paths owned by descendant nodes.
- Uses stored mtimes to skip hashing unchanged files.
- Computes a canonical hash representing the node’s full tracked state.

### Drift Classification
If the canonical hash differs from the stored hash:
- Changed files are identified by comparing stored vs current hashes.
- Each changed file is categorized as `source` or `graph`.
- Drift status is derived from the combination of categories.

### Output
Returns a `DriftReport` containing:
- Per‑node drift entries
- Aggregate counts for each drift category

---

# `syncDriftState(graph, nodePath)`

Synchronize the drift state for a single node after materialization or regeneration.

## Purpose

This function updates the drift metadata for a node by recomputing its canonical hash and storing the resulting file hashes and mtimes. It is typically invoked after a successful build or materialization step.

## Behavior Summary

- Validates that the node exists and has mapping paths.
- Collects tracked files and applies child‑mapping exclusions.
- Reuses stored mtimes/hashes to avoid unnecessary hashing.
- Computes:
  - `canonicalHash` — the node’s full state hash
  - `fileHashes` — per‑file hashes
  - `fileMtimes` — per‑file modification times
- Writes the updated drift state to disk.
- Returns both the previous and current canonical hash.

This allows callers to determine whether the sync represented a meaningful change.

---

# Internal Helpers

## `getChildMappingExclusions(graph, nodePath)`

Identifies mapping paths owned by descendant nodes that overlap with the parent’s mapping.  
These paths are excluded from hashing to enforce the **child‑wins** ownership model.

### Why It Matters
Without this, parent nodes would incorrectly report drift when child nodes legitimately modify files they own.

---

## `categorizeFile(filePath, rootPath, projectRoot)`

Classifies a file as either:

- **`graph`** — if it resides under the project’s internal `.yggdrasil/` directory
- **`source`** — otherwise

This distinction is essential for determining drift type.

---

## `allPathsMissing(projectRoot, mappingPaths)`

Checks whether *all* mapping paths for a node are missing.  
Used to detect `missing` and `unmaterialized` states before hashing.

---

# Usage Patterns

### Detecting Drift for the Entire Graph
```ts
const report = await detectDrift(graph);
console.log(report.entries);
```

### Detecting Drift for a Subtree
```ts
const report = await detectDrift(graph, 'src/components/button');
```

### Synchronizing a Node After Regeneration
```ts
const { previousHash, currentHash } = await syncDriftState(graph, nodePath);
```

### Determining Whether a Node Changed
```ts
if (previousHash !== currentHash) {
  console.log('Node changed since last sync');
}
```

---

# Design Considerations

### Incremental Hashing
The module avoids hashing unchanged files by comparing mtimes with stored values. This significantly improves performance on large graphs.

### Ownership Hierarchy
The child‑wins model ensures deterministic drift detection in nested node structures.

### Conservative Missing‑File Handling
Missing source files always take precedence over hash comparison, preventing misleading “ok” states when files have been removed.

### Canonical Hashing
The canonical hash represents the entire tracked state of a node, ensuring that even subtle changes are detected.

---

If you'd like, I can also generate:

- A high‑level architectural diagram
- Inline JSDoc comments for each function
- A README‑style version of this documentation
- A developer‑onboarding guide explaining how drift detection fits into the larger system