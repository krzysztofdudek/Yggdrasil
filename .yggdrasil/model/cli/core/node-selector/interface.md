# Node Selector Interface

## `selectTask(graph, query, limit): EnrichedSelectResult`

Finds nodes, aspects, and flows relevant to a task description. Returns results sorted by relevance score descending — callers can use them directly without re-ranking.

- `query: string` — natural-language task description
- `limit: number` — maximum results per section (nodes, aspects, flows)
- Returns `EnrichedSelectResult` with `nodes`, `aspects` (with matched/nodeCount annotations and read paths), and `flows` (with matched/nodeCount annotations and read paths).

## Failure Modes

- Empty query: returns empty results.
- Graph with no nodes: returns empty results.
- Never throws — always returns a result.
