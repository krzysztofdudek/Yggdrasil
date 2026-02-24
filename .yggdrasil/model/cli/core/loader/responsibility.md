# Graph Loader Responsibility

Loads the graph from `.yggdrasil/` — model nodes, aspects, flows, knowledge, schemas. Implements invariants/002 (graph as intended truth source). Git integration for loading graph from a ref.

**In scope:**

- **loadGraph(projectRoot, options?)**: Find .yggdrasil via findYggRoot; parse config (FALLBACK_CONFIG on failure if tolerateInvalidConfig); scan model/ recursively for node.yaml; load aspects/, flows/, knowledge/ (by config.knowledge_categories), templates/ (schemas). Returns Graph with rootPath, nodes, aspects, flows, knowledge, schemas, config, configError, nodeParseErrors. Node parse errors collected in nodeParseErrors; scan continues.
- **loadGraphFromRef(projectRoot, ref?)**: Extract .yggdrasil from git archive to temp dir via git archive + tar; load graph via loadGraph. Returns null if not git repo, ref missing, or .yggdrasil not in ref. Temp dir cleaned in finally.
- **scanModelDirectory**: Internal recursive scan; skips dirs without node.yaml; reads artifacts via readArtifacts (excludes node.yaml, includes only config.artifacts keys); skips dirs starting with '.'.
- **loadAspects**, **loadFlows**, **loadKnowledge**, **loadSchemas**: Internal; readdir + parse; return [] on ENOENT.
- **toModelPath**: Internal; converts absolute path to model-relative path with forward slashes.

**Out of scope:**

- YAML parsing (cli/io)
- Context building (cli/core/context)
- Validation (cli/core/validator)
