# Graph Ops Commands Responsibility

**In scope:** `yg preflight`, `yg status`, `yg tree`, `yg owner`, `yg deps`, `yg impact`. Graph diagnostics, navigation, and introspection.

**preflight:**

- Unified diagnostic report: journal + drift + status counts + validation.
- loadGraph(process.cwd()), findYggRoot(cwd), readJournal(yggRoot), detectDrift(graph), validate(graph, 'all').
- Count nodes, aspects, flows, mapped paths.
- Output sections: Journal (clean or N pending entries), Drift (clean or N nodes need attention), Status (counts), Validation (clean or errors/warnings with codes).
- Exit code: 1 if journal entries OR drifted nodes OR validation errors. Warnings alone → exit 0.

**status:**

- loadGraph(process.cwd()), detectDrift(graph), validate(graph, 'all').
- Count nodes by type, blackbox count. Count structural (uses, calls, extends, implements) vs event relations.
- Output: graph name, nodes (type breakdown + blackbox), relations, aspects, flows, knowledge, drift counts, validation (errors, warnings).
- Pluralize: 1 module vs 2 modules, 1 library vs 2 libraries.

**tree:**

- loadGraph(process.cwd()). --root: subtree at path; --depth: max depth (parsed as int).
- If --root: validate path exists; if not, exit 1 "path '${path}' not found". Roots = [node]. showProjectName = false.
- Else: roots = top-level nodes (parent === null), sorted. showProjectName = true.
- Print tree: connector (├── or └──), name, [type], aspects, blackbox, relation count. Recurse children with depth limit.

**owner:**

- findOwner(graph, projectRoot, options.file). Uses normalizeProjectRelativePath, normalizeMappingPaths. normalizeForMatch: backslash to slash, strip trailing slash.
- Output: `${file} -> ${nodePath}` or `${file} -> no graph coverage`.

**deps:**

- loadGraph(process.cwd()). --node (required), --depth (optional int), --type (structural, event, all; default all). Trim --node, strip trailing slash.
- formatDependencyTree(graph, nodePath, { depth, relationType }). Output text + newline.

**impact:**

Three mutually exclusive modes (one required): --node, --aspect, --flow. Optional --simulate for all modes.

- **--node mode:** loadGraph(process.cwd()). Trim --node, strip trailing slash. If node not found: exit 1. collectReverseDependents: structural relations only → direct, allDependents. buildTransitiveChains: BFS from target, chains exclude target node. collectDescendants: hierarchy children. collectEffectiveAspectIds: own + hierarchy + flow + implies. Co-aspect nodes: other nodes sharing any effective aspect. Output: direct dependents (with relation type and consumes), transitive chains, descendants, flows, aspects, co-aspect nodes, total scope.
- **--aspect mode:** Find aspect by id. For every node, compute collectEffectiveAspectIds; collect those containing the aspect id. Determine source attribution (own, hierarchy from ancestor, flow, or implied). Report propagating flows, implied-by/implies relationships. Output: affected nodes with source, flow propagation, implies graph, total scope.
- **--flow mode:** Find flow by name or path. Collect declared participants and their descendants (via collectDescendants). Output: participants (marking descendants), flow aspects, total scope.
- **--simulate (any mode):** runSimulation: loadGraphFromRef(projectRoot, 'HEAD'), detectDrift. For each affected node: buildContext current + baseline, budget comparison (ok/warning/error), changed dependency interface line (node mode only), drift status line.
- Validation: exactly one mode required, mutually exclusive. Exit 1 with error message if 0 or >1 modes.

**Consumes:** loadGraph, loadGraphFromRef (cli/core/loader); validate (cli/core/validator); detectDrift (cli/core/drift-detector); formatDependencyTree (cli/core/dependency-resolver); buildContext, collectAncestors, collectEffectiveAspectIds (cli/core/context); normalizeMappingPaths, normalizeProjectRelativePath, findYggRoot (cli/utils); readJournal (cli/io); Graph, GraphNode, OwnerResult (cli/model).

**Out of scope:** Init, validation commands, drift commands, journal write/archive.
