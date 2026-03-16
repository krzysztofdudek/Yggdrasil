# File Hashing and Tracking Module

## Overview

This module provides utilities for hashing files and directories, tracking changes, and optimizing performance by leveraging file modification times (`mtime`). It is designed to support drift detection in file systems, particularly in scenarios involving large mappings or frequent updates.

## Core Functions

### `hashFile(filePath: string): Promise<string>`

**Purpose:** Computes the SHA-256 hash of a file's content.  
**Usage:** Use this function to generate a unique hash for a single file.  
**Behavior:** Reads the file content and returns a hexadecimal hash digest.

### `hashPath(targetPath: string, options?: HashPathOptions): Promise<string>`

**Purpose:** Computes a hash for a file or directory, respecting `.gitignore` rules.  
**Usage:** Use this for hashing individual files or entire directories.  
**Behavior:**  
- For files: Directly hashes the content.  
- For directories: Recursively collects file hashes, sorts them, and computes a digest hash.  
- Ignores files/directories matched by `.gitignore` rules.  

### `hashString(content: string): string`

**Purpose:** Computes the SHA-256 hash of a string.  
**Usage:** Utility function for hashing string content.  
**Behavior:** Returns a hexadecimal hash digest.

### `perFileHashes(projectRoot: string, mapping: { paths?: string[] }): Promise<Array<{ path: string; hash: string }>>`

**Purpose:** Computes per-file hashes for a given mapping of paths.  
**Usage:** Use for diagnostics or detailed change tracking.  
**Behavior:**  
- Expands directories to their contained files.  
- Respects `.gitignore` rules.  
- Returns an array of objects with file paths and their hashes.  

### `hashForMapping(projectRoot: string, mapping: { paths?: string[] }): Promise<string>`

**Purpose:** Computes a canonical hash for a mapping of paths.  
**Usage:** Use for detecting changes in a set of files or directories.  
**Behavior:**  
- Hashes files directly and directories recursively.  
- Sorts and concatenates path-hash pairs to create a digest.  
- Throws an error if the mapping is empty.  

### `hashTrackedFiles(projectRoot: string, trackedFiles: TrackedFile[], storedFileData?: StoredFileData, excludePrefixes?: string[]): Promise<{ canonicalHash: string; fileHashes: Record<string, string>; fileMtimes: Record<string, number> }>`

**Purpose:** Hashes all tracked files efficiently, reusing stored hashes for unchanged files.  
**Usage:** Use for bidirectional drift detection in large mappings.  
**Behavior:**  
- Expands directories in `trackedFiles` to their contained files.  
- Excludes files matching `excludePrefixes`.  
- Reuses stored hashes for files with matching `mtime`.  
- Hashes remaining files in parallel batches.  
- Returns a canonical hash, per-file hashes, and modification times.  

## Helper Functions

### `collectDirectoryFileHashes(directoryPath: string, rootDirectoryPath: string, options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] }): Promise<Array<{ path: string; hash: string }>>`

**Purpose:** Collects and hashes files within a directory.  
**Usage:** Internal helper for directory hashing.  
**Behavior:** Recursively collects files, computes hashes, and returns an array of path-hash pairs.

### `loadRootGitignoreStack(projectRoot?: string): Promise<GitignoreEntry[]>`

**Purpose:** Loads `.gitignore` rules from the project root.  
**Usage:** Internal helper for `.gitignore` handling.  
**Behavior:** Parses `.gitignore` content and returns a stack of matchers.

### `isIgnoredByStack(candidatePath: string, stack: GitignoreEntry[]): boolean`

**Purpose:** Checks if a path is ignored by the `.gitignore` stack.  
**Usage:** Internal helper for `.gitignore` filtering.  
**Behavior:** Returns `true` if the path matches any ignore rule.

### `collectDirectoryFilePaths(directoryPath: string, rootDirectoryPath: string, options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] }): Promise<Array<{ relPath: string; absPath: string; mtimeMs: number }>>`

**Purpose:** Collects file paths and modification times from a directory.  
**Usage:** Internal helper for separating discovery from hashing.  
**Behavior:** Recursively collects files, respects `.gitignore` rules, and returns metadata.

## Types

### `HashPathOptions`

**Properties:**  
- `projectRoot?: string`: Root directory for resolving paths.  

### `GitignoreEntry`

**Properties:**  
- `basePath: string`: Base path for the `.gitignore` matcher.  
- `matcher: Ignore`: Ignore matcher instance.  

### `StoredFileData`

**Properties:**  
- `hashes: Record<string, string>`: Stored file hashes.  
- `mtimes: Record<string, number>`: Stored file modification times.  

## Performance Optimizations

- **Mtime-Based Caching:** Reuses stored hashes for files with unchanged `mtime`, significantly speeding up large mappings.  
- **Parallel Processing:** Hashes files in parallel batches to avoid overwhelming file descriptors.  
- **Lazy Hashing:** Separates file discovery from hashing to minimize I/O operations.  

## Error Handling

- Throws errors for unsupported path types or invalid mappings.  
- Ignores missing `.gitignore` files gracefully.  

## Usage Example

```typescript
const trackedFiles: TrackedFile[] = [{ path: 'src' }, { path: 'package.json' }];
const storedData: StoredFileData = { hashes: {}, mtimes: {} };

hashTrackedFiles('/project/root', trackedFiles, storedData).then(({ canonicalHash, fileHashes, fileMtimes }) => {
  console.log('Canonical Hash:', canonicalHash);
  console.log('File Hashes:', fileHashes);
  console.log('File Mtimes:', fileMtimes);
});
```

This documentation provides a comprehensive overview of the module's functionality, usage, and internal behavior.