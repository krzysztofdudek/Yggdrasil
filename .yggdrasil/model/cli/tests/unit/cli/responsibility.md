# CLI Command Unit Tests — Responsibility

Unit tests for the thin command wrapper modules in `src/cli/`. These test argument parsing and delegation without invoking core logic end-to-end.

## Scope

- `build-command.test.ts` — `yg build-context` command wrapper
- `impact.test.ts` — `yg impact` command wrapper
- `owner.test.ts` — `yg owner` command wrapper
- `which.test.ts` — `yg which` command wrapper

## Out of scope

- Core library tests — belongs to `cli/tests/unit/core`
- Full pipeline tests — belongs to `cli/tests/integration`
- Black-box binary invocation — belongs to `cli/tests/e2e`
