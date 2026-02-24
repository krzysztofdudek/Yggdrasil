# Context Builder Interface

**Primary API:**

- `buildContext(graph: Graph, nodePath: string): Promise<ContextPackage>`
  - Parameters: `graph` (Graph), `nodePath` (string).
  - Returns: `ContextPackage` with `nodePath`, `nodeName`, `layers` (ContextLayer[]), `sections` (ContextSection[]), `mapping` (string[] | null), `tokenCount` (number).
  - Throws if node not found or relation target broken.

**Layer builders (exported for tests):**

- `buildGlobalLayer(config: YggConfig): ContextLayer` — project name, stack, standards.
- `buildKnowledgeLayer(k: KnowledgeItem, fromFlow?: boolean): ContextLayer`
- `buildHierarchyLayer(ancestor: GraphNode, config: YggConfig): ContextLayer` — filtered by config.artifacts.
- `buildOwnLayer(node: GraphNode, config: YggConfig, graphRootPath: string): Promise<ContextLayer>` — reads node.yaml from disk; uses node.artifacts for configured artifacts.
- `buildStructuralRelationLayer(target: GraphNode, relation: Relation, config: YggConfig): ContextLayer` — prefers structural_context artifacts; includes consumes, failure.
- `buildEventRelationLayer(target: GraphNode, relation: Relation): ContextLayer`
- `buildAspectLayer(aspect: AspectDef): ContextLayer`
- `collectAncestors(node: GraphNode): GraphNode[]` — returns ancestors from parent chain.

**Constants (internal):** `STRUCTURAL_RELATION_TYPES`, `EVENT_RELATION_TYPES`.
