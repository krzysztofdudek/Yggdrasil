# Check Internals

## Decisions

- **Cache invalidation at detection time.** `classifyDrift` writes to disk when invalidating cached LLM results on drift detection. Rejected: deferring invalidation to a separate caller — the invalidation must happen at detection time to prevent approve from reusing stale verification.

- **Batch approve in suggestedNext.** When multiple cascade nodes share the same upstream cause, `suggestedNext` suggests a batch approve command (groups by entity, picks largest group). Rejected: always suggesting single-node context command — agents should use batch paths when available.
