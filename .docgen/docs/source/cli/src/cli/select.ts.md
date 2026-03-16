```markdown
# `registerSelectCommand` Documentation

## Purpose
Registers a CLI command (`select`) to find and return graph nodes relevant to a given task description. The command integrates with a graph data structure and uses natural language processing to identify relevant nodes.

## Usage
This function is intended to be used with the `commander` library to extend a CLI program. It adds a `select` command that processes user input, interacts with a graph, and outputs results in YAML format.

### Registration
```typescript
import { Command } from 'commander';
import { registerSelectCommand } from './path-to-module';

const program = new Command();
registerSelectCommand(program);
program.parse(process.argv);
```

### Command Syntax
```bash
select --task <description> [--limit <n>]
```

#### Required Options
- `--task <description>`: A natural-language description of the task to find relevant graph nodes.

#### Optional Options
- `--limit <n>`: Maximum number of nodes to return (default: `5`). Must be a positive integer.

## Behavior
1. **Root Directory Detection**: Locates the root directory of the graph (`yggRoot`) from the current working directory.
2. **Graph Loading**: Loads the graph data structure from the detected root directory.
3. **Input Validation**: Ensures the `--limit` option is a positive integer. Exits with an error if invalid.
4. **Node Selection**: Uses the `selectNodes` function to find nodes relevant to the task description, respecting the specified limit.
5. **Output**: Writes the results in YAML format to `stdout`.

### Error Handling
- Invalid `--limit` value: Exits with an error message.
- Graph loading or processing errors: Catches exceptions, logs the error message to `stderr`, and exits with a non-zero status code.

## Dependencies
- `commander`: For CLI command registration and parsing.
- `yaml`: For YAML serialization of results.
- `../core/graph-loader`: Loads the graph data structure.
- `../core/node-selector`: Selects relevant nodes based on the task description.
- `../utils/paths`: Finds the root directory of the graph.

## Example
```bash
$ select --task "Optimize database queries" --limit 3
# Output: YAML-formatted list of up to 3 relevant nodes
```
```