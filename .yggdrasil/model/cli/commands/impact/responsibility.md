# Impact Command Responsibility

**In scope:** `yg impact --node <path>|--aspect <id>|--flow <name> [--simulate]`. Blast radius analysis.

Three mutually exclusive modes (one required):

**--node mode:** Collect reverse dependents (structural relations only), build transitive chains (BFS from target), collect descendants (hierarchy children), compute effective aspects, find co-aspect nodes. Output: direct dependents with relation type and consumes, transitive chains, descendants, flows, aspects, co-aspect nodes, total scope.

**--aspect mode:** For every node, compute effective aspects; collect those containing the target aspect. Determine source attribution (own, hierarchy, flow, implied). Report propagating flows, implies relationships. Output: affected nodes with source, flow propagation, implies graph, total scope.

**--flow mode:** Find flow by name or path. Collect declared participants and their descendants. Output: participants (marking descendants), flow aspects, total scope.

**--simulate (any mode):** For each affected node: load baseline graph from HEAD via `loadGraphFromRef`, run `detectDrift`, compare `buildContext` current vs baseline, report budget status (ok/warning/error), changed dependency interface (node mode), drift status.

**Consumes:** loadGraph, loadGraphFromRef (cli/core/loader); buildContext, collectAncestors, collectEffectiveAspectIds (cli/core/context); detectDrift (cli/core/drift-detector); Graph (cli/model).

**Out of scope:** Modifying graph, resolving drift, validation output formatting.
