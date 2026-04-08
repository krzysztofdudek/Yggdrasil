# Graph Types Responsibility

The foundational vocabulary that every CLI subsystem shares. Separated from context, drift, and validation types because graph model types are stable and universal — they change only when the graph schema evolves. Context/drift/validation types change when their respective subsystems evolve, without affecting the core model.

Graph is the top-level container. GraphNode nests recursively via children/parent, mirroring the filesystem hierarchy under `model/`. NodeMeta captures everything from yg-node.yaml. AspectDef and FlowDef are loaded from their respective directories. The STANDARD_ARTIFACTS constant defines the three hardcoded artifact types and their inclusion rules — this is not configurable because artifact semantics are part of the system's core contract.
