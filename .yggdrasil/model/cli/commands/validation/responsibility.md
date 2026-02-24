# Validation Commands Responsibility

**In scope:** `yg validate` and `yg build-context`. Graph validation and context package assembly.

**validate:**

- loadGraph(process.cwd(), { tolerateInvalidConfig: true }). Scope: --scope (default "all"). Trim; empty or whitespace -> "all".
- validate(graph, scope). Output: nodesScanned, then errors (red), warnings (yellow). Format: code nodePath -> message or code message.
- If no issues: "✓ No issues found." (green). Else: "N errors, M warnings."
- Exit 1 if any error; exit 0 otherwise.

**build-context:**

- loadGraph(process.cwd()) — no tolerateInvalidConfig.
- validate(graph, 'all'). If any structural errors (severity === 'error'): exit 1 "Error: build-context requires a structurally valid graph (N errors found)."
- nodePath: options.node trim, strip trailing slash.
- buildContext(graph, nodePath). formatContextMarkdown(pkg).
- Budget: graph.config.quality.context_budget (warning default 5000, error default 10000). budgetStatus: error if >= errorThreshold, warning if >= warningThreshold, else ok.
- Output: markdown + "Budget status: ${budgetStatus}". If budgetStatus === 'error': stderr "Error: context package exceeds error budget", exit 1.

**Consumes:** loadGraph (cli/core/loader); validate (cli/core/validator); buildContext (cli/core/context); formatContextMarkdown (cli/formatters).

**Out of scope:** Drift, journal, graph navigation.
