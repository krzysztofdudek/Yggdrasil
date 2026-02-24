# Validation Commands Logic

## validate

1. loadGraph(tolerateInvalidConfig: true)
2. scope = (options.scope ?? 'all').trim() || 'all'
3. validate(graph, scope)
4. Output: nodesScanned; errors (red ✗); warnings (yellow ⚠); summary line
5. Exit 1 if any error; else exit 0

## build-context

1. loadGraph
2. validate(graph, 'all'); if structural errors → exit 1 "build-context requires structurally valid graph"
3. nodePath = options.node.trim(), strip trailing slash
4. buildContext(graph, nodePath)
5. budgetStatus = tokenCount >= errorThreshold ? 'error' : tokenCount >= warningThreshold ? 'warning' : 'ok'
6. formatContextMarkdown(pkg); append "Budget status: {status}"
7. If budgetStatus === 'error' → stderr, exit 1
