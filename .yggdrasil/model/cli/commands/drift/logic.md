# Drift Commands Logic

## drift command

1. loadGraph(process.cwd())
2. scope = (options.scope ?? 'all').trim() || 'all'
3. If scope !== 'all': validate node exists; validate node has mapping (else exit 1)
4. scopeNode = scope === 'all' ? undefined : scope
5. detectDrift(graph, scopeNode)
6. Output per entry: status (ok/drift/missing/unmaterialized), nodePath, mappingPaths; chalk colors
7. Summary line: driftCount, missingCount, unmaterializedCount, okCount
8. Exit 1 if any drift/missing/unmaterialized; else exit 0

## drift-sync command

1. loadGraph(process.cwd())
2. nodePath = --node (required), trim, strip trailing slash
3. syncDriftState(graph, nodePath)
4. Output "Synchronized: ${nodePath}" (green), hash line (previous 8 chars -> current 8 chars)
5. Exit 0
