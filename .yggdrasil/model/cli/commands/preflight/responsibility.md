# Preflight Command Responsibility

**In scope:** `yg preflight`. Unified session diagnostic.

- Load graph, detect drift, validate.
- Output unified report with sections:
  - **Drift:** "clean" or "N nodes need attention" with details.
  - **Status:** node count, aspect count, flow count, mapped path count.
  - **Validation:** "clean" or error/warning count with issue codes.
- Exit code: 1 if drifted nodes OR validation errors. Warnings alone -> exit 0.

**Consumes:** loadGraph (cli/core/loader), validate (cli/core/validator), detectDrift (cli/core/drift-detector), findYggRoot, normalizeMappingPaths (cli/utils), Graph (cli/model).

**Out of scope:** Resolving drift (use `yg drift-sync`), fixing validation errors (user fixes).
