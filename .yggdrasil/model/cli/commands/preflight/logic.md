# Preflight Command Logic

1. `const cwd = process.cwd()`
2. `loadGraph(cwd)` -> graph
3. `findYggRoot(cwd)` -> yggRoot
4. `readJournal(yggRoot)` -> journal entries
5. Unless `--quick`: `detectDrift(graph)` -> drift report. When `--quick`, skip drift entirely.
6. `validate(graph, 'all')` -> validation result
7. Count: nodes, aspects, flows, mapped paths (via normalizeMappingPaths)
8. Output sections:
   - Journal: clean if 0 entries, else count
   - Drift: clean if 0 drifted, else count
   - Status: `${nodes} nodes, ${aspects} aspects, ${flows} flows, ${mappedPaths} mapped paths`
   - Validation: clean if 0 issues, else `${errors} errors` / `${warnings} warnings` with codes and node paths
9. `hasIssues = journalEntries.length > 0 || driftedCount > 0 || errorCount > 0`
10. `process.exit(hasIssues ? 1 : 0)`
