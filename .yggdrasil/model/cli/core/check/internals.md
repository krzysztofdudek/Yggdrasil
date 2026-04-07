# Check Internals

## Decisions

Removed `deterministic` aspect: `classifyDrift` writes to disk when invalidating cached LLM aspect results on drift detection (`writeNodeDriftState` inside the classification loop). This side effect was added intentionally so that stale LLM results don't persist across drift cycles. Rejected: keeping `deterministic` and moving cache invalidation elsewhere — the invalidation belongs at detection time, not at a separate caller.

`suggestedNext` prefers batch approve commands when multiple cascade nodes share the same upstream cause. Groups cascade issues by entity (aspect, flow, parent), picks the largest group with ≥2 nodes, and emits `yg approve --aspect/--flow/--node`. Rejected: always suggesting single-node context command — agents should use batch paths when available.
