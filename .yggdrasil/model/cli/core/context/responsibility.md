# Context Builder Responsibility

Assembles context packages for nodes — the 10-step layer assembly used by `yg build-context`. Implements context reproducibility per invariants/001.

**In scope:**

- **buildContext(graph, nodePath)**: Primary API. Returns ContextPackage with layers, sections, mapping, tokenCount.
- **10-step assembly**: (1) global config, (2–5) knowledge (global, tag, node, declared) with deduplication, (6) hierarchy ancestors, (7) own (node.yaml from disk + configured artifacts from node), (8) relational (structural_context per decisions/002 or fallback), (9) aspects by tag, (10) flows + flow knowledge.
- **Knowledge deduplication**: seenKnowledge set prevents duplicate layers across steps.
- **Token estimation**: ~4 chars/token heuristic via estimateTokens (no tokenizer dependency).
- **Layer builders** (exported for tests): `buildGlobalLayer`, `buildKnowledgeLayer`, `buildHierarchyLayer`, `buildOwnLayer`, `buildStructuralRelationLayer`, `buildEventRelationLayer`, `buildAspectLayer`, `collectAncestors`.
- **filterArtifactsByConfig**: Internal; filters artifacts by config.artifacts keys.
- **buildFlowLayer**: Internal; builds flow layer from FlowDef artifacts.
- **buildSections**: Internal; groups layers into sections (Global, Knowledge, Hierarchy, OwnArtifacts, Dependencies, Aspects, Flows). Adds "Materialization Target" own layer when mapping exists.
- **collectKnowledgeItems**: Internal; collects knowledge by scope (global, tags, nodes, node.meta.knowledge).
- **collectParticipatingFlows**: Internal; returns flows where node is in flow.nodes.
- **Relation type sets**: STRUCTURAL_RELATION_TYPES (uses, calls, extends, implements), EVENT_RELATION_TYPES (emits, listens). Relations not in either set are skipped.

**Out of scope:**

- Graph loading (cli/core/loader)
- Validation (cli/core/validator)
