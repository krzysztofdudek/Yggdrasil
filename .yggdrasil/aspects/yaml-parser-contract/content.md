# YAML Parser Contract

All YAML parsers in the IO layer follow an identical pipeline.

## Pipeline

1. `readFile(filePath, 'utf-8')` -- read raw content
2. `parseYaml(content) as Record<string, unknown>` -- parse to untyped object
3. Manual field validation with explicit type guards (`typeof x !== 'string'`, `!Array.isArray(x)`)
4. Throw descriptive error with file path and field name on validation failure
5. Return typed domain object

## Error format

- With path context: `<filename> at <path>: <field description>`
- Config-level: `<filename>: <field description>`

## Invariants

- No schema-based validation libraries (joi, zod, etc.) -- validation is manual and explicit.
- Every required field is checked individually with a clear error message.
- Optional fields use fallback defaults, never throw on absence.
- Parsers never write -- they are pure read-transform functions.
