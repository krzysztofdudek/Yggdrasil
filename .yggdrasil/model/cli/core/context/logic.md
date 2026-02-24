# Context Builder Logic

10-step deterministic assembly. Order is fixed; each step appends layers.

## Sequence

1. **Global** — config.yaml: stack, standards
2. **Knowledge (2–5)** — collectKnowledgeItems: global scope → tag match → node scope → node-declared. Deduplication via `seenKnowledge` Set.
3. **Hierarchy (6)** — collectAncestors from node.parent up to root; for each ancestor, filter artifacts by config, build hierarchy layer
4. **Own (7)** — node.yaml (read from disk) + filtered artifacts
5. **Relational (8)** — for each relation: structural (uses/calls/extends/implements) → buildStructuralRelationLayer (consumes, failure, structural_context artifacts); event (emits/listens) → buildEventRelationLayer
6. **Aspects (9)** — for each node tag, find matching aspect by aspect.tag, build aspect layer
7. **Flows (10)** — flows where node in flow.nodes; for each flow: flow artifacts + flow.knowledge (deduplicated with seenKnowledge)

## Deduplication

- Knowledge: `seenKnowledge` Set ensures each knowledge element appears at most once
- Flow knowledge: checked against `seenKnowledge` before adding

## Output

- `layers`: array of ContextLayer
- `sections`: grouped by key (Global, Knowledge, Hierarchy, OwnArtifacts, Dependencies, Aspects, Flows)
- `tokenCount`: estimateTokens(fullText) — ~4 chars per token
- `mapping`: if node has mapping, add "Materialization Target" to own layers

## Structural vs Event Relations

- STRUCTURAL_RELATION_TYPES: uses, calls, extends, implements
- EVENT_RELATION_TYPES: emits, listens

Structural relations get interface/errors from target (structural_context). Event relations get event name + consumes.
