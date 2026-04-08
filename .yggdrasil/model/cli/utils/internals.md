# Utils Internals

## Decisions

- **Hierarchical gitignore stack over single-root.** Directory hashing walks nested `.gitignore` files and maintains a stack of matchers. Rejected: root-only gitignore — loses precision in monorepos where subdirectories have their own ignores. The stack approach matches git's actual behavior.

- **SHA-256 for all hashing.** Drift detection needs collision-resistant hashes. SHA-256 is deterministic, fast enough for file-level use, and available in Node crypto. No reason to use weaker alternatives.

- **Token estimation as fixed heuristic (~4 chars/token).** Rejected: tiktoken or model-specific tokenizer — adds a dependency for marginal accuracy improvement. Budget thresholds are warnings, not hard limits, so approximate counting is acceptable.

- **getLastCommitTimestamp returns null instead of throwing.** Git may not be available (CI containers, non-git repos). Callers need graceful degradation, not try/catch everywhere.
