# Graph Loader Interface

- `loadGraph(projectRoot: string, options?: { tolerateInvalidConfig?: boolean }): Promise<Graph>`
  - Parameters: `projectRoot` (string), `options.tolerateInvalidConfig` (boolean, optional).
  - Returns: Graph with config, configError?, nodeParseErrors?, nodes, aspects, flows, knowledge, schemas, rootPath.
  - Finds .yggdrasil/ via findYggRoot. Parses config; on failure uses FALLBACK_CONFIG if tolerateInvalidConfig (configError set on Graph). Scans model/, loads aspects/, flows/, knowledge/, templates/. Node parse errors collected; scan continues.
  - Throws when model/ does not exist (ENOENT): `Error("Directory .yggdrasil/model/ does not exist. Run 'yg init' first.", { cause })`.

- `loadGraphFromRef(projectRoot: string, ref?: string): Promise<Graph | null>`
  - Parameters: `projectRoot` (string), `ref` (string, default 'HEAD').
  - Returns: Graph or null. Extracts .yggdrasil from git ref to temp dir via `git archive` + tar, loads via loadGraph(tmpDir). Returns null if: not git repo, ref missing (git rev-parse fails), or git archive fails. Temp dir cleaned in finally. No throw.
