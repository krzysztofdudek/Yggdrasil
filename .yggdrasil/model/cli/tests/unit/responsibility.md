# Unit Tests — Responsibility

Pure function unit tests for every module in `src/`. No filesystem side effects; all I/O is mocked or stubbed.

## Scope

Mirrors the `src/` directory structure:

- `core/` — unit tests for every core library: `approve.test.ts`, `check.test.ts`, `context-builder.test.ts`, `context-files.test.ts`, `dependency-resolver.test.ts`, `drift-detector.test.ts`, `graph-loader.test.ts`, `impact.test.ts`, `migrator.test.ts`, `node-selector.test.ts`, `validator.test.ts`
- `cli/` — unit tests for thin command wrappers: `build-command.test.ts`, `impact.test.ts`, `owner.test.ts`, `which.test.ts`
- `formatters/`, `io/`, `migrations/`, `templates/`, `utils/` — unit tests for their respective modules

## Out of scope

- Multi-layer pipeline testing — belongs to `cli/tests/integration`
- Black-box binary invocation — belongs to `cli/tests/e2e`
- Test input data and sample projects — belongs to `cli/tests/fixtures`
