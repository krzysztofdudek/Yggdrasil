# Select Command Responsibility

**In scope:** `yg select "<query>"`. Entry point for the graph-first workflow — finds the most relevant nodes, aspects, and flows for a given task before the agent starts work.

The three-section output (Nodes, Aspects, Flows) with `read:` paths is designed to drive the READING phase: agents use the paths to load constraints before designing an approach. Aspect and flow annotations (`(matched)`, `(N nodes)`) help agents prioritize what to read.

**Out of scope:** Context assembly (use `yg context`), impact analysis (use `yg impact`).
