# Graph Navigation Flow

## Business context

Agent or user needs to locate elements in the graph: find which node owns a file, or browse the hierarchy. These are navigational queries that answer "where is it?" and "what is the structure?"

## Trigger

User runs `yg owner --file <path>` or `yg tree [--root <path>]`.

## Goal

Provide structural navigation of the graph — locating nodes and visualizing hierarchy.

## Participants

- `cli/commands/owner` — resolves file path to owning node via mapping comparison
- `cli/commands/tree` — renders graph hierarchy as tree with metadata
- `cli/core/loader` — loads graph from `.yggdrasil/`

## Paths

### Happy path (owner)

Graph loads; file path is normalized and compared against node mappings. Output: file → node path or "no graph coverage".

### Happy path (tree)

Graph loads; hierarchy rendered from root or subtree. Output: indented tree with node types, aspects, relation counts.

### Node/path not found

`tree --root <invalid>`: exit 1 "path not found". `owner --file <valid-but-unmapped>`: "no graph coverage" (not an error).

## Invariants across all paths

- Read-only: navigation never modifies the graph.
- Deterministic: same graph state → same output.
