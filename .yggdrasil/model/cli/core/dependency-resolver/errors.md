# Dependency Resolver Errors

- **resolveDeps**:
  - `Error("Relation target not found: ${target}")` when relation target not in graph (during candidate validation or collectTransitiveDeps for mode node).
  - `Error("Circular dependency detected involving: ${cycleNodes.join(', ')}")` when structural relations form a cycle among non-blackbox nodes.
  - When mode==='node', `collectTransitiveDeps` throws if nodePath not in graph.
- **findChangedNodes**: Returns [] on non-git repo, execSync failure, or empty diff. No throw.
- **collectTransitiveDeps**, **buildDependencyTree**, **formatDependencyTree**: `Error("Node not found: ${nodePath}")` when node does not exist; `Error("Relation target not found: ${rel.target}")` when relation target missing (collectTransitiveDepsFiltered, buildChildren). buildDependencyTree skips missing targets (no throw) when building tree children.
