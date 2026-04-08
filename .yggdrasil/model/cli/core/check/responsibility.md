# Check Responsibility

The single source of truth for "is this graph healthy?" Orchestrates four operations: `validate()` (structural + completeness), `classifyDrift()` (direct E020 + cascade E021 in one pass), `scanUncoveredFiles()` (coverage E022), and `detectOrphanedDriftState()` (cleanup). These are run together because they share graph state and cascade classification depends on drift results.

When drift is detected and cached LLM verification results exist, check invalidates stale cache entries to prevent approve from reusing verification computed against a different source state.
