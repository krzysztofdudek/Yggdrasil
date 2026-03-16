Here’s a comprehensive Markdown documentation for the provided code, focusing on **purpose, usage, and behavior** without restating the obvious implementation details.

---

# Configuration Parser Documentation

## Overview
This module provides functionality to **parse and validate a YAML-based configuration file (`yg-config.yaml`)** into a strongly typed `YggConfig` object. It enforces structural and semantic rules to ensure the configuration is well-formed, consistent, and safe to use within the system.

The parser is designed to:
- Read YAML configuration files asynchronously.
- Validate required fields (`name`, `node_types`, `artifacts`).
- Enforce constraints on artifact requirements and node type definitions.
- Apply default values for quality settings when not explicitly defined.
- Provide clear error messages for invalid or missing configuration entries.

---

## Key Concepts

### Configuration Structure
The configuration file must define the following top-level sections:

- **`version`** (optional): A string identifier for the configuration version.
- **`name`** (required): A non-empty string naming the configuration.
- **`node_types`** (required): A non-empty object mapping node type names to their definitions.
- **`artifacts`** (required): A non-empty object mapping artifact names to their definitions.
- **`quality`** (optional): Rules governing artifact length, relation limits, and context budgets.

### Defaults
If `quality` is not provided, the parser applies a built-in default:

```yaml
quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
    own_warning: null
```

---

## Validation Rules

### General
- The file must be a valid YAML mapping (not empty, not an array).
- `name` must be a non-empty string.
- Reserved artifact names (e.g., `yg-node.yaml`) are disallowed.

### Node Types
Each node type must:
- Include a non-empty `description` string.
- Optionally define `required_aspects` as a non-empty array of strings.

Invalid node type definitions trigger descriptive errors.

### Artifacts
Each artifact must:
- Define a `required` field with one of:
  - `"always"`
  - `"never"`
  - An object with a valid `when` condition:
    - `has_incoming_relations`
    - `has_outgoing_relations`
    - `has_aspect:<name>`
    - `has_tag:<name>`
- Optionally include:
  - `description` (string)
  - `included_in_relations` (boolean)

Artifacts with invalid `required` conditions or reserved names cause parsing errors.

### Quality
- `error` budget must be greater than or equal to `warning`.
- `own_warning`, if defined, must be a positive number.

---

## Function: `parseConfig`

```ts
export async function parseConfig(filePath: string): Promise<YggConfig>
```

### Purpose
Reads and validates a YAML configuration file, returning a fully structured `YggConfig` object with defaults applied where necessary.

### Parameters
- `filePath`: Path to the YAML configuration file.

### Returns
- A validated `YggConfig` object containing:
  - `version`
  - `name`
  - `node_types`
  - `artifacts`
  - `quality`

### Errors
Throws descriptive `Error` messages when:
- The file is empty or not a valid YAML mapping.
- Required fields are missing or invalid.
- Node type or artifact definitions violate constraints.
- Quality settings are inconsistent.

---

## Example Usage

```ts
import { parseConfig } from './config/parser.js';

async function main() {
  try {
    const config = await parseConfig('./yg-config.yaml');
    console.log('Configuration loaded:', config);
  } catch (err) {
    console.error('Failed to load configuration:', err.message);
  }
}

main();
```

---

## Behavior Summary
- Ensures **strict validation** of configuration structure.
- Provides **clear error feedback** for misconfigured files.
- Applies **sensible defaults** for quality settings.
- Produces a **typed, reliable configuration object** ready for downstream use.

---

Would you like me to also create a **sample `yg-config.yaml` file** that passes all these validation rules, so you can see how a valid configuration looks in practice?