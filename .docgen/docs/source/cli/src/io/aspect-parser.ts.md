```markdown
# `parseAspect` Function Documentation

## Purpose
Parses an aspect definition from a YAML file, validates its structure, and returns a normalized `AspectDef` object. Ensures compliance with schema requirements and integrates artifact metadata.

## Usage
```typescript
import { parseAspect } from './aspect-parser';

const aspectDef = await parseAspect(aspectDir, aspectYamlPath, id);
```

## Parameters
- **`aspectDir` (string)**: Base directory containing aspect-related files (e.g., artifacts).
- **`aspectYamlPath` (string)**: Path to the YAML file defining the aspect.
- **`id` (string)**: Unique identifier for the aspect (relative path within `aspects/`).

## Return Value
A `Promise` resolving to an `AspectDef` object with the following structure:
```typescript
{
  name: string;
  id: string;
  description?: string;
  implies?: string[];
  stability?: AspectStability;
  artifacts: Record<string, unknown>[]; // From `readArtifacts`
}
```

## Behavior
1. **ID Validation**:  
   - Trims and checks for non-empty `id`. Throws if invalid.
2. **File Reading**:  
   - Reads the YAML file using `fs/promises`. Throws if unreadable.
3. **YAML Parsing**:  
   - Parses content with `yaml.parse()`. Throws if empty or malformed.
4. **Schema Validation**:  
   - **Name**: Required, non-empty string.  
   - **Description**: Optional, trimmed string.  
   - **Implies**: Must be an array of strings (filtered for type safety).  
   - **Stability**: Must match one of `['schema', 'protocol', 'implementation']`.
5. **Artifact Integration**:  
   - Fetches artifacts via `readArtifacts` for the specified directory and file patterns.
6. **Normalization**:  
   - Trims whitespace from `name` and `id`.  
   - Omits `description`, `implies`, or `stability` if undefined/invalid.

## Error Handling
- Throws `Error` with descriptive messages for:  
  - Empty/invalid `id`.  
  - Missing/malformed YAML structure.  
  - Invalid `name`, `implies`, or `stability` values.

## Dependencies
- `node:fs/promises` for file operations.  
- `yaml` for YAML parsing.  
- `readArtifacts` for artifact metadata retrieval.  
- Type definitions from `../model/types.js`.
```