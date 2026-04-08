# Graph Types Interface

Type library — exports TypeScript interfaces, type aliases, and one constant. No runtime functions.

## Config

- **YggConfig** — Top-level config: name, optional version, node_types, quality, llm, parallel.
- **NodeTypeConfig** — Node type: description, optional required_aspects.
- **QualityConfig** — Thresholds: min_artifact_length, max_direct_relations, max_mapping_source_files, context_budget.
- **LlmConfig** — LLM settings: provider, model, endpoint, api_key, temperature, consensus, max_tokens, verify_artifacts, context_length_field.
- **ArtifactConfig** — Per-artifact: required condition, description, included_in_relations flag.
- **STANDARD_ARTIFACTS** — Constant defining the three hardcoded artifacts (responsibility, interface, internals).

## Architecture

- **ArchitectureDef** — Architecture constraints: node_types record.
- **ArchitectureNodeType** — Type constraints: description, optional aspects/parents/relations.

## Graph Model

- **Graph** — Root container: config, architecture, nodes (Map), aspects, flows, schemas, rootPath. Optional error fields.
- **GraphNode** — Node in model tree: path, meta, nodeYamlRaw, artifacts, children, parent.
- **NodeMeta** — Parsed yg-node.yaml: name, type, description, aspects, ports, blackbox, relations, mapping.
- **Relation** — Typed edge: target, type, consumes, failure, event_name.
- **RelationType** — `'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens'`
- **PortDef** — Named entry point: description, aspects.
- **Artifact** — File content: filename, content.

## Graph Elements

- **AspectDef** — Loaded aspect: name, id, description, implies, artifacts.
- **FlowDef** — Loaded flow: path, name, description, nodes, aspects, artifacts.
- **SchemaDef** — Schema reference: schemaType.

## Other

- **Stage** — Dependency resolution stage: stage number, parallel flag, node paths.
- **OwnerResult** — Owner lookup: file, nodePath, mappingPath, direct.

## Failure Modes

Type library — no runtime errors. Errors occur only at compile time.
