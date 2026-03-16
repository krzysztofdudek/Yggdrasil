# Context Package Builder

This module provides functionality to construct a comprehensive context package for a given node in a graph, aggregating relevant information from various sources.

## `buildContext` Function

**Purpose:**
Constructs a `ContextPackage` for a specified node in the graph, aggregating information from global, hierarchical, relational, and aspect-based contexts.

**Usage:**
```typescript
const contextPackage = await buildContext(graph, nodePath);
```

**Behavior:**
1. **Global Layer:** Adds project-level configuration.
2. **Hierarchy Layer:** Collects artifacts from ancestors, filtered by configuration.
3. **Own Layer:** Includes the node's own artifacts and `yg-node.yaml`.
4. **Relational Layer:** Adds structural and event-based dependencies, excluding ancestors.
5. **Flow Layer:** Includes flows the node participates in.
6. **Aspect Layer:** Aggregates aspects from all layers, resolving implications.

**Returns:**
A `ContextPackage` containing layers, sections, mapping, and token count.

## `collectParticipatingFlows` Function

**Purpose:**
Identifies flows that involve the given node or its ancestors.

**Usage:**
```typescript
const flows = collectParticipatingFlows(graph, node);
```

**Behavior:**
Collects flows where the node or any of its ancestors are listed as participants.

## `expandAspects` Function

**Purpose:**
Expands aspect IDs to include all implied aspects recursively, detecting cycles.

**Usage:**
```typescript
const expandedIds = expandAspects(aspectIds, aspects);
```

**Behavior:**
Traverses the aspect implication graph, ensuring uniqueness and cycle detection.

## `resolveAspects` Function

**Purpose:**
Resolves aspect IDs to their corresponding `AspectDef` objects, including implied aspects.

**Usage:**
```typescript
const aspectDefs = resolveAspects(aspectIds, aspects);
```

**Behavior:**
Combines `expandAspects` and aspect definition lookup, filtering out undefined results.

## Layer Builder Functions

**Purpose:**
Constructs individual context layers (global, hierarchy, own, relational, event, aspect, flow).

**Usage:**
```typescript
const layer = buildGlobalLayer(config);
```

**Behavior:**
Each function formats content and metadata for a specific layer type, adhering to configuration rules.

## `buildSections` Function

**Purpose:**
Organizes layers into sections for structured output.

**Usage:**
```typescript
const sections = buildSections(layers, mapping);
```

**Behavior:**
Groups layers by type (global, hierarchy, own, aspects, relational) and includes materialization targets if mapping is provided.

## `collectAncestors` Function

**Purpose:**
Retrieves all ancestors of a node in hierarchical order.

**Usage:**
```typescript
const ancestors = collectAncestors(node);
```

**Behavior:**
Traverses the parent chain, returning ancestors from root to immediate parent.

## `collectDependencyAncestors` Function

**Purpose:**
Collects ancestor information for dependency nodes, filtered by configuration.

**Usage:**
```typescript
const ancestors = collectDependencyAncestors(target, config, graph);
```

**Behavior:**
Aggregates ancestor details, including aspects and artifacts, based on configuration filters.

## `computeBudgetBreakdown` Function

**Purpose:**
Calculates token-based budget breakdown for a context package.

**Usage:**
```typescript
const breakdown = computeBudgetBreakdown(pkg, graph);
```

**Behavior:**
Estimates tokens for each layer type and includes dependency ancestor artifacts, categorizing costs.

## `toContextMapOutput` Function

**Purpose:**
Converts a `ContextPackage` to a context map output format.

**Usage:**
```typescript
const output = toContextMapOutput(pkg, graph);
```

**Behavior:**
Transforms package data into a structured output, including metadata, node details, hierarchy, dependencies, artifacts, and budget status.

## `buildArtifactRegistry` Function

**Purpose:**
Constructs an artifact registry for the context map.

**Usage:**
```typescript
const registry = buildArtifactRegistry(node, ancestors, dependencies, graph);
```

**Behavior:**
Aggregates artifact paths for nodes, aspects, and flows, ensuring deduplication and configuration adherence.

## `collectEffectiveAspectIds` Function

**Purpose:**
Computes effective aspect IDs for a node, including own, hierarchy, flow, and implied aspects.

**Usage:**
```typescript
const aspectIds = collectEffectiveAspectIds(graph, nodePath);
```

**Behavior:**
Traverses the node's hierarchy and flows, expanding aspect implications to determine the complete set of effective aspects.