Below is comprehensive Markdown documentation tailored to the purpose, behavior, and usage of the `status` command registration function. It avoids restating obvious language‑level details and instead focuses on what the command *does*, why it exists, and how it interprets the graph model.

---

# `registerStatusCommand`

Registers the `status` command in a Commander‑based CLI.  
The command provides a diagnostic summary of the currently loaded graph, combining structural statistics, drift analysis, validation results, and several quality metrics.

---

## Purpose

The `status` command is designed to give users a quick, information‑dense overview of the state of their graph model. It consolidates data from multiple subsystems—graph loading, drift detection, validation, artifact mapping, and aspect resolution—into a single textual report. This makes it useful for:

- Assessing the completeness and health of a graph.
- Identifying structural hotspots (e.g., nodes with unusually high relation counts).
- Detecting drift between source code and the graph definition.
- Evaluating documentation and artifact coverage.
- Understanding how well aspects and mappings are applied across nodes.

---

## Command Registration

```ts
export function registerStatusCommand(program: Command): void
```

Adds a `status` subcommand to the provided Commander `program`.  
The command takes no arguments and prints its results directly to `stdout`.

---

## Behavior Overview

When executed, the command performs the following high‑level steps:

### 1. Load the Graph
The graph is loaded from the current working directory.  
All subsequent metrics derive from this in‑memory representation.

### 2. Summarize Node Types
The command counts nodes by their declared `meta.type`.  
It also tracks how many nodes are marked as *blackbox*, which often represent external or opaque components.

### 3. Analyze Relations
Relations are categorized into:

- **Structural relations** (`uses`, `calls`, `extends`, `implements`)
- **Event relations** (everything else)

Additional relation metrics include:

- The node with the highest number of outgoing relations.
- Average relations per node.

This helps identify coupling patterns and potential architectural hotspots.

### 4. Count Flows and Aspects
The command reports:

- Total number of flows defined in the graph.
- Total number of aspects.
- How many nodes have at least one effective aspect applied.

Aspect coverage is a useful indicator of how well cross‑cutting concerns are modeled.

### 5. Drift Detection
`detectDrift` evaluates discrepancies between:

- Source code and graph definitions.
- Graph definitions and materialized artifacts.

The output includes counts for:

- Source drift  
- Graph drift  
- Full drift  
- Missing artifacts  
- Unmaterialized artifacts  
- OK (no drift)

These metrics help identify where the graph is out of sync with reality.

### 6. Validation Results
The command runs full validation (`validate(graph, 'all')`) and reports:

- Number of errors
- Number of warnings

This provides a quick health check of rule compliance.

### 7. Artifact Coverage
The command evaluates how many artifact “slots” are filled.  
A slot exists for each combination of:

- Node  
- Configured artifact type  

It reports:

- Total slots
- Filled slots
- Percentage filled

This indicates how complete the artifact documentation is.

### 8. Mapping Coverage
Nodes with at least one normalized mapping path are counted.  
This shows how many nodes are linked back to source code or external references.

### 9. Output Formatting
All results are written directly to `stdout` in a structured, human‑readable format.  
Errors are written to `stderr`, and the process exits with code `1` on failure.

---

## Example Output (Conceptual)

```
Graph: ExampleGraph
Nodes: 42 (10 services, 20 modules, 12 entities) + 3 blackbox
Relations: 58 structural, 17 event
Aspects: 5    Flows: 12
Drift: 2 source-drift, 1 graph-drift, 0 full-drift, 3 missing, 0 unmaterialized, 36 ok
Validation: 1 errors, 4 warnings

Quality:
  Artifacts: 60/84 slots filled (71%) — 2 types × 42 nodes
  Relations: avg 1.8/node, max 7 (src/components/user.js)
  Mapping: 38/42 nodes mapped to source
  Aspects: 30/42 nodes have aspect coverage
```

This illustrates the type of insight the command provides without tying it to any specific graph.

---

## Usage

Once registered, the command is available through the CLI:

```
your-cli status
```

It requires no arguments and always operates on the graph rooted at the current working directory.

---

## When to Use This Command

Use `status` when you need:

- A quick architectural snapshot.
- A pre‑commit or CI check for drift or validation issues.
- Insight into documentation or artifact completeness.
- A way to identify nodes that may require refactoring or additional modeling.

---

If you'd like, I can also generate companion documentation for the underlying subsystems (`drift-detector`, `validator`, `context-builder`, etc.) to create a cohesive documentation suite.