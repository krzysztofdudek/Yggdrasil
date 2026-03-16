Below is comprehensive, purpose‑driven Markdown documentation for the provided module. It avoids restating what the code already makes obvious and instead focuses on intent, behavior, and usage patterns.

---

# Dependency Resolution Module

This module provides utilities for analyzing, filtering, and resolving dependencies between nodes in a graph‑based project model. It supports multiple resolution modes, dependency‑tree generation, change detection via Git, and stage‑based execution ordering.

The functions assume a `Graph` structure where each node contains metadata describing structural and event‑based relations to other nodes.

---

## Overview

The module enables three primary workflows:

1. **Determine which nodes should be processed**  
   Based on:
   - All nodes (`mode: 'all'`)
   - Nodes affected by Git changes (`mode: 'changed'`)
   - A node and its transitive dependencies (`mode: 'node'`)

2. **Analyze dependency relationships**  
   Including:
   - Structural vs. event relations
   - Depth‑limited traversal
   - Cycle detection
   - Dependency tree construction and formatting

3. **Produce execution stages**  
   Nodes are grouped into ordered stages based on dependency in‑degree, allowing parallel execution where possible.

---

## ResolveOptions

```ts
interface ResolveOptions {
  mode: 'all' | 'changed' | 'node';
  nodePath?: string;
  ref?: string;
  depth?: number;
  relationType?: 'structural' | 'event' | 'all';
}
```

### Purpose

Controls how dependency resolution is performed.  
Different modes require different supporting fields:

- **`all`**: No additional fields required.
- **`changed`**: Uses Git to detect modified files; `ref` may override the default `HEAD`.
- **`node`**: Requires `nodePath` and optionally limits traversal depth or relation types.

---

## Change Detection

### `findChangedNodes(graph, ref?)`

Identifies nodes whose backing files have changed relative to a Git reference.  
Key behaviors:

- Only considers files under the graph’s root directory.
- Maps changed files back to node paths by walking up directory segments.
- Expands the result to include **direct structural dependents** (one level only).
- Ignores Git errors by returning an empty set.

This function is designed to catch both direct changes and immediate ripple effects without performing a full transitive analysis.

---

## Dependency Expansion

### `expandWithDependents(graph, changed)`

Given a list of changed nodes, adds **direct structural dependents**.  
This is intentionally shallow: it does not cascade beyond one level.  
Useful for incremental builds where only immediate dependents need reprocessing.

---

## Transitive Dependency Collection

### `collectTransitiveDeps(graph, nodePath)`

Collects a node and all of its **structural** transitive dependencies.  
Equivalent to calling the filtered version with:

```ts
relationType = 'structural'
maxDepth = undefined
```

### `collectTransitiveDepsFiltered(graph, nodePath, maxDepth, relationType)`

A generalized BFS traversal that:

- Includes the starting node.
- Follows only relations matching the provided filter.
- Stops at `maxDepth` if provided.
- Validates that all relation targets exist.
- Avoids revisiting nodes.

This function is the backbone for `mode: 'node'` resolution.

---

## Relation Filtering

### `filterRelationType(relType, filter)`

Determines whether a relation should be included in traversal or tree building.  
Supports:

- Structural relations (`uses`, `calls`, `extends`, `implements`)
- Event relations (`emits`, `listens`)
- Combined (`all`)

---

## Dependency Tree Construction

### `buildDependencyTree(graph, nodePath, options?)`

Builds a structured dependency tree suitable for visualization or further processing.

Key characteristics:

- Produces a forest (array of root children) rather than embedding the root itself.
- Tracks visited nodes per branch to prevent cycles.
- Respects depth and relation‑type filters.
- Marks nodes as `blackbox` when indicated in metadata.

The output is a nested structure of `DepTreeNode` objects.

### `formatDependencyTree(graph, nodePath, options?)`

Renders the dependency tree as a text diagram using ASCII connectors.  
Useful for CLI output or debugging.

Example output:

```
auth/login
├── uses auth/session
└── calls shared/logger
```

---

## Dependency Resolution and Staging

### `resolveDeps(graph, options)`

Produces an ordered list of `Stage` objects representing execution phases.

### Behavior Summary

1. **Select candidate nodes**  
   Based on the chosen mode:
   - `all`: every node
   - `changed`: Git‑changed nodes + direct dependents
   - `node`: transitive dependencies of a specific node

2. **Filter out non‑buildable nodes**  
   Nodes marked as `blackbox` or lacking a `mapping` are excluded.

3. **Validate relations**  
   Ensures all referenced targets exist in the graph.

4. **Compute structural in‑degree**  
   Only structural relations influence stage ordering.

5. **Topological sort with parallelism**  
   - Nodes with zero in‑degree form the first stage.
   - Removing them may unlock additional nodes for the next stage.
   - Each stage indicates whether parallel execution is possible.

6. **Detect cycles**  
   If any nodes remain unprocessed, a circular dependency is reported.

### Example Stage Output

```ts
[
  { stage: 1, parallel: true, nodes: ['shared/logger', 'shared/config'] },
  { stage: 2, parallel: false, nodes: ['auth/session'] },
  { stage: 3, parallel: false, nodes: ['auth/login'] }
]
```

---

## Error Handling

The module throws descriptive errors for:

- Missing nodes
- Missing relation targets
- Circular dependencies
- Invalid traversal paths

These errors are intended to surface modeling issues early.

---

## When to Use Each Mode

| Mode        | Use Case |
|-------------|----------|
| `all`       | Full rebuild or global analysis |
| `changed`   | Incremental rebuild based on Git changes |
| `node`      | Focused rebuild of a node and its dependencies |

---

## Summary

This module provides a robust toolkit for dependency analysis in graph‑modeled systems. It supports incremental workflows, deep dependency inspection, and deterministic execution planning. The design emphasizes correctness, safety, and clarity, ensuring that dependency issues are surfaced early and that execution order is predictable.

If you'd like, I can also generate usage examples, diagrams, or integrate this documentation into a larger project README.