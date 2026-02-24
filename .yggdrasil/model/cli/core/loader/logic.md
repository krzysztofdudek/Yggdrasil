# Graph Loader Logic

## loadGraph

1. findYggRoot(projectRoot) → yggRoot
2. parseConfig(config.yaml) — on error: throw or set configError if tolerateInvalidConfig
3. scanModelDirectory(modelDir, modelDir, null, ...) — recursive scan
4. loadAspects(aspectsDir), loadFlows(flowsDir), loadKnowledge(knowledgeDir, categories), loadSchemas(templatesDir)
5. Return Graph with nodes, aspects, flows, knowledge, schemas, rootPath

## scanModelDirectory

- readdir; if no node.yaml and dir !== modelDir → return (skip)
- If has node.yaml: parseNodeYaml, readArtifacts (exclude node.yaml, filter by config.artifacts)
- Build GraphNode with path, meta, artifacts, children, parent
- Recurse into subdirs; each subdir with node.yaml becomes child

## loadKnowledge

- For each category dir: readdir, for each subdir parse knowledge.yaml, read artifacts
- Scope resolution: global | { tags: [...] } | { nodes: [...] }

## loadAspects, loadFlows, loadSchemas

- **Aspects, Flows:** readdir category dir; for each item parse YAML, read artifacts. Flows: nodes list, optional knowledge refs.
- **Schemas:** `loadSchemas(templatesDir)` readdir; for each `.yaml`/`.yml` call `parseSchema` (validates YAML, infers schemaType from filename). Returns `SchemaDef[]`. On missing dir or parse error returns `[]`.
