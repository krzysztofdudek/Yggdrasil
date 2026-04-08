# Impact Command Interface

**Command:** `yg impact --node <path> | --file <path> | --aspect <id> | --flow <name>` (mutually exclusive, one required).

**Purpose by variant:**

- **--node / --file:** "What breaks if I change this node?" Shows direct dependents, transitive chains, hierarchy descendants, event-connected nodes, indirect dependents of descendants, co-aspect peers, and participating flows. `--file` resolves to owning node first.
- **--aspect:** "What is affected if I change this aspect's rules?" Shows all nodes where the aspect is effective, with attribution (own, hierarchy, flow, implied), plus indirect structural dependents.
- **--flow:** "What is affected if I change this business process?" Shows all participants (declared + descendants) plus indirect structural dependents.

**Output by variant:**

- **--node / --file:** Sections in order: `Directly dependent` (each prefixed `<- <node> (<rel-type>[, consumes: <ports>])`), `Event-connected` (when present), `Transitively dependent` (chain notation), `Descendants (hierarchy impact)` (when present), `Indirectly affected (structural dependents of descendants)` (when present), `Flows: <names>`, `Aspects: <names>`, `Nodes sharing aspects` (when present), then blast radius line + E021 note + high-blast-radius warning if ≥10.

- **--aspect:** Sections in order: `Directly affected` (each `<node> (<source>)` where source is `own`, `hierarchy from <path>`, `flow: <name>`, or `implied`), `Indirectly affected (structural dependents)` (when present), `Flows propagating this aspect: <names>`, `Implied by: <aspect-ids>`, `Implies: <aspect-ids>`, then blast radius line + E021 note + high-blast-radius warning if ≥10.

- **--flow:** Sections in order: `Participants` (declared nodes plain, descendant nodes suffixed with `(descendant)`), `Indirectly affected (structural dependents)` (when present), `Flow aspects: <aspect-ids>`, then blast radius line + E021 note + high-blast-radius warning if ≥10.

Each variant ends with a blast radius count (total affected nodes, flows, aspects). When ≥10 nodes are affected, a high-blast-radius warning advises reviewing interfaces before proceeding.

## Failure Modes

- No .yggdrasil/ directory: ENOENT, exit 1.
- No mode flag or multiple flags: exit 1.
- Node/aspect/flow not found: error to stderr, exit 1.
- File not mapped (--file): exit 1.
