## `collectTrackedFiles` — Purpose and Conceptual Role

`collectTrackedFiles` determines **every file that should be considered part of a node’s “context footprint”** for drift‑detection. Instead of producing rendered context (as the build‑context pipeline does), it returns **paths to the underlying files** that influence or are influenced by the node.

This function is intentionally **synchronous** and **purely graph‑driven**: it never touches the filesystem. All information comes from the in‑memory `Graph` model.

The output is a list of `{ path, category }` pairs, where:

- **`graph`** files originate from Yggdrasil’s internal model (nodes, aspects, flows).
- **`source`** files originate from the project’s own codebase via mapping rules.

The result is the canonical input for **bidirectional drift detection**, ensuring that any change in either source files or graph files can be traced back to the node that depends on them.

---

## High‑Level Behavior

`collectTrackedFiles` walks through **six dependency dimensions**, each mirroring a part of the build‑context traversal:

1. **Own node files**  
2. **Ancestor node files**  
3. **Aspect files** (including recursive implied aspects)  
4. **Relational dependencies** (structural and event relations)  
5. **Flow participation**  
6. **Source‑mapping paths**

Each dimension contributes additional tracked files, and the function deduplicates them using a `Set`.

---

## Output Structure

Each returned entry has the shape:

```ts
interface TrackedFile {
  path: string;        // project-root-relative path
  category: DriftCategory; // 'source' | 'graph'
}
```

Paths are always normalized to forward slashes and are relative to the project root, not the `.yggdrasil` directory.

---

## Dependency Dimensions in Detail

### 1. Own Node Files
For the node itself, the function includes:

- `model/<node.path>/yg-node.yaml`
- Any artifacts whose filenames appear in `graph.config.artifacts`

This ensures only **config‑permitted artifacts** are tracked.

---

### 2. Ancestor Node Files
Ancestors are collected via `collectAncestors(node)`.

For each ancestor, the same rule applies as for the node itself:

- Include `yg-node.yaml`
- Include config‑permitted artifacts

This captures **hierarchical inheritance** of behavior and configuration.

---

### 3. Aspect Files (including implied aspects)
Aspect resolution follows the same logic as build‑context:

- Collect aspect IDs from:
  - the node
  - its ancestors
  - flows the node participates in
- Resolve recursive `implies` relationships via `resolveAspects`

For each resolved aspect:

- Add `aspects/<aspect.id>/yg-aspect.yaml`
- Add all aspect artifacts

This ensures that **all behavior implied by aspects** is tracked, even if indirectly inherited.

---

### 4. Relational Dependencies

#### Structural Relations (`uses`, `calls`, `extends`, `implements`)
For each structural relation:

- Identify the target node.
- Determine which artifacts to include:
  - Prefer artifacts marked `included_in_relations` in config.
  - If none exist on the target, fall back to config‑permitted artifacts.
- Also include the same artifact set for **all ancestors of the target**.

This captures **structural coupling** between nodes, ensuring drift in a dependency is visible to dependents.

#### Event Relations (`emits`, `listens`)
Event relations follow similar logic but always use the same artifact filter for:

- the target node
- its ancestors

This captures **event‑driven coupling**.

---

### 5. Flow Participation
A node participates in a flow if the flow lists the node or any of its ancestors.

For each participating flow:

- Add `flows/<flow.path>/yg-flow.yaml`
- Add all flow artifacts

This ensures that **flow‑level behavior** is included in drift detection.

---

### 6. Source Files (mapping paths)
Finally, the function includes all source files referenced by the node’s mapping:

- Mapping paths are normalized via `normalizeMappingPaths`.
- Each path is added with category `'source'`.

This ties the node’s graph definition to the **actual code files** it represents.

---

## Supporting Function: `collectParticipatingFlows`

This helper identifies flows where:

- the node, or
- any ancestor

is listed as a participant.

It returns the subset of `graph.flows` matching this condition. This mirrors the logic used in build‑context and ensures consistent flow propagation.

---

## Key Design Considerations

- **No filesystem access**: All paths are derived from the graph model, ensuring deterministic behavior.
- **Deduplication**: A `Set` ensures each file appears only once, regardless of how many dependency paths reference it.
- **Config‑driven artifact selection**: The function respects `included_in_relations` and other artifact configuration rules.
- **Symmetry with build‑context**: The traversal order and logic intentionally mirror the context builder to guarantee consistent drift detection.

---

If you want, I can also generate a companion diagram or a conceptual flowchart that illustrates the traversal order and dependency layers.