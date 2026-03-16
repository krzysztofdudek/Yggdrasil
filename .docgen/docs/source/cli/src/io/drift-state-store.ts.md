```markdown
# Drift State Management Module

This module provides utilities for managing drift state in a `.drift-state` directory. It supports reading, writing, and garbage collecting drift state data, with backward compatibility for legacy single-file formats.

## Features
- **Per-node state files**: Stores drift state for each node in separate `.json` files under `.drift-state/`.
- **Legacy migration**: Automatically migrates from a single-file format (JSON or YAML) to per-node files.
- **Garbage collection**: Removes stale drift state files and cleans up empty directories.
- **Recursive directory scanning**: Efficiently scans directories for `.json` files.

## Functions

### `nodeStatePath(yggRoot, nodePath)`
**Purpose**: Converts a node path to its corresponding state file path under `.drift-state/`.  
**Usage**: Internal utility used by other functions.  
**Behavior**: Joins the `yggRoot`, `.drift-state`, and `nodePath` with a `.json` extension.

### `scanJsonFiles(dir, baseDir)`
**Purpose**: Recursively scans a directory for `.json` files and returns their paths relative to `baseDir`.  
**Usage**: Used by `readDriftState` and `garbageCollectDriftState`.  
**Behavior**: Ignores non-`.json` files and directories without `.json` files. Returns paths without the `.json` extension.

### `removeEmptyParents(filePath, stopDir)`
**Purpose**: Removes empty directories walking up from `filePath` to `stopDir`.  
**Usage**: Called after deleting a file to clean up empty parent directories.  
**Behavior**: Stops at `stopDir` or when a non-empty directory is encountered.

### `readNodeDriftState(yggRoot, nodePath)`
**Purpose**: Reads the drift state for a specific node from `.drift-state/<nodePath>.json`.  
**Usage**: Used by `readDriftState` and externally to retrieve node-specific state.  
**Behavior**: Returns `undefined` if the file does not exist or is invalid.

### `writeNodeDriftState(yggRoot, nodePath, nodeState)`
**Purpose**: Writes the drift state for a specific node to `.drift-state/<nodePath>.json`.  
**Usage**: Used by `writeDriftState` and externally to update node-specific state.  
**Behavior**: Creates parent directories if they do not exist.

### `garbageCollectDriftState(yggRoot, validNodePaths)`
**Purpose**: Removes drift state files for nodes not in `validNodePaths` and cleans up empty directories.  
**Usage**: Called to prune stale drift state data.  
**Behavior**: Returns a sorted list of removed node paths.

### `readDriftState(yggRoot)`
**Purpose**: Reads the full drift state from `.drift-state/`.  
**Usage**: Used to retrieve the entire drift state.  
**Behavior**:  
  - If `.drift-state` is a directory, scans for per-node `.json` files.  
  - If `.drift-state` is a file (legacy), migrates to per-node files and deletes the old file.  
  - If `.drift-state` does not exist, returns an empty object.

### `writeDriftState(yggRoot, state)`
**Purpose**: Writes the full drift state as per-node files under `.drift-state/`.  
**Usage**: Used to persist the entire drift state.  
**Behavior**: Writes each entry in `state` to a separate `.json` file.

## Backward Compatibility
- **Legacy single-file format**: If `.drift-state` is a file, it is parsed (JSON or YAML) and migrated to per-node files.  
- **String entries**: Legacy string entries in the single-file format are silently skipped.

## Error Handling
- Functions return `undefined` or empty values for missing or invalid files.  
- File system errors (e.g., permission issues) are caught and handled gracefully.
```