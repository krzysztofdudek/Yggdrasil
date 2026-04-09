# Context Builder Internals

## Decisions

- **Six layers in fixed order** (global → hierarchy → own → relational → flows → aspects). Most general to most specific. Flows assembled before aspects internally so flow-propagated aspect ids can be collected, then reordered in output. Rejected: dynamic layer ordering — determinism requires fixed sequence.

- **`included_in_relations` flag gates relational inclusion.** Without it, every dependency would include all artifacts, causing excessive token usage. Only responsibility.md and interface.md carry integration-relevant information. Rejected: including all artifacts — budget explosion on nodes with many dependencies.
