# Approve Core Responsibility

Implements the core approve logic for the `yg approve` command. Records a new drift baseline after reviewing a node's state, enforces the three-axis bilateral change requirement, and blocks blackbox source modifications.

## Scope

- `approveNode(graph, nodePath, options)` — primary entry point. Validates the node exists and has a mapping, then dispatches to first-approve or re-approve logic.
- **First approve**: hashes all tracked files (source + graph artifacts + hierarchy + aspects + dependency interfaces), writes the initial drift baseline. Runs garbage collection of orphaned drift state entries.
- **Re-approve (three-axis decision)**: classifies each changed file into one of three axes:
  - *own artifacts* — `.md` files in the node's artifact directory (changes to `yg-node.yaml` are explicitly excluded from this axis)
  - *source* — files from `mapping.paths`
  - *other tracked* — hierarchy artifacts, aspect content, flow descriptions, dependency interfaces
- **Accept/refuse rules**:
  - Both axes (own + source) changed → `approved`
  - Only one axis changed → `refused` unless `--acknowledge` is provided → `acknowledged`
  - Only other tracked changed (cascade) → `refused` unless `--acknowledge` → `acknowledged`
  - No changes → `no-change` (baseline still recorded)
- **Blackbox enforcement**: if the node is `blackbox: true` and source files changed, approve is unconditionally refused — `--acknowledge` cannot override this. Decomposition into a proper node is required.
- **Anti-laundering check**: on first approve of a blackbox node, refuses if mapped files already appear in drift state of other nodes (prevents hiding already-tracked files under a new blackbox).
- **Garbage collection**: runs `garbageCollectDriftState` on every invocation to remove drift state entries for nodes no longer in the graph.

## Child mapping exclusions

Uses the child-wins model: if a parent node and a child node both map overlapping paths, the child's mapping takes precedence. Parent's hash computation excludes child-mapped paths.

## Out of scope

- CLI output formatting and user-facing error messages (that is `cli/commands/approve`)
- Computing file content hashes (that is `cli/utils`)
- Reading/writing drift state files (that is `cli/io`)
- Determining which files are tracked for a node (that is `cli/core/context-files`)
