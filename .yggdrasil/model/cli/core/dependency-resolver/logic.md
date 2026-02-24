# Dependency Resolver Logic

## findChangedNodes

1. git diff --name-only ${ref} -- .yggdrasil/ → list of changed file paths
2. Map file paths to node paths: strip ".yggdrasil/", walk from model/ down; for each path segment, check if graph.nodes.has(candidate)
3. expandWithDependents: build reverse graph (target → dependents); add direct dependents of changed nodes to result

## collectTransitiveDepsFiltered

- BFS from nodePath: queue of { path, depth }
- For each node: follow relations (filtered by relationType: structural | event | all)
- Skip if already in result; respect maxDepth
- Return unique list

## buildDependencyTree

- Recursive: from nodePath, for each relation (filtered), build child DepTreeNode
- branch Set prevents cycles (same node in path)
- children built recursively with depth+1

## resolveDeps (topological sort)

1. **Candidate selection** by mode:
   - all: all nodes
   - changed: findChangedNodes
   - node: collectTransitiveDeps

2. **Filter**: non-blackbox, has mapping

3. **Build in-degree**:
   - For structural relations only, count incoming deps within candidateSet
   - dependents map: target → [dependents]

4. **Kahn's algorithm**:
   - Queue = nodes with inDegree 0
   - Stage 1: process queue; for each, decrement inDegree of dependents; add new zeros to next queue
   - Stage N: repeat until queue empty
   - If processed.size < candidatePaths.length → cycle detected, throw

## filterRelationType

- all: include all
- structural: uses, calls, extends, implements
- event: emits, listens
