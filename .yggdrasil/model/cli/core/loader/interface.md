# Loader Interface

## `loadGraph(projectRoot, options?): Promise<Graph>`

The single entry point for all graph access. Call this once per command invocation and pass the resulting `Graph` to all downstream operations. Do not load the graph multiple times within a single command — the loader reads all nodes, aspects, and flows from disk; repeated calls waste I/O.

**`tolerateInvalidConfig`** — pass this when the command must run even if `yg-config.yaml` is malformed (e.g. `yg check`, which needs to report the config error rather than abort). When set, a config failure does not throw — instead `graph.configError` is populated and a fallback config is used. Commands that need a valid config to function (e.g. commands that create new nodes) should NOT pass this option so they fail fast.

**`configError`, `architectureError`, and `nodeParseErrors` in the result** — check these when the command is responsible for reporting graph health. A non-null `configError` means the config could not be parsed and the graph is running on defaults; report it to the user. Check `architectureError` when the architecture file exists but failed to parse — a fallback architecture is used but the error should be surfaced. `nodeParseErrors` is an array of `{ nodePath, message }` entries for nodes that could not be loaded; these nodes are absent from `graph.nodes`, so any operation that iterates nodes will silently skip them — surface errors explicitly if completeness matters.

## Failure Modes

- Throws `Error("Directory .yggdrasil/model/ does not exist. Run 'yg init' first.")` when the model directory is missing. This is a hard stop — the graph does not exist yet.
- Config parse failure throws unless `tolerateInvalidConfig` is set.
- Node parse errors are collected, not thrown — scan always completes.
