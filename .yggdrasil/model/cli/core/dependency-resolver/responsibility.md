# Dependency Resolver Responsibility

Topological sort and change detection for graph nodes. Uses structural relations only (uses, calls, extends, implements). Aligns with invariants/002 (graph as source of truth) and decisions/001 (read-only; uses git diff for change detection).

**In scope:**

- `resolveDeps(graph, options)`: modes `all`|`changed`|`node`. Returns stages (stage number, parallel flag, nodes). Excludes blackbox and unmapped nodes. Validates relation targets exist. Throws on cycles or broken relations.
- `findChangedNodes(graph, ref?)`: git diff for .yggdrasil/; maps changed files to node paths; extends with direct dependents (one level). Returns [] on non-git or execSync failure.
- `collectTransitiveDeps(graph, nodePath)`: transitive structural deps; supports relationType filter via collectTransitiveDepsFiltered.
- `buildDependencyTree(graph, nodePath, options?)`: tree structure for deps; supports depth and relationType filter. Avoids cycles in tree via branch set.
- `formatDependencyTree(graph, nodePath, options?)`: ASCII tree output.
- `ResolveOptions`, `DepTreeNode` interfaces.
- `expandWithDependents`: Internal; adds direct dependents to changed set (one level, no cascade).
- `filterRelationType`: Internal; filters relation types (structural, event, all).
- `collectTransitiveDepsFiltered`: Internal; transitive deps with depth and relationType filter.
- `buildChildren`: Internal; recursive tree builder with cycle avoidance via branch set.

**Out of scope:**

- Drift detection (cli/core/drift-detector)
- Graph loading (cli/core/loader)
