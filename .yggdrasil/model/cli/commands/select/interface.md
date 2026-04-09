# Select Command Interface

**Command:** `yg select <query>` — positional argument required.

**Options:** `--limit <n>` (default 5) — max results per section.

**Output format:** Header line `Results for "<query>":`, then three sections: Nodes (scored by keyword match, each entry formatted as `<node-path> — <name>`), Aspects (with matched/node-count annotations and read paths), Flows (with matched/node-count annotations and read paths). Empty sections show `(none)`.

## Failure Modes

- Missing .yggdrasil/: ENOENT with a dedicated "no graph found" message (not a raw propagated error).
- Invalid --limit: `Error: --limit must be a positive integer`, exit 1.
- Generic errors to stderr, exit 1.
