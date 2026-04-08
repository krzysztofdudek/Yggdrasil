# Loader Interface

## `loadGraph(projectRoot, options?): Promise<Graph>`

Loads the full graph from `.yggdrasil/`. Returns `Graph` with `config`, `architecture`, `nodes`, `aspects`, `flows`, `schemas`, `rootPath`, and optional error fields: `configError`, `architectureError`, `nodeParseErrors`.

- `options.tolerateInvalidConfig?: boolean` — on config parse failure, uses FALLBACK_CONFIG and sets `configError` on Graph instead of throwing.

## Failure Modes

- Throws `Error("Directory .yggdrasil/model/ does not exist. Run 'yg init' first.")` when model/ is missing.
- Config parse failure: throws unless `tolerateInvalidConfig` is set.
- Node parse errors: collected in `nodeParseErrors`, scan continues (no throw).
