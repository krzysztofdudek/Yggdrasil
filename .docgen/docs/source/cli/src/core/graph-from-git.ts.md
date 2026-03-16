# Documentation: `loadGraphFromRef`

## Overview
The `loadGraphFromRef` function provides a mechanism to extract and load a project-specific graph definition (`.yggdrasil`) from a given Git reference. It is designed to work directly with Git repositories, leveraging Git’s archival capabilities to retrieve the state of the `.yggdrasil` directory at a specific commit or ref. This enables inspection or analysis of historical or alternative versions of the graph without altering the working directory.

---

## Purpose
- **Versioned Graph Retrieval**: Allows loading of a graph definition as it existed at a particular Git ref (e.g., `HEAD`, a branch name, or a commit hash).
- **Isolation**: Uses a temporary directory to safely extract and process the graph without polluting the project workspace.
- **Resilience**: Returns `null` if the repository, ref, or `.yggdrasil` directory is unavailable, ensuring graceful failure handling.

---

## Usage
```ts
import { loadGraphFromRef } from './path/to/module';

const graph = await loadGraphFromRef('/path/to/repo', 'main');

if (graph) {
  // Work with the loaded Graph object
} else {
  // Handle missing repo, ref, or graph definition
}
```

### Parameters
- **`projectRoot: string`**  
  Path to the root of the Git repository.
  
- **`ref: string = 'HEAD'`**  
  Git reference to load from. Defaults to `HEAD`.

### Returns
- **`Promise<Graph | null>`**  
  A `Graph` object if successfully loaded, otherwise `null`.

---

## Behavior
1. **Validation of Git Ref**  
   - Executes `git rev-parse` to confirm the provided ref exists in the repository.  
   - If invalid, immediately returns `null`.

2. **Temporary Workspace Creation**  
   - Creates a uniquely named temporary directory under the system’s temp directory.  
   - Ensures isolation and avoids conflicts with existing files.

3. **Archival and Extraction**  
   - Runs `git archive` to package the `.yggdrasil` directory at the specified ref into a tarball.  
   - Extracts the tarball into the temporary directory.

4. **Graph Loading**  
   - Invokes `loadGraph` on the extracted `.yggdrasil` contents.  
   - Returns the resulting `Graph` object if successful.

5. **Cleanup**  
   - Regardless of success or failure, the temporary directory is recursively removed.  
   - Ensures no residual files are left behind.

---

## Error Handling
- **Invalid Git Repository or Ref**: Returns `null` if the repository is not valid or the ref cannot be resolved.
- **Missing `.yggdrasil` Directory**: Returns `null` if the directory does not exist at the given ref.
- **Extraction or Loading Failures**: Any errors during archival, extraction, or graph loading result in `null`.
- **Guaranteed Cleanup**: Temporary directories are always removed, even in error scenarios.

---

## Key Considerations
- **Non-Intrusive**: Does not modify the working directory or checkout refs; operates entirely in a temp workspace.
- **Dependency on Git CLI**: Relies on `git` and `tar` being available in the environment.
- **Security**: Uses `execSync` with controlled commands, but assumes trusted repository input.
- **Performance**: Suitable for occasional graph inspection; repeated calls may incur overhead due to archive/extraction steps.

---

## Practical Applications
- **Historical Analysis**: Load graphs from past commits to compare evolution over time.
- **Branch Comparison**: Inspect graphs from different branches without switching the working directory.
- **Automated Validation**: Integrate into CI/CD pipelines to validate graph consistency across refs.

---

This function is a utility for safely and reliably retrieving versioned graph data from Git, ensuring both robustness and cleanliness in temporary resource management.