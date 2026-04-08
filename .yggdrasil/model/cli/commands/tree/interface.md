# Tree Command Interface

**Command:** `yg tree [--root <path>] [--depth <n>]`

Renders the graph hierarchy to stdout as an indented tree showing node names, types, aspects, blackbox status, and relation counts. Without `--root`, output starts with a `model/` header.

**--root:** Scopes output to the subtree rooted at the given node path. Omits the project header. Exits with error if the path does not exist in the graph.

**--depth:** Limits how many levels deep the tree recurses. Without this flag, the full depth is shown.

## Failure Modes

- No .yggdrasil/ directory: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`
- Invalid --root path: `Error: path '<path>' not found`, exit 1.
- Generic errors to stderr, exit 1.
