# Context Builder Errors

- **Node not found**: Throws `Error("Node not found: ${nodePath}")` if nodePath not in graph.nodes.
- **Broken relation**: Throws `Error("Broken relation: ${nodePath} -> ${relation.target} (target not found)")` when structural or event relation target not in graph.
- **buildOwnLayer node.yaml read**: Catches readFile errors; emits `(not found)` in content instead of throwing.
- **Artifact read failure**: Other readFile calls (e.g. in loader-provided artifacts) — not in context-builder; artifacts come pre-loaded.
