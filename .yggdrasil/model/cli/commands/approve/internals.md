# Approve Command Internals

## Decisions

- **Batch in CLI layer only.** Core `approveNode` always processes one node. Batch orchestration (parallel semaphore, cause filtering, output formatting) lives in the CLI handler. Rejected: adding batch awareness to core — the core function does one thing well, and batch is presentation logic.

- **Plain batch, no cascade bypass.** Each batch node goes through the same three-axis check and reviewer. Rejected: `cascadeApprove` flag that auto-bypasses Row 4 — added complexity for no semantic benefit. `--reviewed` already serves this purpose.

- **Uniform entity flags.** `--node`/`--aspect`/`--flow` across approve (and other commands). Rejected: single `--path` flag with auto-resolution by directory — uniform flags reduce agent learning curve and eliminate ambiguity.

- **Parent node redirect to batch cascade.** When `--node` targets a parent with no file mappings, redirects to batch cascade approve of all E021 nodes whose drift state key shares the parent's artifact prefix. Rejected: erroring on no-mapping — parent approval is a natural way to express "approve everything under this module." The artifact-prefix matching is a deliberate proxy for "child nodes under this parent."

- **Blackbox nodes skip LLM verification.** Blackbox means "I don't understand the internals" — the LLM cannot meaningfully verify aspects against sealed source. Rejected: running LLM anyway with a warning — would produce unreliable results and waste tokens.

- **LLM results persisted in CLI layer, not core.** Successful LLM verification results are written back to drift state after the three-axis gate passes. The CLI layer owns this write-back because core approve is read-only by design — it detects and reports but never writes. Rejected: adding write responsibility to core approve — would break the detect/sync separation.
