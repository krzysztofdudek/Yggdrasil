# Context Builder Interface

**Primary API:**

- `buildContext(graph: Graph, nodePath: string): Promise<ContextPackage>`
  - Parameters: `graph` (Graph), `nodePath` (string).
  - Returns: `ContextPackage` with `nodePath`, `nodeName`, `layers` (ContextLayer[]), `sections` (ContextSection[]), `mapping` (string[] | null), `tokenCount` (number).
  - Throws if node not found or relation target broken.

**Layer builders (exported for tests):**

- `buildGlobalLayer(config: YggConfig): ContextLayer` — project name.
- `buildHierarchyLayer(ancestor: GraphNode, config: YggConfig, graph: Graph): ContextLayer` — filtered by STANDARD_ARTIFACTS; adds attrs.aspects from ancestor aspects + expandAspects.
- `buildOwnLayer(node: GraphNode, config: YggConfig, graphRootPath: string, graph: Graph): Promise<ContextLayer>` — reads yg-node.yaml from disk; uses node.artifacts filtered by STANDARD_ARTIFACTS; adds attrs.aspects from node aspects + expandAspects.
- `buildStructuralRelationLayer(target: GraphNode, relation: Relation): ContextLayer` — prefers included_in_relations artifacts from STANDARD_ARTIFACTS; includes consumes, failure. No longer takes config parameter.
- `buildEventRelationLayer(target: GraphNode, relation: Relation): ContextLayer`
- `buildAspectLayer(aspect: AspectDef, exceptionNote?: string): ContextLayer` — renders aspect content; if `exceptionNote` is provided, appends a warning block: "Exception for this node: {note}". The exception note comes from the aspect entry's `exceptions` field in `node.meta.aspects`, joined with '; '.
- `collectAncestors(node: GraphNode): GraphNode[]` — returns ancestors from parent chain.
- `collectDependencyAncestors(target: GraphNode, config: YggConfig, graph: Graph): DependencyAncestorInfo[]` — returns ancestor chain for a dependency target node. Each entry includes path, name, type, aspects (own aspects expanded via `implies` only — not effective aspects), and artifactFilenames (filtered by `included_in_relations` from STANDARD_ARTIFACTS, falling back to all standard artifacts). Used by `toContextMapOutput` to build the `hierarchy` list inside each `DependencyRef`.
- `buildNodeFiles(node, config, prefix): string[]` — internal helper; returns artifact file paths for a node (all STANDARD_ARTIFACTS files that exist), prefixed with the given path. Used for `node.files` and `hierarchy[].files` in ContextMapOutput.
- `buildDepNodeFiles(node, config, prefix): string[]` — internal helper; returns only `included_in_relations` artifact paths from STANDARD_ARTIFACTS for a dependency node (falling back to all standard artifacts if none marked). Used for `dependencies[].files` and dependency hierarchy `files` in ContextMapOutput.

**Budget analysis:**

- `computeBudgetBreakdown(pkg: ContextPackage, graph: Graph): BudgetBreakdown` — computes per-category token breakdown from a ContextPackage. Categories: own (own layer), hierarchy (hierarchy layers), aspects (aspect layers), flows (flow layers), dependencies (structural + event relation layers plus dependency ancestor artifacts). Returns totals for each category and a grand total.

**Structured output converter:**

- `toContextMapOutput(pkg: ContextPackage, graph: Graph): ContextMapOutput` — converts a layers-based ContextPackage into the structured ContextMapOutput format. Builds a `glossary` (aspects + flows referenced in the package, each with name/description/files via `buildGlossary`), inlines `files` directly into `node`, `hierarchy`, and `dependencies` entries via `buildNodeFiles` and `buildDepNodeFiles` helpers. Budget status uses `'severe'` (not `'error'`) for over-budget. Includes `breakdown: BudgetBreakdown` in meta via `computeBudgetBreakdown`. The `node` section includes:
  - `aspects: NodeAspectRef[]` from `node.meta.aspects` with anchors and exceptions
  - `required_aspects: RequiredAspectRef[]` from node type config
  - `integration_aspects?: RequiredAspectRef[]` from `node.meta.integration_aspects` (if present)

**Types:**

- `BudgetBreakdown` — `{ own: number; hierarchy: number; aspects: number; flows: number; dependencies: number; total: number }` — per-category token counts for a context package.
- `DependencyAncestorInfo` — `{ path: string; name: string; type: string; aspects: string[]; artifactFilenames: string[] }`

**Constants (internal):** `STRUCTURAL_RELATION_TYPES`, `EVENT_RELATION_TYPES`, `YG_YAML_FILES`.

**Imported constant:** `STANDARD_ARTIFACTS` from cli/model — the hardcoded artifact definitions used for filtering throughout. Used for filtering throughout context assembly.

## Failure Modes

- **Node not found**: Throws `Error("Node not found: ${nodePath}")` if nodePath not in graph.nodes.
- **Broken relation**: Throws `Error("Broken relation: ${nodePath} -> ${relation.target} (target not found)")` when structural or event relation target not in graph.
- **buildOwnLayer yg-node.yaml read**: Catches readFile errors; emits `(not found)` in content instead of throwing.
- **Artifact read failure**: Other readFile calls (e.g. in loader-provided artifacts) — not in context-builder; artifacts come pre-loaded.
