# Documentation for `parseNodeYaml` and Supporting Utilities

This module provides a structured, defensive parser for `yg-node.yaml` files. Its purpose is to convert loosely typed YAML metadata into a validated, normalized `NodeMeta` object used by the broader system. The parser enforces schema rules, rejects malformed input early, and ensures consistent downstream behavior.

---

## Overview

A valid `yg-node.yaml` describes a *node* in a dependency or architecture graph. The parser focuses on three responsibilities:

- **Validation** — Reject incomplete or inconsistent YAML structures with precise error messages tied to the file path.
- **Normalization** — Trim strings, remove empty arrays, and convert optional fields into predictable shapes.
- **Extraction** — Produce a `NodeMeta` object containing name, type, relations, aspects, and mapping information.

The module does not attempt to infer missing data or auto-correct invalid structures. Its design favors explicitness and early failure.

---

## `parseNodeYaml(filePath)`

`parseNodeYaml` is the entry point. It reads the YAML file, validates required fields, and delegates to specialized parsers for each section.

### Purpose

- Convert raw YAML into a strongly typed `NodeMeta`.
- Ensure the file contains a valid `name` and `type`.
- Parse optional sections (`relations`, `mapping`, `aspects`) only when present and valid.

### Behavior

- Reads the file as UTF‑8.
- Parses YAML into a plain object.
- Validates that the root is a mapping.
- Ensures `name` and `type` are non-empty strings.
- Delegates to:
  - `parseRelations`
  - `parseMapping`
  - `parseAspects`
- Returns a normalized `NodeMeta` object:
  - Empty optional sections are omitted rather than included as empty arrays.
  - `blackbox` defaults to `false`.

---

## Relation Parsing

### `parseRelations(raw, filePath)`

Relations describe directed edges between nodes, each with a specific semantic type.

### Purpose

- Validate each relation entry.
- Ensure relation types belong to a controlled vocabulary.
- Normalize optional fields.

### Behavior

- Accepts only arrays; anything else is an error.
- Each relation must include:
  - `target` — non-empty string
  - `type` — one of the allowed relation types
- Optional fields:
  - `consumes` — filtered to valid strings
  - `failure` — string
  - `event_name` — trimmed string
- Returns an array; empty input yields an empty array.

### Relation Types

The allowed types are fixed:

```
uses
calls
extends
implements
emits
listens
```

The helper `isValidRelationType` ensures strict membership.

---

## Aspect Parsing

### `parseAspects(raw, filePath)`

Aspects annotate a node with additional semantic tags, each optionally carrying exceptions or anchors.

### Purpose

- Enforce uniqueness of aspect identifiers.
- Validate structure of each aspect entry.
- Normalize optional arrays.

### Behavior

- Accepts only arrays; empty arrays are treated as undefined.
- Each entry must be an object containing:
  - `aspect` — non-empty string
- Rejects duplicate aspect names.
- Optional fields:
  - `exceptions` — array of non-empty strings
  - `anchors` — array of non-empty strings
- Returns `undefined` if no valid aspects remain after filtering.

This ensures that aspects are meaningful and non-redundant.

---

## Mapping Parsing

### `parseMapping(rawMapping, filePath)`

Mapping describes how a node corresponds to files or directories in the repository.

### Purpose

- Support a unified format based on `paths`.
- Validate that paths are relative and non-empty.

### Behavior

- Accepts only objects; anything else yields `undefined`.
- Recognizes only the unified format:
  - `paths` — non-empty array of strings
- Each path is validated by `validateRelativePath`:
  - Must not be absolute.
  - Must not be empty after trimming.
- Rejects legacy or partial formats (`type`, `path`, or malformed `paths`).

If no valid mapping is present, the function returns `undefined`.

---

## Path Validation

### `validateRelativePath(pathValue, filePath, fieldName)`

Ensures that paths in the mapping section are safe and consistent.

### Behavior

- Trims whitespace.
- Rejects empty strings.
- Rejects absolute paths (those starting with `/`).
- Returns the normalized path.

This prevents accidental leakage of absolute filesystem paths and enforces repository-relative conventions.

---

## Design Considerations

- **Strictness**: The parser errs on the side of rejecting ambiguous or malformed input. This prevents subtle downstream bugs.
- **Normalization**: Trimming and filtering ensure that consumers of `NodeMeta` do not need to handle empty strings or empty arrays.
- **Clarity**: Error messages always include the file path and the specific offending field, making debugging straightforward.
- **Predictability**: Optional sections are omitted entirely when empty, simplifying checks in consuming code.

---

If you want to extend this documentation with examples of valid and invalid YAML files, I can prepare those as well.