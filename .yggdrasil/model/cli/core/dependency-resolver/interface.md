# Dependency Resolver Interface

## `resolveDeps(graph, options): Promise<Stage[]>`

Returns topological stages for execution. Each `Stage` has `stage` (number), `parallel` (boolean), and `nodes` (string[]). Excludes blackbox and unmapped nodes.

- `options.mode`: `'all'` | `'changed'` | `'node'`
- `options.nodePath`: required when mode is `'node'`
- `options.ref`: git ref for diff, required when mode is `'changed'`
- Throws on cycles or broken relation targets.

## `findChangedNodes(graph, ref?): string[]`

Git diff for `.yggdrasil/`; maps changed files to node paths; extends with direct dependents. Returns `[]` on non-git, execSync failure, or empty diff.

## `collectTransitiveDeps(graph, nodePath): string[]`

Transitive structural dependencies. Throws if node or relation target not found.

## `buildDependencyTree(graph, nodePath, options?): DepTreeNode[]`

Tree structure with cycle avoidance via branch set. Supports `depth` and `relationType` filters. Throws if node not found; skips missing relation targets.

## `formatDependencyTree(graph, nodePath, options?): string`

ASCII tree output. Throws if node not found.

## Failure Modes

- Cycles: `Error("Circular dependency detected involving: ...")`.
- Missing node: `Error("Node not found: ...")`.
- Missing relation target: `Error("Relation target not found: ...")` (resolveDeps, collectTransitiveDeps); silently skipped (buildDependencyTree).
- Non-git repo: `findChangedNodes` returns `[]`, no throw.
