# Model Interface

Type library — exports TypeScript interfaces and types only. No runtime functions. Used by cli/core, cli/io, cli/commands, cli/formatters.

**Config:** YggConfig, ArtifactConfig, QualityConfig, STANDARD_ARTIFACTS (constant)

**Node:** Graph, GraphNode, NodeMeta, NodeAspectEntry, Relation, RelationType, NodeMapping, Artifact

**Graph elements:** AspectDef, FlowDef (includes `path` — directory name under flows/), SchemaDef

**SchemaDef:** `{ schemaType: string }` — inferred from filename stem (node, aspect, flow). Populated by loadSchemas from .yggdrasil/schemas/.

**Context:** ContextPackage, ContextLayer, ContextSection, ContextSectionKey

**Budget:** BudgetBreakdown

**Context Map:** ContextMapOutput, Glossary, GlossaryAspectEntry, GlossaryFlowEntry, NodeAspectRef, FlowRef, AncestorRef, DependencyRef

**Dependency resolution:** Stage

**Validation:** ValidationResult, ValidationIssue, IssueSeverity

**Drift:** DriftReport, DriftEntry, DriftStatus, DriftState, DriftNodeState, TrackedFileLayer

**Owner:** OwnerResult

**RelationType:** `'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens'`

**NodeMapping:** `{ paths: string[] }` — list of paths (files or directories); type is auto-detected at runtime.

**Relation:** target, type, optional consumes, failure, event_name

**Graph:** config, nodes (Map), aspects, flows, schemas, rootPath, optional configError, nodeParseErrors

## Failure Modes

Model is a TypeScript type library — it contains no executable code and does not throw runtime errors. Errors occur only at compile time (TypeScript).

## Data Structures

## Config types

- **YggConfig** — Top-level config: name, optional version, node_types (Record keyed by type name), optional quality thresholds. No longer has an `artifacts` field — artifacts are defined by the STANDARD_ARTIFACTS constant.
- **STANDARD_ARTIFACTS** — `Record<string, ArtifactConfig>` constant defining the three hardcoded artifacts: `responsibility.md` (required: always, included_in_relations: true), `interface.md` (required: when has_incoming_relations, included_in_relations: true), `internals.md` (required: never, included_in_relations: false). Defines the three standard artifacts.
- **NodeTypeConfig** — Node type definition with description (required) and optional required_aspects. Key in the Record is the type name.
- **ArtifactConfig** — Per-artifact config: required condition (always/never/when), description, optional included_in_relations flag.
- **QualityConfig** — Thresholds: min_artifact_length, max_direct_relations, optional max_mapping_source_files (default 10, for W017 wide-node check), context_budget (warning + error).

## Graph types

- **Graph** — Root container: config, nodes (Map by path), aspects, flows, schemas, rootPath. Optional configError and nodeParseErrors.
- **GraphNode** — A node in the model tree: path, meta (NodeMeta), nodeYamlRaw, artifacts, children, parent.
- **NodeAspectEntry** — Unified aspect entry for a node: `{ aspect: string; exceptions?: string[]; anchors?: string[] }`. Each entry links a node to an aspect with optional per-node exceptions and code anchors.
- **NodeMeta** — Parsed yg-node.yaml: name, type, optional description, optional aspects (NodeAspectEntry[]), blackbox, relations, mapping.
- **Relation** — Typed edge: target path, RelationType, optional consumes, failure, event_name.
- **RelationType** — Union: uses | calls | extends | implements | emits | listens.

## Context assembly types

- **ContextPackage** — Assembled context: nodePath, nodeName, layers, sections, mapping, tokenCount.
- **ContextLayer** — Single layer: type (global/hierarchy/own/relational/aspects/flows), label, content, optional attrs.
- **ContextSection** — Grouped layers by key: Global, Hierarchy, OwnArtifacts, Aspects, Relational.

## Context Map types

- **BudgetBreakdown** — Per-category token counts: `{ own: number; hierarchy: number; aspects: number; flows: number; dependencies: number; total: number }`. Used in ContextMapOutput.meta and by validator budget checks.
- **ContextMapOutput** — Top-level structured output: `project` at top, `glossary` (aspects + flows with names/descriptions/files), `node` with inline `files`, `hierarchy` with inline `files`, `dependencies` with inline `files`, and `meta` at bottom with tokenCount, budgetStatus (`'ok' | 'warning' | 'severe'`), and `breakdown` (BudgetBreakdown). No separate ArtifactRegistry — files are inlined in each section.
- **Glossary** — Index of all aspects and flows referenced in the context package: `aspects` and `flows` keyed by id/path, each with name, description, and `files`. Aspects and flows are keyed by id/path.
- **GlossaryAspectEntry** — Aspect glossary entry: name, optional description, optional implies, files.
- **GlossaryFlowEntry** — Flow glossary entry: name, optional description, participants (node paths), optional aspects, files.
- **NodeAspectRef** — Aspect reference on a node: id, optional anchors, optional exceptions.
- **FlowRef** — Flow reference: path, optional aspects list.
- **AncestorRef** — Ancestor node reference: path, name, type, optional description, aspects list, optional `files` (artifact paths).
- **DependencyRef** — Dependency reference: path, name, type, optional description, relation kind, optional consumes/failure/event-name, aspects list, hierarchy chain, optional `files` (artifact paths for included_in_relations artifacts).

## Validation types

- **ValidationResult** — Collection of issues with nodesScanned count.
- **ValidationIssue** — Single issue: severity (error/warning), optional code, rule name, message, optional nodePath.

## Drift types

- **DriftReport** — Full drift scan result: entries, counts by status (ok, source-drift, graph-drift, full-drift, missing, unmaterialized).
- **DriftEntry** — Per-node drift result: nodePath, status, optional changedFiles and details.
- **DriftNodeState** — Stored state per node: canonical hash + per-file hashes (path to SHA-256).
- **DriftState** — Record mapping node paths to DriftNodeState.
- **DriftFileChange** — Per-file change detail: filePath, category (source or graph).
- **TrackedFileLayer** — Type union: `'own' | 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source'`. Indicates which context package layer brought a file into tracking — used by drift classification (E020/E021) to distinguish direct drift (own/source) from cascade drift (hierarchy/aspects/relational/flows).

## Cross-cutting definitions

- **AspectDef** — Loaded aspect: name, id, optional description, optional implies, artifacts.
- **FlowDef** — Loaded flow: path, name, optional description, nodes (participant paths), optional aspects, artifacts.
- **SchemaDef** — Schema reference: schemaType (node/aspect/flow).

## Other types

- **OwnerResult** — Owner lookup result: file path, nodePath (or null), optional mappingPath.
- **Stage** — Dependency resolution stage: stage number, parallel flag, node paths.
