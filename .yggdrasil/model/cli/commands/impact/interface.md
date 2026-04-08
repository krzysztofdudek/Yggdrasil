# Impact Command Interface

**Command:** `yg impact --node <path> | --file <path> | --aspect <id> | --flow <name>` (mutually exclusive, one required).

**Purpose by variant:**

- **--node / --file:** "What breaks if I change this node?" Shows direct dependents, transitive chains, hierarchy descendants, event-connected nodes, indirect dependents of descendants, co-aspect peers, and participating flows. `--file` resolves to owning node first.
- **--aspect:** "What is affected if I change this aspect's rules?" Shows all nodes where the aspect is effective, with attribution (own, hierarchy, flow, implied), plus indirect structural dependents.
- **--flow:** "What is affected if I change this business process?" Shows all participants (declared + descendants) plus indirect structural dependents.

**Output:** Each variant ends with a blast radius count (total affected nodes, flows, aspects). When ≥10 nodes are affected, a high-blast-radius warning advises reviewing interfaces before proceeding.

## Failure Modes

- No .yggdrasil/ directory: ENOENT, exit 1.
- No mode flag or multiple flags: exit 1.
- Node/aspect/flow not found: error to stderr, exit 1.
- File not mapped (--file): exit 1.
