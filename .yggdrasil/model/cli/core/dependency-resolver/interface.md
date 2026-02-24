# Dependency Resolver Interface

**Types:**

- `ResolveOptions`: `mode` ('all'|'changed'|'node'), `nodePath?` (required when mode==='node'), `ref?` (git ref, default HEAD), `depth?`, `relationType?` ('structural'|'event'|'all')
- `DepTreeNode`: `nodePath`, `relationType`, `relationTarget?`, `blackbox`, `children: DepTreeNode[]`
- `Stage`: `stage` (number), `parallel` (boolean), `nodes` (string[])

**Primary API:**

- `resolveDeps(graph: Graph, options: ResolveOptions): Promise<Stage[]>`
  - Returns stages for topological execution. Excludes blackbox and unmapped nodes. Throws on cycles or broken relations.

- `findChangedNodes(graph: Graph, ref?: string): string[]`
  - Synchronous. Git diff for .yggdrasil/; maps file paths to node paths; extends with direct dependents. Returns [] on non-git, execSync failure, or empty diff.

- `collectTransitiveDeps(graph: Graph, nodePath: string): string[]`
  - Transitive structural dependencies (relationType: structural). Throws if node or relation target not found.

- `buildDependencyTree(graph: Graph, nodePath: string, options?: { depth?: number; relationType?: 'structural'|'event'|'all' }): DepTreeNode[]`
  - Tree structure; avoids cycles via branch set. Throws if node not found. Skips relation targets not in graph (no throw).

- `formatDependencyTree(graph: Graph, nodePath: string, options?: { depth?: number; relationType?: 'structural'|'event'|'all' }): string`
  - ASCII tree output. Throws if node not found.
