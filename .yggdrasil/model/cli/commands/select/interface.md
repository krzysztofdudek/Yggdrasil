# Select Command Interface

## `registerSelectCommand(program: Command): void`

Registers the `yg select` subcommand on the Commander program.

**Arguments:**

- `<query>` (required) — Natural-language task description (positional argument).

**Options:**

- `--limit <n>` (optional, default: `5`) — Maximum results per section.

**Output:** Structured text with three sections: Nodes, Aspects, Flows. Aspects and flows annotated with `(matched)` and/or `(N nodes)`. Each includes `read:` paths. `(none)` when section is empty.

**Exit codes:** 0 on success, 1 on error (missing `.yggdrasil/`, invalid graph, invalid limit).
