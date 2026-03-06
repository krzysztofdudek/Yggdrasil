## Logic

# Preflight Command Logic

1. `const cwd = process.cwd()`
2. `loadGraph(cwd)` -> graph
3. `findYggRoot(cwd)` -> yggRoot
4. Unless `--quick`: `detectDrift(graph)` -> drift report. When `--quick`, skip drift entirely.
5. `validate(graph, 'all')` -> validation result
6. Count: nodes, aspects, flows, mapped paths (via normalizeMappingPaths)
7. Output sections:
   - Drift: clean if 0 drifted, else count
   - Status: `${nodes} nodes, ${aspects} aspects, ${flows} flows, ${mappedPaths} mapped paths`
   - Validation: clean if 0 issues, else `${errors} errors` / `${warnings} warnings` with codes and node paths
8. `hasIssues = driftedCount > 0 || errorCount > 0`
9. `process.exit(hasIssues ? 1 : 0)`
