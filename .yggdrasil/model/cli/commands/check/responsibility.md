## Responsibility

The `check` command is the unified graph gate for the Yggdrasil CLI. It invokes `runCheck` from `cli/core/check`, formats the output with grouped error categories (drift, cascade, structural, coverage, completeness), and exits with code 1 if any errors are present.

This node is NOT responsible for:

- The logic of drift detection, validation, or coverage scanning (that is in `cli/core/check`)
- Loading the graph from disk (that is in `cli/core/loader`)
- Computing git-tracked files beyond calling `git ls-files` via execSync
