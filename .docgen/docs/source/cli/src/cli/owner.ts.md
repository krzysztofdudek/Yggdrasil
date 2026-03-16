# Documentation: Owner Command Module

## Overview
This module provides functionality to determine which node in a project graph "owns" a given source file. It integrates with the **Commander** CLI framework to expose an `owner` command, enabling developers to query ownership information directly from the command line. The ownership resolution is based on path mappings defined in the graph metadata.

---

## Purpose
- **Ownership Resolution**: Identify the graph node responsible for a file or directory within a repository.
- **Context Awareness**: Distinguish between direct mappings (explicit file ownership) and indirect mappings (ownership inferred from ancestor directories).
- **CLI Integration**: Offer a user-friendly command (`owner`) to query ownership, with clear feedback when files are unmapped or missing.

---

## Key Functions

### `normalizeForMatch(inputPath: string): string`
- **Purpose**: Standardizes file paths for comparison.
- **Behavior**:
  - Converts backslashes (`\`) to forward slashes (`/`).
  - Removes trailing slashes.
- **Usage**: Ensures consistent path matching across platforms and user input variations.

---

### `findOwner(graph: Graph, projectRoot: string, rawPath: string): OwnerResult`
- **Purpose**: Determines which graph node owns a given file.
- **Behavior**:
  - Normalizes the file path relative to the project root.
  - Iterates through graph nodes and their mapping paths.
  - Returns:
    - **Direct ownership** if the file exactly matches a mapping path.
    - **Indirect ownership** if the file resides under a mapped directory.
    - **No ownership** if no mapping applies.
- **Selection Logic**:
  - Prefers the longest matching mapping path when multiple indirect matches exist.
  - Provides contextual information about whether the mapping is direct or inferred.

---

### `registerOwnerCommand(program: Command): void`
- **Purpose**: Registers the `owner` command with Commander.
- **Behavior**:
  - Defines the `owner` command with a required `--file` option.
  - Loads the project graph from the current working directory.
  - Resolves the provided file path relative to the repository root.
  - Calls `findOwner` to determine ownership.
  - Outputs results to `stdout`:
    - **Owned file**: Prints the file path and owning node.
    - **Indirect ownership**: Adds a note about ancestor directory context.
    - **Unmapped file**: Distinguishes between files that exist but lack coverage and files that do not exist.
  - Handles errors gracefully, printing messages to `stderr` and exiting with a non-zero code.

---

## Usage

### Command-Line Example
```bash
yg owner --file src/utils/helpers.ts
```

### Possible Outputs
- **Direct ownership**:
  ```
  src/utils/helpers.ts -> utils-node
  ```
- **Indirect ownership**:
  ```
  src/utils/helpers.ts -> core-node
    File has no direct mapping; context comes from ancestor directory src/utils. Use: yg build-context --node core-node
  ```
- **No ownership, file exists**:
  ```
  src/utils/helpers.ts -> no graph coverage
  ```
- **No ownership, file missing**:
  ```
  src/utils/helpers.ts -> no graph coverage (file not found)
  ```

---

## Behavior Notes
- **Path Resolution**: Input paths are resolved relative to the current working directory, then normalized against the repository root.
- **Graph Dependency**: Ownership determination relies entirely on the graph structure and its metadata mappings.
- **Error Handling**: Any unexpected errors during graph loading or path resolution result in a clear error message and process termination.

---

## Practical Applications
- **Build Context Identification**: Helps developers understand which node provides context for a file, useful for dependency analysis and build orchestration.
- **Coverage Auditing**: Quickly detects files not covered by the graph, aiding in repository maintenance.
- **Debugging**: Provides insight into indirect ownership relationships, clarifying why certain files are associated with specific nodes.