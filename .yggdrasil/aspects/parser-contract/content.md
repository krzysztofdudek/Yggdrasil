# Parser Contract

All parser adapters in the IO layer follow an identical pipeline regardless of the input format (YAML, JSON, NDJSON, plain text).

## Pipeline

1. Read raw content from disk (via `readTextFile` or equivalent io helper).
2. Parse to an untyped intermediate object (e.g. `parseYaml`, `JSON.parse`).
3. Validate fields manually with explicit type guards (`typeof x !== 'string'`, `!Array.isArray(x)`).
4. On validation failure, report it descriptively (file path + field name) in one of two ways — both are valid, and a single parser may use both:
   - **Field-shape** checks (presence, `typeof`, `Array.isArray`, enum membership) return a structured, aggregatable error result (`{ ok: false; errors: [...] }`), so several independent field errors surface at once (as in `aspect-parser.ts`).
   - A malformed **nested predicate or grammar** delegated to a shared sub-parser (`when:` via `parseWhen`, `implies` via `parseAspectAttachment`) is reported fail-fast by **throwing** — a graph-authoring error, distinct from field-shape validation.

   A parser that throws on the first bad field throughout (e.g. `config-parser.ts`) is equally valid. This split is intentional and consistent across the aspect, node, architecture, and flow parsers.
5. Return a typed domain object (or `{ ok: true; ... }` for result-union parsers).

## Error format

- With path context: `<filename> at <path>: <field description>`
- Config-level: `<filename>: <field description>`
- Result-union parsers: each error in the `errors` array includes `code` (string) and `messageData: IssueMessage` with structured `what`, `why`, `next`.

## Invariants

- No schema-based validation libraries (joi, zod, etc.) — validation is manual and explicit.
- Every required field is checked individually with a clear error message.
- Optional fields use fallback defaults; never throw on absence.
- Parsers never write — they are pure read-transform functions.
- Field-shape validation must return a structured error, never throw; only a malformed grammar delegated to a shared sub-parser (`when:`, `implies`) may throw.
