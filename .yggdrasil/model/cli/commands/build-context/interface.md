# Build Context Command Interface

**Command:** `yg context --node <path>` or `yg context --file <path>` (mutually exclusive, one required). Also available as `yg build-context` (backward-compatible alias).

**Output contract:** Two modes produce different output shapes by design. `--node` returns the full context package (hierarchy, aspects, flows, dependencies, budget) — everything needed to understand a module before working on it. `--file` returns a narrow view (owning node, applicable aspects, consumed dependencies) — just enough to verify compliance before editing a single file. The owner resolution `<file> -> <node>` goes to stderr so agents can capture it separately from the context output on stdout.

**Validation gate:** Context is never assembled from a structurally broken graph. When errors affect the node's context scope (own node, ancestors, relation targets), output is blocked with a listing of the errors. Unrelated errors are deliberately ignored — an agent shouldn't be blocked from working on module A because module B has a broken YAML.

**Unmapped file handling:** When `--file` targets an unmapped file, the command looks for candidate nodes (other mapped files in the same directory) to suggest where the file might belong.

## Output Format

Both modes produce structured plain text (not YAML or JSON) to stdout.

**--node output sections (in order):**

```
<node-path> [— <description>] (<type>)

Source files (<count>):
  <file-path>
  ...

Must satisfy (<count> aspect[s]):

  <aspect-id> — <description>
    Source: <own | hierarchy from <path> | flow: <name>>
    Verified against: <file-path>
    Implies: <aspect-id>, ...   ← present only when aspect implies others

Participates in (<count> flow[s]):
  <flow-id> — <description>
    read: <path>

Dependencies (<count>):
  <node-path> (<relation-type>) [— <description>] [— consumes: <port>, ...]
    Required: <aspect-id>   ← present only when port requires aspects
    read: <interface-file-path>

Dependents (<count>):
  [<dep-path>                               ← listed individually when ≤5]
  [Moderate/HIGH blast radius message]      ← shown when ≥6
  Run: yg impact --node <path>

Parent: <parent-path> (<type>)
  read: <artifact-path>

Artifacts:
  read: <responsibility-path>
  read: <interface-path>
  read: <internals-path>

Token budget: <current> / <limit> (<status>)

After modifying source files in this node: update artifacts, run yg check, then yg approve --node <path>
```

**--file output sections (in order):**

```
<file-path>
  Owner: <node-path> (<type>)

Must satisfy:

  <aspect-id> — <description>
    Verified against: <file-path>
    Source: <implied-from>   ← present only for implied aspects

Dependencies consumed:
  <node-path> — <consumed-item>, ...

Dependents: <count> nodes — run yg impact --file <file-path>

Node context: run yg context --node <node-path>
```

The owner resolution line (`<file> -> <nodePath>`) goes to stderr so agents can capture it separately.

## Failure Modes

- No .yggdrasil/ directory: exit 1.
- Neither --node nor --file: exit 1 with what/why/next guidance.
- Both --node and --file: exit 1 with what/why/next guidance (mutually exclusive).
- File unmapped, no candidates: exit 1 with what/why/next guidance suggesting node creation.
- File unmapped, candidates found: exit 1 listing candidate nodes from same directory with file counts.
- File in blackbox node: exit 1 with what/why/next guidance to decompose the blackbox.
- Validation errors in scope: exit 1 listing relevant errors with what/why/next structure.
