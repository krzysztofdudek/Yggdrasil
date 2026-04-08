# Approve Internals

## Decisions

Chose to split three-axis gate from reviewer gate. `--reviewed` bypasses the structural check only. Rejected: single `--acknowledge` that bypasses both gates — agents used it to rubber-stamp aspect failures (the "deterministic" incident where an agent used --acknowledge to bypass E055 instead of fixing the graph).

Chose child-wins model for parent/child mapping overlap: child's mapping takes precedence, parent's hash computation excludes child-mapped paths. This prevents a child-owned file change from triggering drift on the parent.
