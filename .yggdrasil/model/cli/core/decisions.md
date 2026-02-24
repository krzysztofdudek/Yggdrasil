# Core Decisions

**Reference:** docs/idea/engine.md (Context assembly, validation, drift, dependencies)

Core implements the **deterministic mechanics** — the algorithms that operate on the graph. Everything here is reproducible: same graph state → same context package, same validation result, same drift report. No heuristics, no guessing, no repository search.

**10-step context assembly:** The algorithm is fixed (docs/idea/engine.md). Order: global → knowledge (4 scopes) → hierarchy → own → relational → aspects → flows. Each step is mechanical: read declarations, copy content, annotate with YAML metadata. Tools never interpret Markdown content — they copy and annotate. The agent interprets.

**Why determinism matters:** The graph is the intended truth. If tools produced different output for the same input, the system would be unreliable. CI, agents, and humans must get identical results. Determinism is the foundation of trust.

**Why core doesn't parse YAML:** Separation of concerns. IO layer parses; core consumes typed structures. Core focuses on graph logic — assembly, validation, dependency resolution. IO focuses on file format. Clear boundary, testable in isolation.
