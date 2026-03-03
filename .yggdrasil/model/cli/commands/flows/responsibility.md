# Flows Command Responsibility

**In scope:** `yg flows`. List all flows with metadata in YAML format.

- Load graph via `loadGraph(process.cwd())`.
- For each flow in graph.flows (sorted by name): output YAML with name, nodes (participants), aspects (if present).
- Output format: YAML array to stdout via `yamlStringify`.

**Consumes:** loadGraph (cli/core/loader), findYggRoot (cli/utils).

**Out of scope:** Flow creation, modification, impact analysis (use `yg impact --flow`).
