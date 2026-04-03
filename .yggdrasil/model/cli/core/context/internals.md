## Logic

# Context Builder Logic

5-step deterministic assembly. Order is fixed; each step appends layers.

## Sequence

1. **Global** — yg-config.yaml: project name
2. **Hierarchy** — collectAncestors from node.parent up to root; for each ancestor, filter artifacts by STANDARD_ARTIFACTS via `filterByStandardArtifacts`, build hierarchy layer
3. **Own** — yg-node.yaml (read from disk) + artifacts filtered by STANDARD_ARTIFACTS
4. **Relational** — for each relation: structural (uses/calls/extends/implements) → buildStructuralRelationLayer (consumes, failure, included_in_relations artifacts); event (emits/listens) → buildEventRelationLayer. In YAML map output (toContextMapOutput), each dependency additionally includes: (a) its full ancestor hierarchy via collectDependencyAncestors (root to parent, with their aspects and included_in_relations artifacts), and (b) its effective aspects via collectEffectiveAspectIds (own + ancestors + flow-propagated + implies-expanded)
5. **Flows** — flows where node or ancestor in flow.nodes; for each flow: flow artifacts
6. **Aspects** — union of aspect ids from hierarchy + own + flow layers (expanded via implies); for each resolved aspect, look up the matching entry in `node.meta.aspects` and join its `exceptions` array (if any) to pass as exception note to `buildAspectLayer`

Implementation note: steps 4–5 execute before step 6 internally so that flow-propagated aspect ids can be collected. buildSections reorders the output: Global → Hierarchy → OwnArtifacts → Aspects → Relational (which merges structural deps, events, and flows).

## Output

- `layers`: array of ContextLayer
- `sections`: grouped by key (Global, Hierarchy, OwnArtifacts, Aspects, Relational). Relational merges structural dependencies, events, and flows.
- `tokenCount`: estimateTokens(fullText) — ~4 chars per token
- `mapping`: if node has mapping, add "Materialization Target" to own layers

## Structural vs Event Relations

- STRUCTURAL_RELATION_TYPES: uses, calls, extends, implements
- EVENT_RELATION_TYPES: emits, listens

Structural relations get interface/errors from target (included_in_relations). Event relations get event name + consumes.

## Dependency Hierarchy in YAML Map Output

`toContextMapOutput` enriches each dependency beyond what raw layers contain. For each structural/event dependency target:

1. **collectDependencyAncestors(target)** — walks target's parent chain from root to parent. Each ancestor entry includes: path, name, type, own aspects (expanded via implies), and artifactFilenames (filtered by included_in_relations from STANDARD_ARTIFACTS, falling back to all standard artifacts). Ancestor artifacts are registered in the artifact registry for agent reading.
2. **collectEffectiveAspectIds(graph, targetPath)** — computes the full set of aspects effective on the dependency: own aspects + ancestor aspects + flow-propagated aspects, all expanded via implies. This set appears in the dependency's `aspects` field in the YAML output.

This means a node's context package includes not just the dependency's own artifacts, but its full positional context in the graph — the agent understands WHERE the dependency sits and WHAT cross-cutting requirements apply to it.

## Aspect Exceptions

When building aspect layers, the builder looks up each resolved aspect in `node.meta.aspects` by matching `entry.aspect === aspect.id`. If found and the entry has `exceptions`, they are joined with '; ' and passed to `buildAspectLayer` as the exception note, which appends it as a warning block. This prevents aspect generalizations from masking node-specific deviations.

Code anchors live in `yg-node.yaml` embedded in aspect entries (`anchors` field) and are validated by `cli/core/validator` (W014) rather than included in context output.

## Budget Breakdown Computation

`computeBudgetBreakdown` categorizes tokens from `pkg.layers` by layer type:

- `own` — layers with type `'own'`
- `hierarchy` — layers with type `'hierarchy'`
- `aspects` — layers with type `'aspects'`
- `flows` — layers with type `'flows'`
- `dependencies` — layers with type `'relational'` (structural + event relations)

Each layer's content is measured via `estimateTokens`. Additionally, dependency ancestor artifacts are included in the `dependencies` category: for each structural relation, `collectDependencyAncestors` provides ancestor nodes with their artifact filenames, and the function reads those artifact files and adds their token cost. The `global` layer is not categorized separately — it contributes negligible tokens. The `total` field is the sum of all categories.

## Constraints

# Context Builder Constraints

- **Layer assembly order is fixed:** The 5-layer sequence is: (1) Global config, (2) Hierarchy ancestors root-to-parent, (3) Own node artifacts, (4) Relational dependencies and events, (5) Flows then Aspects. This order is invariant and determines context precedence.
- **included_in_relations gates relational inclusion:** For structural relations (uses, calls, extends, implements), only artifacts marked `included_in_relations: true` in STANDARD_ARTIFACTS are included from the dependency target. If no structural artifacts exist, all standard artifacts fall back.
- **Context assembly is read-only:** `buildContext` never modifies the graph, node artifacts, or any files. It reads the in-memory graph and node artifact files, then assembles a `ContextPackage`.
- **Aspect expansion detects cycles:** The `expandAspects` function tracks a recursion stack and throws if an aspect implies cycle is detected (e.g., A implies B implies A).
- **Flow participation is transitive through hierarchy:** A node participates in a flow if the node itself or any of its ancestors is listed in the flow's `nodes` array.

## Decisions

# Context Builder Decisions

**Five layers in that specific order:** The assembly proceeds from most general (global config: project name) to most specific (relational context for direct dependencies). Each layer adds precision without repeating the previous. Global sets the project frame, hierarchy provides domain context, own artifacts define the node itself, relational context describes integration points, and aspects add cross-cutting requirements.

**included_in_relations flag gates relational inclusion:** Without this flag, every dependency would include all its artifacts in the consuming node's context, causing excessive token usage. The flag in STANDARD_ARTIFACTS declares which artifacts (responsibility.md, interface.md) carry integration-relevant information. Only those are included for structural relations. If no structural artifacts exist on the target, all standard artifacts are included as fallback.

**toContextMapOutput bridges layers to structured data:** Converts a ContextPackage (layer-based, text-oriented) into a ContextMapOutput (structured data with an artifact registry). The registry maps all referenced files (nodes, aspects, flows) with `model/`, `aspects/`, and `flows/` path prefixes. Dependency nodes get only `included_in_relations` artifacts (no yg-node.yaml), while the target node and its ancestors get all STANDARD_ARTIFACTS that exist. The function computes budget status from config thresholds. This design separates context assembly (buildContext) from output formatting (toContextMapOutput + formatters).

**computeBudgetBreakdown uses raw layers, not artifact registry:** Chose to compute breakdown directly from ContextPackage layers + collectDependencyAncestors over reusing the artifact registry from toContextMapOutput. This avoids a circular dependency — the validator needs breakdown data but should not call toContextMapOutput (which is an output formatter). Operating on raw layers is also more performant since it skips the full structured conversion. Trade-off: dependency ancestor costs are computed independently from toContextMapOutput's ancestor logic, but both use the same collectDependencyAncestors function so results are consistent.

**required_aspects and integration_aspects use computeEffectiveAspects when available:** In toContextMapOutput, when graph.architecture exists, we compute effective aspects (regular and integration) using computeEffectiveAspects, which includes architecture constraints, parent inheritance, own declarations, and flow participation, all with implies expansion. This provides complete aspect coverage. We then map each aspect ID to a human-readable source string (e.g., "architecture (type: service)", "own declaration", "flow 'checkout'"). Chose computeEffectiveAspects over collectEffectiveAspectIds because it handles integration aspects separately and integrates architecture-level constraints. Falls back to collectEffectiveAspectIds (with source "collected from node and flows") when architecture is unavailable, maintaining backward compatibility with test fixtures and old-style graph loads. The source information (in RequiredAspectRef) helps agents understand aspect provenance — architecture constraints vs. flow obligations vs. node extras.
