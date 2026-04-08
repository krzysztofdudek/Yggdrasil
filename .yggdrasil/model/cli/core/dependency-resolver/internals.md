# Dependency Resolver Internals

## Decisions

Chose Kahn's algorithm over DFS-based topological sort because it naturally produces parallel stages — nodes with in-degree 0 at each iteration form a stage that can execute concurrently.

Chose to extend changed nodes with only direct dependents (one level) rather than transitive dependents. Transitive expansion would cascade approve through the entire dependency chain, which is the cascade review workflow's job (E021), not change detection's.

Chose to tolerate cycles involving blackbox nodes in resolveDeps. Blackbox nodes are excluded from staged output anyway, and breaking on their cycles would prevent operating on the rest of the graph.
