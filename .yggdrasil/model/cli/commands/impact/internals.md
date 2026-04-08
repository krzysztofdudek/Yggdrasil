# Impact Command Internals

## Decisions

- **Impact mirrors context assembly.** If changing node X alters Y's context package (via structural or event relations), Y must appear in impact output. Chose propagation to transitive dependents over showing only direct dependents because impact analysis must reflect the true blast radius visible through context assembly. Without propagation, agents would miss nodes whose context packages change due to transitive dependencies.

- **Indirect dependents of descendants.** In --node mode, after collecting hierarchy descendants, we also find their structural dependents. This catches nodes that depend on children of the changed node — a blind spot if only direct and transitive dependents of the target itself were shown.

- **Event-connected tracking.** In --node mode, emits/listens relations are tracked separately from structural relations because they represent a different propagation mechanism. A node that emits an event affects all listeners, and listeners are affected by changes to the emitter — even without a structural dependency.
