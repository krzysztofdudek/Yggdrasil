```markdown
# `loadGraph` Module Documentation

## Overview
This module provides functionality to load and parse a graph structure from a Yggdrasil project. It reads configuration files, nodes, aspects, flows, and schemas, and constructs a graph representation. The module handles errors gracefully, allowing for optional tolerance of invalid configurations.

---

## Purpose
The primary purpose of this module is to:
1. Locate the Yggdrasil project root and its associated directories.
2. Parse and validate configuration files (`yg-config.yaml`).
3. Recursively scan the `model` directory to build a graph of nodes.
4. Load and parse aspects, flows, and schemas from their respective directories.
5. Return a comprehensive graph object containing all parsed data.

---

## Usage

### Main Function
```typescript
export async function loadGraph(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean } = {},
): Promise<Graph>
```

**Parameters:**
- `projectRoot`: The root directory of the Yggdrasil project.
- `options`: Optional configuration object.
  - `tolerateInvalidConfig`: If `true`, the function will not throw an error if the configuration file is invalid but will instead log the error and use a fallback configuration.

**Returns:**
A `Promise` resolving to a `Graph` object containing the parsed configuration, nodes, aspects, flows, schemas, and error information if applicable.

---

## Behavior

### Configuration Loading
1. **Finding Yggdrasil Root**: Uses `findYggRoot` to locate the `.yggdrasil` directory.
2. **Parsing Configuration**: Attempts to parse `yg-config.yaml`. If parsing fails and `tolerateInvalidConfig` is `true`, a fallback configuration is used, and the error is logged.

### Node Graph Construction
1. **Scanning Model Directory**: Recursively scans the `model` directory to find `yg-node.yaml` files.
2. **Parsing Nodes**: Parses each `yg-node.yaml` file and constructs a graph node. Errors during parsing are logged but do not halt the process.
3. **Building Hierarchy**: Establishes parent-child relationships between nodes based on directory structure.

### Loading Aspects, Flows, and Schemas
1. **Aspects**: Recursively scans the `aspects` directory, parsing `yg-aspect.yaml` files.
2. **Flows**: Scans the `flows` directory, parsing `yg-flow.yaml` files for each subdirectory.
3. **Schemas**: Scans the `schemas` directory, parsing all `.yaml` or `.yml` files.

### Error Handling
- **Directory Not Found**: Throws an error if the `.yggdrasil/model` directory does not exist, suggesting running `yg init`.
- **File Parsing Errors**: Logs errors encountered during node, aspect, flow, or schema parsing without halting the process.

---

## Key Functions

### `scanModelDirectory`
Recursively scans the `model` directory to build the node graph. Handles directory traversal, node parsing, and error logging.

### `loadAspects`
Loads and parses aspects from the `aspects` directory.

### `loadFlows`
Loads and parses flows from the `flows` directory.

### `loadSchemas`
Loads and parses schemas from the `schemas` directory.

---

## Return Object (`Graph`)
```typescript
{
  config: YggConfig,
  configError?: string,
  nodeParseErrors?: Array<{ nodePath: string; message: string }>,
  nodes: Map<string, GraphNode>,
  aspects: AspectDef[],
  flows: FlowDef[],
  schemas: SchemaDef[],
  rootPath: string,
}
```

**Fields:**
- `config`: Parsed Yggdrasil configuration.
- `configError`: Error message if configuration parsing failed and `tolerateInvalidConfig` was `true`.
- `nodeParseErrors`: Array of errors encountered during node parsing.
- `nodes`: Map of graph nodes, keyed by their path.
- `aspects`: Array of parsed aspect definitions.
- `flows`: Array of parsed flow definitions.
- `schemas`: Array of parsed schema definitions.
- `rootPath`: Path to the Yggdrasil project root.

---

## Error Handling
- **Configuration Errors**: Tolerated if `tolerateInvalidConfig` is `true`; otherwise, thrown.
- **Directory Errors**: Throws an error if the `model` directory is missing.
- **Parsing Errors**: Logged but do not halt the process.

---

## Dependencies
- `node:fs/promises`: For file system operations.
- `node:path`: For path manipulation.
- Custom parsers and utilities: `parseConfig`, `parseNodeYaml`, `parseAspect`, `parseFlow`, `parseSchema`, `readArtifacts`, `findYggRoot`.

---

## Example Use Case
```typescript
const graph = await loadGraph('/path/to/project', { tolerateInvalidConfig: true });
console.log(graph.nodes); // Access parsed nodes
console.log(graph.configError); // Check for configuration errors
```

This module is designed to be robust, handling edge cases and errors gracefully while providing a comprehensive graph representation of a Yggdrasil project.
```