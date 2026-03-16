```markdown
# `parseFlow` Function Documentation

## Purpose
Parses a YAML-based flow definition file (`yg-flow.yaml`) and constructs a `FlowDef` object, validating its structure and content. It also reads associated artifacts from the flow directory.

## Usage
```typescript
import { parseFlow } from './flow-parser';

const flowDir = '/path/to/flow';
const flowYamlPath = path.join(flowDir, 'yg-flow.yaml');

parseFlow(flowDir, flowYamlPath)
  .then(flowDef => console.log(flowDef))
  .catch(error => console.error(error));
```

## Behavior
1. **File Reading**: Reads the `yg-flow.yaml` file asynchronously using `readFile`.
2. **YAML Parsing**: Parses the file content into a JavaScript object using the `yaml` library.
3. **Validation**:
   - Ensures the YAML file is a non-empty object.
   - Validates the presence and format of the `name` field.
   - Ensures `nodes` is a non-empty array of strings.
   - Validates the optional `aspects` field, ensuring it is an array of strings if present.
4. **Artifact Reading**: Reads artifacts from the flow directory using `readArtifacts`.
5. **Flow Definition Construction**: Constructs a `FlowDef` object with the following properties:
   - `path`: Base name of the flow directory.
   - `name`: Trimmed flow name from the YAML file.
   - `nodes`: Array of node paths.
   - `aspects`: Array of aspect tags (if defined).
   - `artifacts`: List of artifacts read from the directory.

## Error Handling
Throws specific errors for:
- Invalid YAML structure.
- Missing or empty `name` field.
- Invalid `nodes` array (empty or non-string elements).
- Invalid `aspects` array (non-string elements).

## Dependencies
- `node:fs/promises` for file reading.
- `node:path` for path manipulation.
- `yaml` library for YAML parsing.
- `readArtifacts` function for artifact retrieval.
- `FlowDef` type from the model.

## Returns
A `Promise` resolving to a `FlowDef` object representing the parsed flow definition.
```