# Validator Responsibility

Structural and semantic validation of the graph. Reports issues without modifying anything — read-only by design.

Error categories: structural errors (E001-E013) for broken YAML and graph inconsistencies, completeness errors (E030-E038) for missing or thin artifacts, architecture errors (E050-E053) for broken aspect/port references, and warnings (W001-W005) for quality suggestions.

Only errors represent structurally invalid states. Warnings (budget, fan-out, wide nodes, shallow artifacts) indicate quality concerns but never block build-context. Budget warnings (W005/W006) are informational with per-category breakdown; W015 (own-budget-warning) is the actionable warning directing agents to split nodes.
