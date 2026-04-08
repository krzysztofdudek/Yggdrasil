# Check Command Interface

**Command:** `yg check`

**Preconditions:** Must be run from within a repository that contains `.yggdrasil/`. No arguments or options required.

**Consumer contract:**

- **Input:** None beyond current working directory.
- **Output structure:** Header line with graph stats, then error blocks grouped by category (Drift → Cascade → Structural → Architecture → Coverage → Completeness), then warnings, then result line, then `suggestedNext` with a concrete runnable command.
- **Exit codes:** 0 = pass (no errors; warnings may be present). 1 = fail (one or more errors).
- **Error codes:** Stable E0xx identifiers. Agents can match on these programmatically.
- **suggestedNext:** Always present after result. Always a single runnable `yg` command targeting the highest-priority issue.

**Failure modes:** Graph load failure exits 1. Missing git degrades gracefully (coverage check skipped, rest runs).
