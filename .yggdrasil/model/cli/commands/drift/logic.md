# Drift Commands Logic

## drift command

1. loadGraph(process.cwd())
2. scope = (options.scope ?? 'all').trim() || 'all'
3. If scope !== 'all': validate node exists; validate node has mapping (else exit 1)
4. scopeNode = scope === 'all' ? undefined : scope
5. detectDrift(graph, scopeNode)
6. printReport(report, driftedOnly, limit):
   - Split entries into two sections via classifyForSection():
     - Source section: source-drift, full-drift, missing, unmaterialized (+ ok unless --drifted-only)
     - Graph section: graph-drift, full-drift (+ ok unless --drifted-only)
   - If --limit: slice each section to limit entries. Print truncation notice: "... N more (M total)".
   - For each section: print header, then per entry: status tag + nodePath, then changedFiles filtered by category
   - Summary: source-drift, graph-drift, full-drift, missing, unmaterialized counts. "(N ok hidden)" when --drifted-only, else ok count.
7. Exit 1 if any drift/missing/unmaterialized; else exit 0 (based on full report, not limited view)

## drift-sync command

1. Validate: either --node or --all must be provided. If neither, exit 1.
2. loadGraph(process.cwd())
3. If --all: collect all nodes with non-empty mappings. Sort.
4. If --node: nodePath = trim, strip `./` and trailing `/`. If --recursive: collect nodePath + all descendants. Sort.
5. For each node to sync: skip nodes without mapping (unless explicitly requested without --recursive/--all). Call syncDriftState(graph, np) for each.
6. Output "Synchronized: ${np}" (green), hash line (previous 8 chars -> current 8 chars) per synced node.
7. Exit 0
