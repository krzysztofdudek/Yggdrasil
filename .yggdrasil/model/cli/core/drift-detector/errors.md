# Drift Detector Errors

- **detectDrift**: `readDriftState` returns empty object on file missing/parse error; no throw. `hashForMapping` propagates read errors (ENOENT, permission denied) — caught as status 'missing', details 'Mapped path(s) do not exist'. `allPathsMissing` uses access() — ENOENT handled per path (returns true only when all paths missing). `diagnoseChangedFiles` catches errors and returns [].
- **syncDriftState**: Throws `Error("Node not found: ${nodePath}")` if node does not exist; throws `Error("Node has no mapping: ${nodePath}")` if node has no mapping. Propagates hashForMapping and writeDriftState errors.
