## Interface

### `registerCheckCommand(program: Command): void`

Registers the `check` subcommand on the Commander program. Takes no options. When invoked:

1. Loads the graph from cwd (tolerating invalid config)
2. Runs `git ls-files .` to get git-tracked files (null if git unavailable)
3. Calls `runCheck(graph, gitFiles)` from `cli/core/check`
4. Formats and prints the result to stdout
5. Exits 0 on pass, 1 on any error

### Output format

```
<ProjectName> — <N> nodes (<types>), <A> aspects, <F> flows
Coverage: <covered>/<total> source files (<pct>%)
Health: <score>/100

Errors (<N>):

  Drift:
  E020 <node> — <subtype>
       <message lines>

  Cascade:
  E021 <node> — cascade drift
       <message lines>

  Cascade summary: <N> upstream change(s) → <N> cascaded node(s)
    <cause> → <nodes>

  Structural:
  ...

  Architecture:
  E050-E054 <node> — <rule>
       <message lines>

  Coverage:
  ...

  Completeness:
  ...

Warnings (<N>):
  ...

Result: PASS|FAIL (<categories> — <N> errors, <N> warnings)

Next: <suggested command>
     <workflow anchor — e.g., "1 of N drifted nodes — post-modify workflow">
```

Warnings are always shown regardless of whether errors are present.

### Failure modes

- Graph load failure: writes to stderr and exits 1

- Git unavailable: proceeds without E022 (coverage check skipped)
