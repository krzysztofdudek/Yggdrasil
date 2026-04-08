# Check Command Responsibility

**In scope:** `yg check`. The unified graph gate — the single command agents run to know if the graph is healthy before starting or committing work.

Combines drift detection, structural validation, coverage scanning, and completeness checking into one pass. Groups output by error category so agents can address issues in priority order. The "suggested next" at the end gives one concrete step to resolve the most pressing issue.

Blocks commits and CI when errors exist — this is the enforcement mechanism for the graph-first workflow.

**Out of scope:** Individual check logic (delegated to cli/core/check).
