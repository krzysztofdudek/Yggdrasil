```markdown
# `readArtifacts` Function Documentation

## Purpose
Reads and processes artifact files from a specified directory, filtering based on inclusion and exclusion rules, and returns a sorted list of artifacts.

## Usage
```typescript
import { readArtifacts } from './path/to/file';

const artifacts = await readArtifacts(
  '/path/to/directory',
  ['fileToExclude.yaml'], // Optional: List of files to exclude
  ['fileToInclude.json']  // Optional: List of files to include
);
```

## Parameters
- **`dirPath` (string)**: The directory path to read artifacts from.
- **`excludeFiles` (string[])** (optional, default: `['yg-node.yaml']`): List of filenames to exclude from processing.
- **`includeFiles` (string[])** (optional): List of filenames to include. If provided, only files in this list are processed.

## Behavior
1. **Directory Scanning**: Reads all entries in the specified directory, filtering out non-file entries.
2. **Filtering**:
   - Excludes files listed in `excludeFiles`.
   - If `includeFiles` is provided, only processes files explicitly listed.
3. **File Reading**: Reads the content of each filtered file as UTF-8 text.
4. **Artifact Construction**: Creates an `Artifact` object for each file, containing its filename and content.
5. **Sorting**: Sorts artifacts alphabetically by filename for deterministic output.

## Return Value
- **Promise<Artifact[]>**: A promise resolving to an array of `Artifact` objects, sorted by filename.

## Type Definitions
```typescript
type Artifact = {
  filename: string;
  content: string;
};
```

## Notes
- If both `excludeFiles` and `includeFiles` are used, `includeFiles` takes precedence over `excludeFiles`.
- Empty directories or directories with no matching files return an empty array.
```