# Validation Commands Responsibility

**In scope:** `yg validate`. Graph structural validation.

**validate:**

- loadGraph(process.cwd(), { tolerateInvalidConfig: true }). Scope: --scope (default "all"). Trim; empty or whitespace -> "all".
- validate(graph, scope). Output: nodesScanned, then errors (red), warnings (yellow). Format: code nodePath -> message or code message.
- If no issues: "No issues found." (green). Else: "N errors, M warnings."
- Exit 1 if any error; exit 0 otherwise.

**Consumes:** loadGraph (cli/core/loader); validate (cli/core/validator).

**Out of scope:** Drift, graph navigation, context assembly.
