# Drift Commands Responsibility

**In scope:** `yg drift` and `yg drift-sync`. Detect and resolve divergence between graph metadata and on-disk source files.

**drift:**

- Load graph via loadGraph(process.cwd()). Scope: --scope option, default "all". Trim whitespace; empty string treated as "all".
- If scope is a node path (not "all"): validate node exists in graph; if not, exit 1 with "Node not found: ${scope}".
- If scope is a node path: validate node has mapping; if not, exit 1 with "Node has no mapping: ${scope}".
- Call detectDrift(graph, scopeNode) where scopeNode is undefined when scope is "all".
- Output is split into two sections: "Source drift:" and "Graph drift:".
  - Source drift section shows: source-drift, full-drift, missing, unmaterialized entries. Also ok entries unless --drifted-only.
  - Graph drift section shows: graph-drift, full-drift entries. Also ok entries unless --drifted-only.
  - Under each drifted entry: show changedFiles filtered by section category (source or graph).
- Color coding: red for source-drift/full-drift, magenta for graph-drift, yellow for missing, dim for unmaterialized, green for ok.
- Summary line: source-drift count, graph-drift count, full-drift count, missing count, unmaterialized count. When --drifted-only and okCount > 0: append "(N ok hidden)". Otherwise append ok count.
- Exit 1 if any drift, missing, or unmaterialized. Exit 0 otherwise.
- --drifted-only flag hides ok entries from both sections.
- --limit N: slice each section to N entries. Truncated sections show "... M more (T total)". Exit code still reflects full report.

**drift-sync:**

- Either --node or --all is required. If neither, exit 1 with usage hint.
- Load graph via loadGraph(process.cwd()).
- If --all: collect all nodes with non-empty mappings. Sort alphabetically.
- If --node: Trim and strip trailing slash. If --recursive: collect the target node plus all descendant nodes (paths starting with nodePath + '/'). Sort alphabetically.
- Nodes without mapping are skipped silently (unless it is the explicitly requested node without --recursive/--all, in which case syncDriftState throws).
- Call syncDriftState(graph, np) for each collected node. Output "Synchronized: ${np}" (green). Output hash line: previousHash (first 8 chars or "none") -> currentHash (first 8 chars).
- Exit 0 on success.

**Error handling:** try/catch around action; on error write to stderr, process.exit(1).

**Consumes:** loadGraph (cli/core/loader), detectDrift, syncDriftState (cli/core/drift-detector).

**Out of scope:** Validation, journal, graph navigation. Drift state I/O is internal to drift-detector.
