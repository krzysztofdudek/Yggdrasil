```markdown
# `parseSchema` Function Documentation

## Purpose
Parses a YAML schema file, validates its structure, and extracts the schema type based on the file name.

## Usage
```typescript
import { parseSchema } from './path/to/module';

const schema = await parseSchema('/path/to/schema.yaml');
```

## Behavior
1. **File Reading**: Reads the content of the specified YAML file asynchronously using `readFile`.
2. **YAML Validation**: Attempts to parse the file content using `parseYaml` to ensure it is valid YAML. If parsing fails, an error is thrown.
3. **Schema Type Extraction**:
   - Extracts the file name without the extension.
   - If the file name starts with `yg-`, removes this prefix to determine the schema type.
   - Otherwise, uses the raw file name as the schema type.
4. **Return Value**: Returns an object with a `schemaType` property containing the extracted schema type.

## Parameters
- `filePath` (string): The absolute or relative path to the YAML schema file.

## Return Type
`Promise<SchemaDef>`: A promise resolving to an object with the following structure:
```typescript
{
  schemaType: string;
}
```

## Error Handling
- Throws an error if the file cannot be read or if the YAML content is invalid.
```