# Impact Command Internals

## Decisions

- **Impact mirrors context assembly.** If changing node X alters Y's context package (via structural or event relations), Y must appear in impact output. Chose propagation to transitive dependents over showing only direct dependents because impact analysis must reflect the true blast radius visible through context assembly. Without propagation, agents would miss nodes whose context packages change due to transitive dependencies.

- **Indirect dependents of descendants.** In --node mode, after collecting hierarchy descendants, we also find their structural dependents. This catches nodes that depend on children of the changed node — a blind spot if only direct and transitive dependents of the target itself were shown.

- **Event-connected tracking.** In --node mode, emits/listens relations are tracked separately from structural relations because they represent a different propagation mechanism. A node that emits an event affects all listeners, and listeners are affected by changes to the emitter — even without a structural dependency.

- **Co-aspect node tracking.** In --node mode, output includes all nodes sharing any effective aspect with the target. Agents need this to know which other nodes must satisfy the same constraints before changing the target. Rejected: omitting co-aspect peers — agents would unknowingly break aspect compliance in sibling nodes.

- **Flow participant expansion to descendants.** In --flow mode, declared participants are automatically expanded to include hierarchy descendants. Rejected: declared participants only — a flow participant's children inherit the flow's aspects and should be visible in blast radius.

- **Shortest-path selection for indirect dependents.** When multiple dependency paths lead to the same indirect node, only the shortest chain is kept. Rejected: showing all paths — noisy output with diminishing diagnostic value per additional path.
