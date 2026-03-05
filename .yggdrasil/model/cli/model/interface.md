# Model Interface

Type library — exports TypeScript interfaces and types only. No runtime functions. Used by cli/core, cli/io, cli/commands, cli/formatters.

**Config:** YggConfig, ArtifactConfig, QualityConfig

**Node:** Graph, GraphNode, NodeMeta, Relation, RelationType, NodeMapping, Artifact, AspectException

**Graph elements:** AspectDef, AspectStability, FlowDef (includes `path` — directory name under flows/), SchemaDef

**SchemaDef:** `{ schemaType: string }` — inferred from filename stem (node, aspect, flow). Populated by loadSchemas from .yggdrasil/schemas/.

**Context:** ContextPackage, ContextLayer, ContextSection, ContextSectionKey

**Dependency resolution:** Stage

**Validation:** ValidationResult, ValidationIssue, IssueSeverity

**Drift:** DriftReport, DriftEntry, DriftStatus, DriftState, DriftNodeState

**Journal:** JournalEntry

**Owner:** OwnerResult

**RelationType:** `'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens'`

**NodeMapping:** `{ paths: string[] }` — list of paths (files or directories); type is auto-detected at runtime.

**Relation:** target, type, optional consumes, failure, event_name

**Graph:** config, nodes (Map), aspects, flows, schemas, rootPath, optional configError, nodeParseErrors

## Failure Modes

Model is a TypeScript type library — it contains no executable code and does not throw runtime errors. Errors occur only at compile time (TypeScript).

## Data Structures

## Config types

- **YggConfig** — Top-level config: name, stack, standards, node_types, artifacts, optional quality thresholds.
- **NodeTypeConfig** — Node type definition with name and optional required_aspects.
- **ArtifactConfig** — Per-artifact config: required condition (always/never/when), description, optional included_in_relations flag.
- **QualityConfig** — Thresholds: min_artifact_length, max_direct_relations, context_budget (warning + error).

## Graph types

- **Graph** — Root container: config, nodes (Map by path), aspects, flows, schemas, rootPath. Optional configError and nodeParseErrors.
- **GraphNode** — A node in the model tree: path, meta (NodeMeta), nodeYamlRaw, artifacts, children, parent.
- **AspectException** — Exception to an aspect for a specific node: `{ aspect: string; note: string }`. Referenced by `NodeMeta.aspect_exceptions`.
- **NodeMeta** — Parsed node.yaml: name, type, optional aspects, aspect_exceptions, blackbox, relations, mapping, optional anchors (Record mapping aspect id to list of code pattern strings).
- **Relation** — Typed edge: target path, RelationType, optional consumes, failure, event_name.
- **RelationType** — Union: uses | calls | extends | implements | emits | listens.

## Context assembly types

- **ContextPackage** — Assembled context: nodePath, nodeName, layers, sections, mapping, tokenCount.
- **ContextLayer** — Single layer: type (global/hierarchy/own/relational/aspects/flows), label, content, optional attrs.
- **ContextSection** — Grouped layers by key: Global, Hierarchy, OwnArtifacts, Aspects, Relational.

## Validation types

- **ValidationResult** — Collection of issues with nodesScanned count.
- **ValidationIssue** — Single issue: severity (error/warning), optional code, rule name, message, optional nodePath.

## Drift types

- **DriftReport** — Full drift scan result: entries, counts by status (ok, source-drift, graph-drift, full-drift, missing, unmaterialized).
- **DriftEntry** — Per-node drift result: nodePath, status, optional changedFiles and details.
- **DriftNodeState** — Stored state per node: canonical hash + per-file hashes (path to SHA-256).
- **DriftState** — Record mapping node paths to DriftNodeState.
- **DriftFileChange** — Per-file change detail: filePath, category (source or graph).

## Cross-cutting definitions

- **AspectStability** — Type union: `'schema' | 'protocol' | 'implementation'`. Indicates how stable an aspect's claims are expected to be. Schema = enforced by data model (most stable). Protocol = contractual pattern. Implementation = specific mechanism (least stable).
- **AspectDef** — Loaded aspect: name, id, optional description, optional implies, optional stability (AspectStability), artifacts.
- **FlowDef** — Loaded flow: path, name, nodes (participant paths), optional aspects, artifacts.
- **SchemaDef** — Schema reference: schemaType (node/aspect/flow).

## Other types

- **JournalEntry** — Journal record: ISO timestamp (at), optional target node path, note text.
- **OwnerResult** — Owner lookup result: file path, nodePath (or null), optional mappingPath.
- **Stage** — Dependency resolution stage: stage number, parallel flag, node paths.
