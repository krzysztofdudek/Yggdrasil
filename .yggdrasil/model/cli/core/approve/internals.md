# Approve Internals

## Decisions

- **Three-axis gate separated from LLM reviewer.** `--reviewed` bypasses only the structural gate. Rejected: single `--acknowledge` flag that bypasses both — agents used it to rubber-stamp aspect failures instead of fixing code.

- **Child-wins over parent-wins for mapping overlap.** When a child node maps files that are also under a parent's directory mapping, the child's mapping takes precedence — parent's hash computation excludes child-mapped paths. Rejected: parent-wins (child file changes would trigger drift on parent, making parent approval noisy) and flat model (no overlap allowed — too restrictive for real hierarchies).
