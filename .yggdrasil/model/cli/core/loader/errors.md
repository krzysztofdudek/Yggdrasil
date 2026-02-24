# Graph Loader Errors

- **loadGraph**:
  - Throws when model/ is missing (ENOENT): `Error("Directory .yggdrasil/model/ does not exist. Run 'yg init' first.", { cause })`.
  - Config parse failure: propagated unless tolerateInvalidConfig; then FALLBACK_CONFIG used, configError set on Graph.
  - Node parse errors: collected in nodeParseErrors; scan continues (no throw).
- **loadGraphFromRef**: Returns null (no throw) if: not git repo, ref missing (git rev-parse fails), git archive fails. Temp dir cleaned in finally.
