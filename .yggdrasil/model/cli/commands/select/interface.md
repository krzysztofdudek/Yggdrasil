# Select Command Interface

**Command:** `yg select <query>` — positional argument required.

**Options:** `--limit <n>` (default 5) — max results per section.

**Output format:** Structured text with three sections: Nodes (scored by keyword match), Aspects (with matched/node-count annotations and read paths), Flows (with matched/node-count annotations and read paths). Empty sections show `(none)`.

## Failure Modes

- Missing .yggdrasil/: propagated from loadGraph.
- Invalid --limit: `Error: --limit must be a positive integer`, exit 1.
- Generic errors to stderr, exit 1.
