# Documentation: Path and Project Utilities for Yggdrasil CLI

This module provides utility functions for locating and normalizing paths within a Yggdrasil-based project. It ensures consistent handling of filesystem paths across different environments, particularly when working with the `.yggdrasil/` directory and project-relative paths.

---

## Purpose

The utilities serve three main goals:

1. **Project Root Resolution**  
   Identify the root directory of the CLI package or the repository containing the `.yggdrasil/` graph.

2. **Graph Path Management**  
   Convert absolute filesystem paths into graph-relative paths suitable for internal representation.

3. **Path Normalization**  
   Enforce consistent, POSIX-style project-relative paths and validate that user-provided paths remain within the project boundary.

---

## Functions

### `getPackageRoot(): string`
- **Purpose:** Determines the directory containing the CLI package.  
- **Behavior:** Uses `import.meta.url` to resolve the location of the current module, ensuring correctness even when installed globally.  
- **Usage:** Useful for locating bundled assets or configuration files relative to the CLI distribution.

---

### `findYggRoot(projectRoot: string): Promise<string>`
- **Purpose:** Searches upward from a given project root to locate the `.yggdrasil/` directory.  
- **Behavior:**  
  - Iteratively checks each parent directory until the filesystem root is reached.  
  - Validates that `.yggdrasil` exists and is a directory.  
  - Throws descriptive errors if the directory is missing or incorrectly structured.  
- **Usage:** Ensures commands operate within a valid Yggdrasil graph context.

---

### `normalizeMappingPaths(mapping: NodeMapping | undefined): string[]`
- **Purpose:** Standardizes node mappings to always yield an array of clean, relative paths.  
- **Behavior:**  
  - Trims whitespace from each path.  
  - Filters out empty entries.  
- **Usage:** Guarantees predictable path arrays when consuming user or configuration-provided mappings.

---

### `toGraphPath(absolutePath: string, yggRoot: string): string`
- **Purpose:** Converts an absolute filesystem path under `.yggdrasil/` into a graph-relative path.  
- **Behavior:**  
  - Computes the relative path from the Yggdrasil root.  
  - Normalizes separators to POSIX (`/`).  
- **Usage:** Provides canonical graph identifiers for nodes, independent of platform-specific path separators.

---

### `normalizeProjectRelativePath(projectRoot: string, rawPath: string): string`
- **Purpose:** Ensures user-provided paths resolve to valid project-relative paths.  
- **Behavior:**  
  - Trims and normalizes input to POSIX form.  
  - Resolves against the project root.  
  - Rejects paths that escape the project root (e.g., via `..`).  
- **Usage:** Prevents accidental or malicious references outside the project boundary.

---

### `normalizeNodePath(rawPath: string): string`
- **Purpose:** Cleans up node path arguments for CLI usage.  
- **Behavior:**  
  - Removes leading `./`.  
  - Strips trailing slashes.  
- **Usage:** Ensures consistent node path formatting when passed as CLI arguments.

---

### `projectRootFromGraph(yggRootPath: string): string`
- **Purpose:** Derives the repository root from the `.yggdrasil/` directory path.  
- **Behavior:** Returns the parent directory of the `.yggdrasil/` folder.  
- **Usage:** Useful for commands that need to operate at the repository level rather than within the graph directory.

---

## Key Design Considerations

- **Cross-Platform Consistency:** Paths are normalized to POSIX form (`/`) to avoid issues across operating systems.  
- **Safety:** Functions validate inputs to prevent traversal outside the project root.  
- **Error Transparency:** Errors provide actionable guidance (e.g., suggesting `yg init` when `.yggdrasil/` is missing).  
- **Graph Awareness:** Utilities are tailored for Yggdrasil’s graph-based project structure, ensuring paths map correctly to graph nodes.

---

## Typical Workflow Example

1. **Locate Graph Root:**  
   ```ts
   const yggRoot = await findYggRoot(process.cwd());
   ```

2. **Normalize User Path:**  
   ```ts
   const relativePath = normalizeProjectRelativePath(process.cwd(), './src/service');
   ```

3. **Convert to Graph Path:**  
   ```ts
   const graphPath = toGraphPath(path.join(yggRoot, relativePath), yggRoot);
   ```

This sequence ensures that user input is validated, normalized, and correctly mapped into the Yggdrasil graph structure.