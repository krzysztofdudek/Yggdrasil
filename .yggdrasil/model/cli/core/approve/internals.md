# Approve Internals

## Decisions

- **Three-axis gate separated from LLM reviewer.** `--reviewed` bypasses only the structural gate. Rejected: single `--acknowledge` flag that bypasses both — agents used it to rubber-stamp aspect failures instead of fixing code.

- **Child-wins over parent-wins for mapping overlap.** When a child node maps files that are also under a parent's directory mapping, the child's mapping takes precedence — parent's hash computation excludes child-mapped paths. Rejected: parent-wins (child file changes would trigger drift on parent, making parent approval noisy) and flat model (no overlap allowed — too restrictive for real hierarchies).

- **Anti-laundering on blackbox first-approve.** When approving a blackbox node for the first time, the system prevents files already tracked by other nodes from being silently re-claimed under the new blackbox. Rejected: allowing overlap — files would have two owners with conflicting drift baselines, making drift detection unreliable.

- **yg-node.yaml excluded from own-artifacts axis.** Changes to node metadata (type, relations, aspects) do not trigger the three-axis "artifact changed" gate. Rejected: treating yg-node.yaml as an artifact — every metadata edit would force a corresponding source change, making routine graph maintenance unnecessarily painful.
