# Context Builder Interface

**Primary API:**

- `buildContext(graph: Graph, nodePath: string): Promise<ContextPackage>`
  - Parameters: `graph` (Graph), `nodePath` (string).
  - Returns: `ContextPackage` with `nodePath`, `nodeName`, `layers` (ContextLayer[]), `sections` (ContextSection[]), `mapping` (string[] | null), `tokenCount` (number).
  - Throws if node not found or relation target broken.

**Layer builders (exported for tests):**

- `buildGlobalLayer(config: YggConfig): ContextLayer` — project name, stack, standards.
- `buildHierarchyLayer(ancestor: GraphNode, config: YggConfig, graph: Graph): ContextLayer` — filtered by config.artifacts; adds attrs.aspects from ancestor aspects + expandAspects.
- `buildOwnLayer(node: GraphNode, config: YggConfig, graphRootPath: string, graph: Graph): Promise<ContextLayer>` — reads node.yaml from disk; uses node.artifacts; adds attrs.aspects from node aspects + expandAspects.
- `buildStructuralRelationLayer(target: GraphNode, relation: Relation, config: YggConfig): ContextLayer` — prefers included_in_relations artifacts; includes consumes, failure.
- `buildEventRelationLayer(target: GraphNode, relation: Relation): ContextLayer`
- `buildAspectLayer(aspect: AspectDef, exceptionNote?: string): ContextLayer` — renders aspect content; if aspect has `stability`, appends "Stability tier: ..." line; if `exceptionNote` is provided, appends a warning block: "Exception for this node: {note}". The exception note comes from `node.meta.aspect_exceptions` entries matched by aspect id.
- `collectAncestors(node: GraphNode): GraphNode[]` — returns ancestors from parent chain.

**Constants (internal):** `STRUCTURAL_RELATION_TYPES`, `EVENT_RELATION_TYPES`.

## Failure Modes

- **Node not found**: Throws `Error("Node not found: ${nodePath}")` if nodePath not in graph.nodes.
- **Broken relation**: Throws `Error("Broken relation: ${nodePath} -> ${relation.target} (target not found)")` when structural or event relation target not in graph.
- **buildOwnLayer node.yaml read**: Catches readFile errors; emits `(not found)` in content instead of throwing.
- **Artifact read failure**: Other readFile calls (e.g. in loader-provided artifacts) — not in context-builder; artifacts come pre-loaded.
