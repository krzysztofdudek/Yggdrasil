# Context Core Unit Tests — Responsibility

Guards the context assembly contract for the three modules that together deliver context packages to agents.

Context-builder tests verify correct layer merging, budget computation, and structured output generation. Context packages are the primary interface between the CLI and agents — incorrect assembly means agents receive wrong constraints or miss dependencies. In-memory graph fixtures are used to cover edge cases that real graph fixtures cannot reliably reproduce.

Context-files tests verify per-file context resolution: that the correct owning node is identified, that aspect rules and consumed dependencies are surfaced per file, and that unmapped files are reported as such rather than silently omitted.

Graph-loader tests verify that the raw YAML graph is parsed into a consistent in-memory model: node hierarchy, relations, aspect references, and flow participation are all structurally valid after loading, with no dangling references or missing fields.
