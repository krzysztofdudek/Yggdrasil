# Support Unit Tests — Responsibility

Parent node for supporting unit tests. Directly covers formatters and migrations; I/O, templates, and utils are delegated to child nodes.

## Directly covered

- `formatters/` — tests for output formatting logic (table, YAML, text renderers)
- `migrations/` — tests for graph migration transformations

## Delegated to children

- I/O parser tests — `cli/tests/unit/support/io`
- Template generation tests — `cli/tests/unit/support/templates`
- Utility function tests — `cli/tests/unit/support/utils`

## Out of scope

- Core library tests — belongs to `cli/tests/unit/core`
- CLI command wrapper tests — belongs to `cli/tests/unit/cli`
