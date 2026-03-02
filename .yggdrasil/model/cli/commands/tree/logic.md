# Tree Command Logic

1. `loadGraph(process.cwd())`
2. Parse options: `--root` (string), `--depth` (parseInt)
3. If `--root`: find node by path; if not found exit 1. Set roots = [node], showProjectName = false.
4. Else: roots = top-level nodes (parent === null), sorted. showProjectName = true.
5. If showProjectName: print `graph.config.name + '/'`
6. For each root: `printNode(node, prefix, isLast, currentDepth, maxDepth)`
   - Print connector + name + `[${type}]`
   - If aspects: append `aspects:${aspects.join(',')}`
   - If blackbox: append `(blackbox)`
   - Append `-> ${relations.length} relations`
   - Recurse children if depth allows, sorted alphabetically
