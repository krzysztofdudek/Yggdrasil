# Check Responsibility

The single source of truth for "is this graph healthy?" Orchestrates four operations: `validate()` (structural + completeness), `classifyDrift()` (direct E020 + cascade E021 in one pass), `scanUncoveredFiles()` (coverage E022), and `detectOrphanedDriftState()` (cleanup). These are run together because they share graph state: cascade drift (E021) and direct drift (E020) both emerge from the same hash pass — neither depends on the other's output. They share the pass because recomputing hashes twice would be wasteful.

`suggestedNext` priority ordering: E020 (direct drift) > E021 (cascade) > structural > coverage > completeness. Drift is prioritized because it blocks approve, which blocks all semantic verification.

When drift is detected and cached LLM verification results exist, check invalidates stale cache entries to prevent approve from reusing verification computed against a different source state.
