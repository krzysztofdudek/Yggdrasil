# Documentation: Context Formatting Utilities

This module provides utility functions for formatting structured context data into human-readable formats. It focuses on two complementary outputs:

1. **YAML representation** of contextual metadata and structure.
2. **Full content section** that embeds file contents in XML-style tags.

These functions are designed to support reporting, debugging, or exporting context information in a consistent and parsable format.

---

## `formatContextYaml`

```ts
export function formatContextYaml(data: ContextMapOutput): string
```

### Purpose
Converts a `ContextMapOutput` object into a YAML string. The output emphasizes **paths-only context** in a compact, default mode suitable for inspection or serialization.

### Behavior
- Extracts key metadata (`token-count`, `budget-status`) and structural information (`project`, `node`, `hierarchy`, `dependencies`, `artifacts`).
- Excludes empty arrays by replacing them with `undefined` and subsequently removing those keys.
- Produces a YAML string with **no line wrapping** (`lineWidth: 0`), ensuring long paths or values remain intact.

### Usage
This function is useful when:
- You need a **lightweight summary** of context without full file contents.
- You want to serialize context for logging, auditing, or exporting to external tools.
- You require a **clean YAML output** without clutter from empty fields.

### Example
```ts
const yamlOutput = formatContextYaml(contextData);
console.log(yamlOutput);
```

Resulting YAML (illustrative):
```yaml
meta:
  token-count: 1200
  budget-status: within-limit
project: my-project
node: src/index.ts
hierarchy:
  - src
  - utils
dependencies:
  - lodash
artifacts:
  - build/output.js
```

---

## `formatFullContent`

```ts
export function formatFullContent(
  files: Array<{ path: string; content: string }>
): string
```

### Purpose
Generates a **full content section** that complements the YAML summary. Each file’s contents are wrapped in XML-style tags named after the file path.

### Behavior
- Returns an empty string if no files are provided.
- Prepends the section with a YAML separator (`---`) to distinguish it from the metadata block.
- Wraps each file’s content in `<path>...</path>` tags, separated by blank lines for readability.

### Usage
This function is useful when:
- You need to **embed raw file contents** alongside metadata for a complete export.
- You want a **structured but human-readable format** for reviewing multiple files.
- You require a **clear separation** between metadata (YAML) and file contents.

### Example
```ts
const files = [
  { path: 'src/index.ts', content: 'console.log("Hello World");' },
  { path: 'README.md', content: '# Project Documentation' },
];

const fullContent = formatFullContent(files);
console.log(fullContent);
```

Resulting output:
```
---

<src/index.ts>
console.log("Hello World");
</src/index.ts>

<README.md>
# Project Documentation
</README.md>
```

---

## Integration Notes
- Typically, `formatContextYaml` is used first to provide a **summary view**, followed by `formatFullContent` for **detailed inspection**.
- The two outputs can be concatenated to form a **complete context export**:
  ```ts
  const report = formatContextYaml(contextData) + formatFullContent(files);
  ```
- This design ensures that consumers can parse metadata separately from file contents while still keeping them in a single unified document.

---

## Key Takeaways
- **`formatContextYaml`**: Produces a concise YAML summary of context metadata and structure.
- **`formatFullContent`**: Appends raw file contents in XML-style tags for completeness.
- Together, they enable **structured, readable, and exportable context reports** suitable for debugging, auditing, or external integration.