# Drift Commands Responsibility

**In scope:** `yg drift` and `yg drift-sync`. Detect and resolve divergence between graph metadata and on-disk source files.

**drift:**

- Load graph via loadGraph(process.cwd()). Scope: --scope option, default "all". Trim whitespace; empty string treated as "all".
- If scope is a node path (not "all"): validate node exists in graph; if not, exit 1 with "Node not found: ${scope}".
- If scope is a node path: validate node has mapping; if not, exit 1 with "Node has no mapping (does not participate in drift detection)".
- Call detectDrift(graph, scopeNode) where scopeNode is undefined when scope is "all".
- Output per entry: status (ok, drift, missing, unmaterialized), nodePath, mappingPaths. Use chalk: green ok, red drift, yellow missing, dim unmaterialized. Include entry.details for drift when present.
- Summary line: driftCount, missingCount, unmaterializedCount, okCount.
- Exit 1 if any drift, missing, or unmaterialized. Exit 0 otherwise.

**drift-sync:**

- Load graph via loadGraph(process.cwd()). Node path: --node (required). Trim and strip trailing slash.
- Call syncDriftState(graph, nodePath). Output "Synchronized: ${nodePath}" (green). Output hash line: previousHash (first 8 chars or "none") -> currentHash (first 8 chars).
- Exit 0 on success.

**Error handling:** try/catch around action; on error write to stderr, process.exit(1).

**Consumes:** loadGraph (cli/core/loader), detectDrift, syncDriftState (cli/core/drift-detector).

**Out of scope:** Validation, journal, graph navigation. Drift state I/O is internal to drift-detector.
