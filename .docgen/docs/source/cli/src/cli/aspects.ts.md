```markdown
# `registerAspectsCommand` Documentation

## Purpose
Registers a CLI command to list aspects with their metadata in YAML format. The command retrieves aspect data from a loaded graph and outputs it in a structured, sorted manner.

## Usage
This function is intended to be integrated into a Commander.js program. When invoked via the `aspects` command, it processes the graph data and outputs aspect metadata.

### Command Registration
```typescript
registerAspectsCommand(program);
```

### CLI Invocation
```bash
yg aspects
```

## Behavior
1. **Root Directory Detection**: Locates the `.yggdrasil` root directory using `findYggRoot`. If not found, exits with an error message prompting initialization via `yg init`.
2. **Graph Loading**: Loads the graph data from the root directory using `loadGraph`.
3. **Aspect Processing**:
   - Sorts aspects alphabetically by `id`.
   - Maps each aspect to a simplified object containing:
     - `id` and `name` (required).
     - `description`, `implies`, and `stability` (if present).
4. **Output**: Serializes the processed aspects to YAML and writes to `stdout`.
5. **Error Handling**:
   - Catches `ENOENT` errors (missing `.yggdrasil` directory) and provides a specific error message.
   - Logs other errors with their generic message and exits with code `1`.

## Output Format
YAML-formatted list of aspects, e.g.:
```yaml
- id: aspect1
  name: Aspect One
  description: Sample description
  implies: [aspect2]
  stability: stable
- id: aspect2
  name: Aspect Two
```

## Dependencies
- `commander`: CLI framework.
- `yaml`: YAML serialization.
- Internal utilities: `findYggRoot`, `loadGraph`.
```