## Logic

# Context Builder Logic

5-step deterministic assembly. Order is fixed; each step appends layers.

## Sequence

1. **Global** — config.yaml: project name
2. **Hierarchy** — collectAncestors from node.parent up to root; for each ancestor, filter artifacts by config, build hierarchy layer
3. **Own** — node.yaml (read from disk) + filtered artifacts
4. **Relational** — for each relation: structural (uses/calls/extends/implements) → buildStructuralRelationLayer (consumes, failure, included_in_relations artifacts); event (emits/listens) → buildEventRelationLayer
5. **Flows** — flows where node or ancestor in flow.nodes; for each flow: flow artifacts
6. **Aspects** — union of aspect ids from hierarchy + own + flow layers (expanded via implies); for each resolved aspect, look up the matching entry in `node.meta.aspects` and join its `exceptions` array (if any) to pass as exception note to `buildAspectLayer`

Implementation note: steps 4–5 execute before step 6 internally so that flow-propagated aspect ids can be collected. buildSections reorders the output to match the spec: Global → Hierarchy → OwnArtifacts → Aspects → Relational (which merges structural deps, events, and flows).

## Output

- `layers`: array of ContextLayer
- `sections`: grouped by key (Global, Hierarchy, OwnArtifacts, Aspects, Relational). Relational merges structural dependencies, events, and flows.
- `tokenCount`: estimateTokens(fullText) — ~4 chars per token
- `mapping`: if node has mapping, add "Materialization Target" to own layers

## Structural vs Event Relations

- STRUCTURAL_RELATION_TYPES: uses, calls, extends, implements
- EVENT_RELATION_TYPES: emits, listens

Structural relations get interface/errors from target (included_in_relations). Event relations get event name + consumes.

## Aspect Exceptions

When building aspect layers, the builder looks up each resolved aspect in `node.meta.aspects` by matching `entry.aspect === aspect.id`. If found and the entry has `exceptions`, they are joined with '; ' and passed to `buildAspectLayer` as the exception note, which appends it as a warning block. This prevents aspect generalizations from masking node-specific deviations.

`buildAspectLayer` also includes aspect metadata in the output when present: stability tier (from `aspect.stability`) as a "Stability tier" line. This appears after the artifact content and before the exception note. Code anchors live in `node.yaml` embedded in aspect entries (`anchors` field) and are validated by `cli/core/validator` (W014) rather than included in context output.

## Constraints

# Context Builder Constraints

- **Layer assembly order is fixed:** The 5-layer sequence is: (1) Global config, (2) Hierarchy ancestors root-to-parent, (3) Own node artifacts, (4) Relational dependencies and events, (5) Flows then Aspects. This order is invariant and determines context precedence.
- **included_in_relations gates relational inclusion:** For structural relations (uses, calls, extends, implements), only artifacts marked `included_in_relations: true` in config are included from the dependency target. If no structural artifacts exist, all configured artifacts fall back.
- **Context assembly is read-only:** `buildContext` never modifies the graph, node artifacts, or any files. It reads the in-memory graph and node artifact files, then assembles a `ContextPackage`.
- **Aspect expansion detects cycles:** The `expandAspects` function tracks a recursion stack and throws if an aspect implies cycle is detected (e.g., A implies B implies A).
- **Flow participation is transitive through hierarchy:** A node participates in a flow if the node itself or any of its ancestors is listed in the flow's `nodes` array.

## Decisions

# Context Builder Decisions

**Five layers in that specific order:** The assembly proceeds from most general (global config: project name) to most specific (relational context for direct dependencies). Each layer adds precision without repeating the previous. Global sets the project frame, hierarchy provides domain context, own artifacts define the node itself, relational context describes integration points, and aspects add cross-cutting requirements.

**included_in_relations flag gates relational inclusion:** Without this flag, every dependency would include all its artifacts in the consuming node's context, causing excessive token usage. The flag allows config.yaml to declare which artifacts (e.g., interface.md, errors.md) carry the integration-relevant information. Only those are included for structural relations. If no structural artifacts exist on the target, all configured artifacts are included as fallback.
