Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the provided code. It avoids restating trivial details and instead focuses on intent, workflow, and design decisions.

---

# `build-context` Command — Technical Documentation

This module registers and implements the `build-context` CLI command, responsible for assembling a complete “context package” for a single node within a Yggdrasil model graph. It resolves all relevant graph elements, validates them, and optionally embeds full artifact contents into the output.

---

## Overview

The command operates on a loaded Yggdrasil graph and produces a structured context bundle for a specific node. The output is designed for downstream tooling that requires a node’s definition, its hierarchical lineage, related nodes, and optionally the raw artifact files that contribute to its definition.

The workflow consists of:

1. Loading the graph from disk.
2. Determining which nodes are relevant to the requested node.
3. Validating the graph and filtering errors to only those affecting the relevant subset.
4. Building the context package.
5. Formatting the output as YAML, optionally with embedded file contents.

---

## Command Registration

### `registerBuildCommand(program: Command)`

Adds the `build-context` command to a Commander.js program instance.

#### Usage

```
build-context --node <node-path> [--full]
```

#### Options

| Option | Description |
|--------|-------------|
| `--node <node-path>` | Required. Path to the target node relative to `.yggdrasil/model/`. |
| `--full` | Optional. When provided, the output includes the full contents of all artifact files referenced by the context package. |

---

## Relevant Node Resolution

### `collectRelevantNodePaths(graph, nodePath)`

Determines the minimal set of nodes required to fully understand the target node’s context. This includes:

- The node itself.
- All ancestors in its hierarchical chain.
- All directly related nodes.
- The ancestors of those related nodes.

This ensures that the context package contains all structural and semantic dependencies without pulling in unrelated parts of the graph.

The function intentionally avoids exploring deeper relation chains beyond direct relations, preventing runaway graph expansion.

---

## Validation Filtering

Before building the context, the command validates the entire graph. However, only errors that affect the relevant node set are considered blocking.

This selective filtering serves two purposes:

1. **Fail fast on meaningful issues** — If the target node or its dependencies are invalid, the context cannot be trusted.
2. **Ignore unrelated global issues** — Errors elsewhere in the graph should not prevent context extraction for an otherwise valid node.

The output includes a summary of ignored errors to maintain transparency.

---

## Context Package Construction

### `buildContext(graph, nodePath)`

Produces a structured context package containing:

- Node metadata
- Ancestor hierarchy
- Relations
- Artifact references

### `toContextMapOutput(pkg, graph)`

Transforms the internal package representation into a normalized map suitable for YAML serialization.

### `formatContextYaml(mapOutput)`

Serializes the context map into a human‑readable YAML document.

---

## Full Artifact Embedding (`--full`)

When `--full` is enabled, the command appends a second section containing the raw contents of all artifact files referenced by the context package.

Key behaviors:

- Files are deduplicated across nodes, aspects, and flows.
- YAML definition files (`yg-node.yaml`, `yg-aspect.yaml`, `yg-flow.yaml`) are loaded from memory when available, otherwise read from disk.
- The order of files follows the order of registry sections to maintain predictable output.

### File Resolution Logic

#### `findFileContent(filePath, graph)`

Resolves file contents using a tiered strategy:

1. **In-memory graph data**  
   Used for artifacts and YAML definitions already loaded by the graph loader.

2. **Disk fallback**  
   Used when YAML definitions are not stored in memory.

3. **Scoped lookup**  
   The function interprets the file path prefix (`model/`, `aspects/`, `flows/`) to determine which graph collection to search.

This design ensures that the command remains robust even when the graph loader does not preload all file types.

---

## Error Handling

The command exits with status `1` when:

- Relevant validation errors are present.
- Unexpected exceptions occur during graph loading, file reading, or context construction.

Errors are written to `stderr` with contextual information, including node paths and error codes when available.

---

## Example Workflow

1. User invokes:

   ```
   build-context --node cli/core/loader --full
   ```

2. The command:
   - Loads the graph from the current working directory.
   - Identifies the node and its ancestors/relations.
   - Filters validation errors to only those affecting the node.
   - Builds the context package.
   - Serializes it to YAML.
   - Appends full artifact contents.
   - Writes the final output to `stdout`.

---

## Design Considerations

- **Minimal dependency footprint**: Only nodes essential to the target node’s meaning are included.
- **Predictable output**: Deduplication and ordered traversal ensure stable output across runs.
- **Graceful degradation**: Missing artifacts or YAML files do not crash the command; they simply omit unavailable content.
- **Separation of concerns**: Graph loading, validation, context building, and formatting are delegated to specialized modules.

---

If you'd like, I can also generate:

- A high-level architectural diagram (text-based)
- A README‑ready version of this documentation
- Inline JSDoc comments for the source code