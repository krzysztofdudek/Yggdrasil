# Select Command Responsibility

**In scope:** `yg select "<query>" [--limit <n>]`. Find graph nodes, aspects, and flows relevant to a natural-language task description.

- Load graph via `loadGraph(yggRoot)`.
- Delegate selection to `selectTask(graph, query, limit)` from cli/core/node-selector.
- Output format: structured text with three sections (Nodes, Aspects, Flows). Aspects and flows show `(matched)` and `(N nodes)` annotations. Each aspect/flow entry includes `read:` paths to content files.
- Default limit: 5 per section. Empty sections show `(none)`.

**Consumes:** loadGraph (cli/core/loader), selectTask (cli/core/node-selector), findYggRoot (cli/utils).

**Out of scope:** Context assembly (use `yg context`), impact analysis (use `yg impact`).
