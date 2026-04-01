## Logic

# Aspects Command Logic

1. Resolve yggRoot via `findYggRoot`, then load the full graph via `loadGraph`.
2. Sort all loaded aspects alphabetically by `id`.
3. Map each aspect to a plain object: `{ id, name }`, plus optional `description`, `implies` (when non-empty), and `anchors` (when non-empty) fields.
4. Serialize the array to YAML using the `yaml` package's `stringify`.
5. Write the YAML output to stdout.
6. On ENOENT (no `.yggdrasil/` directory), print a specific error directing the user to run `yg init`. All other errors print the error message to stderr and exit 1.
