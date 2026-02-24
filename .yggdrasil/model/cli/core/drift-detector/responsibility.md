# Drift Detector Responsibility

Compares current file hashes with .drift-state. States: ok, drift, missing, unmaterialized. Implements invariants/002 (graph vs files; drift visible and resolvable).

**In scope:**

- `detectDrift(graph, filterNodePath?)`: for each mapped node (or single node if filterNodePath), compute current hash vs stored; return DriftReport with entries (nodePath, mappingPaths, status, details), totalChecked, okCount, driftCount, missingCount, unmaterializedCount.
- `syncDriftState(graph, nodePath)`: compute hash, write entry (hash + per-file hashes) to .drift-state for node. Returns { previousHash?, currentHash }.
- Hash strategy: delegated to cli/utils (hashForMapping, perFileHashes) — file = SHA-256; directory = SHA-256 of sorted (path, hash) pairs; .gitignore excluded.
- State logic: unmaterialized when no stored entry and all mapping paths missing; drift when hash mismatch; missing when hashForMapping throws (paths don't exist); ok when hash matches.
- `diagnoseChangedFiles`: Internal; compares perFileHashes with stored; returns list of changed/deleted paths.
- `allPathsMissing`: Internal; uses access() per path; returns true only when all paths missing.

**Out of scope:**

- Drift state storage (cli/io)
- Dependency resolution (cli/core/dependency-resolver)
