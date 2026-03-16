```markdown
# getLastCommitTimestamp

## Purpose
Retrieves the Unix timestamp (in seconds) of the last commit affecting a specified file or directory within a Git repository. Returns `null` if the path is not part of a Git repository or has no associated commits.

## Usage
```typescript
import { getLastCommitTimestamp } from 'your-module';

const projectRoot = '/path/to/project';
const relativePath = 'src/file.js';
const timestamp = getLastCommitTimestamp(projectRoot, relativePath);
```

## Behavior
- **Input Validation**: Accepts a `projectRoot` (absolute path to the Git repository) and a `relativePath` (relative to `projectRoot`).
- **Path Normalization**: Normalizes the `relativePath` to ensure consistent formatting across platforms and replaces backslashes with forward slashes.
- **Git Command Execution**: Runs `git log -1 --format=%ct -- "<normalized_path>"` in the specified `projectRoot` to fetch the timestamp of the last commit affecting the path.
- **Error Handling**: Returns `null` if:
  - The `projectRoot` is not a Git repository.
  - The `relativePath` has no associated commits.
  - Any other error occurs during command execution.
- **Output**: Returns the Unix timestamp as a number if successful, or `null` otherwise.

## Parameters
- `projectRoot` (string): Absolute path to the root of the Git repository.
- `relativePath` (string): Path relative to `projectRoot` to check for the last commit.

## Returns
- `number | null`: Unix timestamp in seconds if a commit is found; otherwise, `null`.
```