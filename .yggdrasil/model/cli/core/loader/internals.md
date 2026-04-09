# Loader Internals

## Decisions

- **Collect node parse errors instead of throwing.** One malformed yg-node.yaml should not prevent loading the rest of the graph. Rejected: fail-fast on first bad node — would make `yg check` unusable when needed most.

- **tolerateInvalidConfig option.** Commands like check need to report config errors alongside other issues rather than failing at config parse. Rejected: always tolerating — non-check commands should fail fast on bad config.

- **Return empty collections when optional directories (aspects/, flows/) are missing.** A repository without any aspects or flows defined is valid — the directories are optional. Rejected: throw on missing directories — would make `loadGraph` unusable in freshly initialised repositories and break `yg check` before the user has created any aspects or flows.

- **model/ is required; aspects/, flows/, schemas/ are optional.** The model directory is the core of the graph — without it, there are no nodes and the graph is meaningless. Rejected: making model/ optional — a graph without nodes has nothing to check, approve, or select against.

- **Architecture parse error stored in result field vs thrown.** When the architecture file exists but cannot be parsed, the loader returns a fallback architecture and populates `graph.architectureError` rather than throwing. Rejected: throwing on architecture parse failure — would prevent loading the rest of the graph when only the architecture file has a typo, blocking all commands unnecessarily.
