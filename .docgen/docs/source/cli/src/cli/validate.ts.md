```markdown
# `registerValidateCommand` Function Documentation

## Purpose
Registers a CLI command (`validate`) to verify the structural integrity and completeness of a graph. It scans nodes, identifies issues, and reports errors or warnings with detailed diagnostics.

## Usage
This function is intended to be integrated into a `commander.js` program. It adds a `validate` command that can be executed from the command line.

### Command Registration
```typescript
import { Command } from 'commander';
import { registerValidateCommand } from './path-to-module';

const program = new Command();
registerValidateCommand(program);
program.parse(process.argv);
```

### Command Execution
```bash
$ your-cli validate [options]
```

## Options
| Option          | Description                                      | Default |
|-----------------|--------------------------------------------------|---------|
| `--scope <scope>` | Specifies the validation scope: `all` or a node path. | `all`   |

## Behavior
1. **Graph Loading**: Loads the graph from the current working directory, tolerating invalid configurations.
2. **Scope Handling**: Normalizes the provided scope, removing leading `./` and trailing slashes. Defaults to `all` if unspecified.
3. **Validation**: Executes validation logic on the graph based on the specified scope.
4. **Issue Reporting**:
   - Outputs the number of nodes scanned.
   - Groups issues into errors and warnings based on severity.
   - Formats and color-codes issues for clarity:
     - Errors: Red (`✗`), prefixed with code and node path (if applicable).
     - Warnings: Yellow (`⚠`), prefixed with code and node path (if applicable).
   - Summarizes the total number of errors and warnings.
5. **Exit Codes**:
   - Exits with code `1` if errors are found or if an exception occurs.
   - Exits with code `0` if no issues are detected.

## Error Handling
- Catches and logs exceptions to `stderr` with a generic error message, ensuring the process exits with code `1`.

## Example Output
```plaintext
10 nodes scanned

✗ ERR_001 node-a -> Missing required property 'type'
⚠ WARN_001 node-b -> Deprecated attribute 'status'

No issues found.
```

## Dependencies
- `commander`: For CLI command registration.
- `chalk`: For terminal output colorization.
- `loadGraph` and `validate`: Core functions for graph loading and validation.
```