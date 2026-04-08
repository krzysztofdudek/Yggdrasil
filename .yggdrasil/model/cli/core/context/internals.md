# Context Builder Internals

## Decisions

- **Six layers in fixed order** (global → hierarchy → own → relational → flows → aspects). Most general to most specific — each layer adds precision without repeating previous layers. Flows are assembled before aspects internally so that flow-propagated aspect ids can be collected, then reordered in output to match the spec sequence.

- **`included_in_relations` flag gates relational inclusion.** Without it, every dependency would include all artifacts in the consuming node's context, causing excessive token usage. Only responsibility.md and interface.md carry integration-relevant information for structural relations.

- **Assembly separated from formatting.** `buildContext` produces raw layers; `buildNodeContextData`/`buildFileContextData` transform to structured data for formatters. Rejected: single function doing both — validator needs budget data but should not call output formatter.

- **`computeEffectiveAspects` over `collectEffectiveAspectIds` for structured output.** The structured variant handles ports separately and integrates architecture-level constraints. Falls back to the simpler function when architecture is unavailable.
