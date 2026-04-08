# Loader Internals

## Decisions

- **Collect node parse errors instead of throwing.** One malformed yg-node.yaml should not prevent loading the rest of the graph. Rejected: fail-fast on first bad node — would make `yg check` unusable when needed most.

- **tolerateInvalidConfig option.** Commands like check need to report config errors alongside other issues rather than failing at config parse. Rejected: always tolerating — non-check commands should fail fast on bad config.
