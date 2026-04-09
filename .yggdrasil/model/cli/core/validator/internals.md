# Validator Internals

## Decisions

- **Stable error codes as machine-readable identifiers.** CI and automation match on codes, not message text. Rejected: human-readable-only messages — breaks automation.

- **Separate budget warnings W001 (overall) from W002 (own-node).** Agents need different responses: W001 may be caused by dependencies, W002 requires splitting the node itself. Rejected: single code — agents deleted artifact content instead of splitting nodes.

- **Consolidate dangling aspect references into E050.** One code for "aspect doesn't exist" regardless of where referenced. Rejected: separate codes per location — same fix, unnecessary complexity.

- **Remove regex proof system (E037/E040/E041).** Replaced by LLM-based aspect verification at approve time (E055). Rejected: keeping regex — too brittle for semantic compliance checking.

- **Tolerate cycles involving blackbox nodes in E008.** Blackbox nodes are opaque. Rejected: breaking on blackbox cycles — prevents validating the rest of the graph.

- **E053 per-consumed-port validation.** Structural only — if node A consumes port X and port X requires aspect Y, Y must exist in aspects/. Semantic check happens at approve via E055. Rejected: semantic validation at check time — too expensive without LLM.
