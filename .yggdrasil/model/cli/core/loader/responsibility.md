# Graph Loader Responsibility

Loads the graph from `.yggdrasil/` — model nodes, aspects, flows, schemas. Implements invariants/002 (graph as intended truth source). Git integration for loading graph from a ref.

**In scope:**

- **loadGraph(projectRoot, options?)**: Find .yggdrasil via findYggRoot; parse config (FALLBACK_CONFIG on failure if tolerateInvalidConfig); scan model/ recursively for yg-node.yaml; load aspects/, flows/, schemas/. Returns Graph with rootPath, nodes, aspects, flows, schemas, config, configError, nodeParseErrors. Node parse errors collected in nodeParseErrors; scan continues.
- **loadGraphFromRef(projectRoot, ref?)**: Extract .yggdrasil from git archive to temp dir via git archive + tar; load graph via loadGraph. Returns null if not git repo, ref missing, or .yggdrasil not in ref. Temp dir cleaned in finally.
- **scanModelDirectory**: Internal recursive scan; skips dirs without yg-node.yaml; reads artifacts via readArtifacts (excludes yg-node.yaml, includes only STANDARD_ARTIFACTS keys); skips dirs starting with '.'.
- **loadAspects**, **loadSchemas**: Internal; readdir + parse; return [] on ENOENT.
- **loadFlows**: Internal; readdir + parse; return [] only on missing flows/ dir; parse errors in individual flows propagate.
- **toModelPath**: Internal; converts absolute path to model-relative path with forward slashes.
