# Approve Command Internals

## Decisions

- **Batch in CLI layer only.** Core `approveNode` always processes one node. Batch orchestration (parallel semaphore, cause filtering, output formatting) lives in the CLI handler. Rejected: adding batch awareness to core — the core function does one thing well, and batch is presentation logic.

- **Plain batch, no cascade bypass.** Each batch node goes through the same three-axis check and reviewer. Rejected: `cascadeApprove` flag that auto-bypasses Row 4 — added complexity for no semantic benefit. `--reviewed` already serves this purpose.

- **Uniform entity flags.** `--node`/`--aspect`/`--flow` across approve (and other commands). Rejected: single `--path` flag with auto-resolution by directory — uniform flags reduce agent learning curve and eliminate ambiguity.
