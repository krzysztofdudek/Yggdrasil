---
title: Configuration
---

Everything here is optional except the fields required by the schema.
Yggdrasil works out of the box with sensible defaults.

Config file: `.yggdrasil/config.yaml`

---

## Schema

### Required fields

- **name** — Project identity (non-empty string)
- **node_types** — Non-empty array of node types. Each element is a string (e.g. `module`, `service`) or an object `{ name, required_aspects? }`. `required_aspects` lists aspects that nodes of this type must have coverage for (directly or via aspect `implies`).
- **artifacts** — Non-empty object defining artifact types and their requirements

### Optional fields

- **stack** — Key-value metadata (e.g. `language`, `runtime`)
- **standards** — Project standards text (e.g. coding conventions)
- **quality** — Quality thresholds

---

## What you can customize

- **Node types** — The vocabulary of parts your repo uses (e.g. `module`, `service`, `library`). Optionally, each type can declare `required_aspects` — aspects that nodes of that type must have coverage for (directly or via aspect composition).
- **Artifacts** — The kinds of meaning you want to capture per node. Each artifact has:
  - `required`: `always` | `never` | `{ when: "<condition>" }`
    - Supported `when` conditions: `has_incoming_relations`, `has_outgoing_relations`, `has_aspect:<name>` (legacy `has_tag:<name>` also accepted)
  - `description`: string
  - `structural_context`: boolean — When `true`, this artifact is included in the context package of dependent nodes (via structural relations like uses, calls, extends, implements). Default artifacts with this flag: `responsibility.md`, `interface.md`, `constraints.md`, `errors.md`.
- **Quality thresholds** — When to warn about shallow memory or large context

---

## Quality config

| Field | Default | Description |
|-------|---------|-------------|
| `min_artifact_length` | 50 | Minimum chars for artifact content (shallow warning) |
| `max_direct_relations` | 10 | Max relations before high fan-out warning |
| `context_budget.warning` | 10000 | Token count warning threshold |
| `context_budget.error` | 20000 | Token count error threshold |

---

## Example

```yaml
name: my-repo

stack:
  language: TypeScript
  runtime: Node.js 22+

standards: |
  Strict TypeScript. ESM modules. Vitest for tests.

node_types:
  - module
  - service
  - library

artifacts:
  responsibility.md:
    required: always
    description: "What this node is responsible for, and what it is not"
    structural_context: true
  interface.md:
    required:
      when: has_incoming_relations
    description: "Public API — methods, parameters, return types, contracts"
    structural_context: true
  logic.md:
    required: never
    description: "Algorithmic flow, control flow, branching logic, decision trees"
  constraints.md:
    required: never
    description: "Validation rules, business rules, invariants"
    structural_context: true
  errors.md:
    required:
      when: has_incoming_relations
    description: "Failure modes, edge cases, error conditions, recovery behavior"
    structural_context: true
  model.md:
    required: never
    description: "Data structures, schemas, entities, type definitions"
  state.md:
    required: never
    description: "State machines, lifecycle, transitions"
  decisions.md:
    required: never
    description: "Local design decisions and rationale"

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
```

---

## Notes

- Artifact name `node.yaml` is reserved.
- `config.yaml: quality.context_budget.error` must be >= `context_budget.warning`.
