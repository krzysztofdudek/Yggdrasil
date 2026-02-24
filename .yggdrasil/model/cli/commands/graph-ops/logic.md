# Graph-Ops Commands Logic

## status

1. loadGraph, detectDrift, validate
2. Count nodes by type (typeCounts Map); blackboxCount
3. Count relations: structural (uses/calls/extends/implements) vs event
4. Output: Graph name, Nodes (type breakdown + blackbox), Relations, Aspects, Flows, Knowledge, Drift counts, Validation (errors, warnings)
5. Pluralize: 1 module vs 2 modules

## tree

- loadGraph; traverse model/; for each dir with node.yaml output path, type, tags, relations count, blackbox flag

## owner

- loadGraph; for given file path, find node whose mapping contains it (file match, directory contains, or paths includes)

## deps

- loadGraph; formatDependencyTree(nodePath, options); output tree text

## impact

- loadGraph; find reverse dependents (structural relations); if --simulate: loadGraphFromRef(HEAD), detectDrift, for each dependent buildContext, report budget + drift status
