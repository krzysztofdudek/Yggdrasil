# Node Selector Interface

## `selectNodes(graph, task, limit): SelectionResult[]`

Simple node selection. Use this when you need nodes only — no aspects or flows. Scores nodes by keyword match against their artifacts (responsibility weighted highest, then interface and aspect content weighted ×2 equally, then other artifacts). If no nodes score above zero, falls back to flow-based selection: nodes that participate in flows whose artifacts match the task are returned, scored by flow relevance. Returns at most `limit` results, sorted by score descending. Equal-score tiebreaker prefers deeper paths (more specific nodes).

- `task: string` — natural-language task description (the parameter is named `task` in source, not `query`)
- Returns `SelectionResult[]` — each entry has `node` (path), `score`, and `name`

## `selectTask(graph, task, limit): EnrichedSelectResult`

Three-dimensional search. Use this for the `yg select` command where agents need the full context picture — nodes, aspects, and flows together. Aspects and flows are scored independently against the task, then merged with any that appear on the top-ranked nodes. The `matched` flag distinguishes direct keyword hits (agent should read these) from incidental coverage via the returned nodes.

- Returns `EnrichedSelectResult` with `nodes`, `aspects` (each with `matched` boolean, `nodeCount`, and `readPaths`), and `flows` (each with `matched` boolean, `nodeCount`, and `readPath`)

## Failure Modes

- Empty task string: returns empty results (no throw).
- Graph with no nodes: returns empty results (no throw).
- Never throws — always returns a result.
