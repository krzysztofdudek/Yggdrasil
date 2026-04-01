# Impact Command Interface

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerImpactCommand | (program: Command) => void | impact | --node, --file, --aspect, --flow (mutually exclusive, one required) |

**Also exported:**

- `collectReverseDependents(graph: Graph, targetNode: GraphNode): { direct, allDependents, reverse }` — builds reverse dependency map from structural relations.
- `buildTransitiveChains(targetNode, direct, allDependents, reverse): string[][]` — BFS chains excluding target.
- `collectDescendants(graph: Graph, nodePath: string): string[]` — hierarchy children recursively.
- `collectIndirectDependents(graph: Graph, directlyAffected: string[]): { indirectPaths: string[]; chains: string[] }` — given a set of directly affected nodes, finds all structural and event reverse dependents not already in that set. Builds the reverse adjacency map once (structural + emits/listens), then BFS per affected node. When the same node is reachable via multiple affected nodes, keeps the shortest chain. Chain format: `<- indirect <- intermediary <- affected`. Used by `--aspect`, `--flow`, and `--node` modes (for descendant propagation).

**Return:** void for registerImpactCommand. Contract: errors to stderr, process.exit(1) on failure.

**--file flag:** Resolves the owning node via `findOwner`, prints `<file> -> <node>` to stderr, then proceeds as `--node`. Mutually exclusive with `--node`.

**Event-dependent tracking:** In `--node` mode, output includes an "Event-connected" section showing nodes linked via `emits`/`listens` relations to the target node, including event listeners for events the target emits. Event dependents are included in the total scope count.

**Descendant indirect propagation:** In `--node` mode, after collecting descendants, calls `collectIndirectDependents` on descendants to find structural dependents of descendants that are not already shown (target, structural dependents, descendants, event dependents). Output as "Indirectly affected (structural dependents of descendants)" section with chain format matching aspect/flow modes.

## Failure Modes

**Propagated from loadGraph:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`

**Command-specific:**

- Node not found: `Node not found: ${nodePath}` — when --node path does not exist in graph.
- File not mapped (--file): `<file> -> no graph coverage` (exit 1).
- --node and --file together: `'--node' and '--file' are mutually exclusive` (exit 1).
- Aspect not found: `Aspect not found: ${aspectId}` — when --aspect id does not exist.
- Flow not found: `Flow not found: ${flowName}` — when --flow name does not exist.
- Mode validation: `one of --node, --file, --aspect, or --flow is required` — when 0 given. Mutually exclusive when >1 given.

**Generic:** I/O errors — standard Node.js Error, caught and reported to stderr.
