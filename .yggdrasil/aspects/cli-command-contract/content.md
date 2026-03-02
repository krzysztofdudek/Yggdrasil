# CLI Command Contract

Every CLI command handler follows these conventions:

## Output routing

- Results to stdout via `process.stdout.write()`. Never `console.log`.
- Errors exclusively to stderr via `process.stderr.write()`.
- Chalk color semantics: green = ok/success, red = error/failure, yellow = warning, dim = suppressed/hidden.

## Error handling

- Every command action body is wrapped in try/catch.
- Catch block: `process.stderr.write(`Error: ${(error as Error).message}\n`)` then `process.exit(1)`.
- ENOENT from loadGraph: special message `Error: No .yggdrasil/ directory found. Run 'yg init' first.`

## Exit codes

- `process.exit(1)` on failure (thrown error).
- `process.exit(1)` on actionable state (drift found, validation errors, pending journal).
- Implicit exit 0 when no issues. Warnings alone do not trigger exit 1.

## Graph loading

- Commands requiring graph state start with `await loadGraph(process.cwd())`.
- Journal-only commands use `await findYggRoot(process.cwd())` instead.

## Node path normalization

- Commands accepting `--node <path>` normalize with: `options.node.trim().replace(/\/$/, '')`.
