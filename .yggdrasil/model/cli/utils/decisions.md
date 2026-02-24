# Utils Decisions

**Primitive helpers:** Utils provide low-level operations (paths, hashing, token estimation, git) that multiple modules need. No domain knowledge — just filesystem, crypto, and git primitives. This avoids duplication and keeps core/commands focused on Yggdrasil-specific logic.

**Determinism:** hash* and estimateTokens are deterministic. Drift detection and context budgeting rely on reproducible outputs.
