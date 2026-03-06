# Model Responsibility

TypeScript type definitions for the graph and operations on it. Single source of truth for all domain types.

**In scope:**

- **Config:** YggConfig, ArtifactConfig, QualityConfig
- **Node:** GraphNode, NodeMeta, Relation, RelationType, NodeMapping, Artifact
- **Graph elements:** AspectDef, FlowDef, SchemaDef
- **Graph:** Graph (config, nodes, aspects, flows, schemas, rootPath, configError, nodeParseErrors)
- **Context:** ContextPackage, ContextLayer, ContextSection, ContextSectionKey
- **Dependency resolution:** Stage
- **Validation:** ValidationResult, ValidationIssue, IssueSeverity
- **Drift:** DriftReport, DriftEntry, DriftStatus, DriftState, DriftNodeState
- **Owner:** OwnerResult

**Out of scope:**

- Parsing implementation (cli/io)
- Validation logic (cli/core)
- Runtime behavior — types only, no executable code, no thrown errors
