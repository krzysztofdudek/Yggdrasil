# Graph Types Responsibility

Core graph model types that define the shape of a loaded Yggdrasil graph. This is the foundational type vocabulary consumed by nearly every CLI subsystem.

**In scope:** Graph, GraphNode, NodeMeta, Relation, RelationType, Artifact, AspectDef, FlowDef, SchemaDef, ArchitectureDef, YggConfig, QualityConfig, LlmConfig, ArtifactConfig, STANDARD_ARTIFACTS, PortDef, Stage, OwnerResult.

**Out of scope:** Context assembly types (cli/model/context), drift/approval types (cli/model/drift), validation types (cli/model/validation). No runtime behavior — types and one constant only.
