# Graph Ops Commands Responsibility

**In scope:** `yg status`, `yg tree`, `yg owner`, `yg deps`, `yg impact`. Graph navigation and introspection.

**status:**

- loadGraph(process.cwd()), detectDrift(graph), validate(graph, 'all').
- Count nodes by type, blackbox count. Count structural (uses, calls, extends, implements) vs event relations.
- Output: graph name, nodes (type breakdown + blackbox), relations, aspects, flows, knowledge, drift counts, validation (errors, warnings).
- Pluralize: 1 module vs 2 modules, 1 library vs 2 libraries.

**tree:**

- loadGraph(process.cwd()). --root: subtree at path; --depth: max depth (parsed as int).
- If --root: validate path exists; if not, exit 1 "path '${path}' not found". Roots = [node]. showProjectName = false.
- Else: roots = top-level nodes (parent === null), sorted. showProjectName = true.
- Print tree: connector (├── or └──), name, [type], tags, blackbox, relation count. Recurse children with depth limit.

**owner:**

- findOwner(graph, projectRoot, options.file). Uses normalizeProjectRelativePath, normalizeMappingPaths. normalizeForMatch: backslash to slash, strip trailing slash.
- Output: `${file} -> ${nodePath}` or `${file} -> no graph coverage`.

**deps:**

- loadGraph(process.cwd()). --node (required), --depth (optional int), --type (structural, event, all; default all). Trim --node, strip trailing slash.
- formatDependencyTree(graph, nodePath, { depth, relationType }). Output text + newline.

**impact:**

- loadGraph(process.cwd()). --node (required), --simulate (optional). Trim --node, strip trailing slash.
- If node not found: exit 1 "Node not found: ${nodePath}".
- collectReverseDependents: structural relations only. direct, transitive, chains.
- Output: direct dependents (with consumes if present), transitive chains, flows (node in flow.nodes), aspects (tag match), knowledge (scope covers node).
- If --simulate and transitive.length > 0: loadGraphFromRef(projectRoot, 'HEAD'), detectDrift. For each dependent: buildContext, budget status, baseline tokens (HEAD), drift status. Output per-node: changed dependency line (if direct structural dep on target), budget line, drift line.

**Consumes:** loadGraph, loadGraphFromRef (cli/core/loader); validate (cli/core/validator); detectDrift (cli/core/drift-detector); formatDependencyTree (cli/core/dependency-resolver); buildContext (cli/core/context); normalizeMappingPaths, normalizeProjectRelativePath (cli/utils); Graph, GraphNode, OwnerResult (cli/model).

**Out of scope:** Init, validation commands, drift commands, journal.
