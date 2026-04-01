# Templates Unit Tests — Responsibility

Unit tests for template generation modules in `src/templates/`. Verifies command output templates, configuration defaults, platform-specific rules, and project name resolution.

## Scope

- `commands.test.ts` — command output template generation
- `default-config.test.ts` — default `yg-config.yaml` template content
- `platform.test.ts` — platform-specific rules file generation
- `resolve-project-name.test.ts` — project name auto-detection logic

## Out of scope

- I/O parser tests — belongs to `cli/tests/unit/support/io`
- Utility function tests — belongs to `cli/tests/unit/support/utils`
