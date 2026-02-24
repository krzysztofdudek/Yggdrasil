# Model Interface

Type library — exports TypeScript interfaces and types only. No runtime functions. Used by cli/core, cli/io, cli/commands, cli/formatters.

**Config:** YggConfig, ArtifactConfig, QualityConfig, KnowledgeCategory

**Node:** Graph, GraphNode, NodeMeta, Relation, RelationType, NodeMapping, Artifact

**Graph elements:** AspectDef, FlowDef, KnowledgeItem, SchemaDef

**SchemaDef:** `{ schemaType: string }` — inferred from filename stem (node, aspect, flow, knowledge). Populated by loadSchemas from .yggdrasil/templates/.

**Context:** ContextPackage, ContextLayer, ContextSection, ContextSectionKey

**Dependency resolution:** Stage

**Validation:** ValidationResult, ValidationIssue, IssueSeverity

**Drift:** DriftReport, DriftEntry, DriftStatus, DriftState, DriftNodeState

**Journal:** JournalEntry

**Owner:** OwnerResult

**RelationType:** `'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens'`

**NodeMapping:** `{ paths: string[] }` — list of paths (files or directories); type is auto-detected at runtime.

**Relation:** target, type, optional consumes, failure, event_name

**Graph:** config, nodes (Map), aspects, flows, knowledge, schemas, rootPath, optional configError, nodeParseErrors
