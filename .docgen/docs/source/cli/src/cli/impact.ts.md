# Impact Analysis Tool

This module provides functionality to analyze the impact of changes in a software system modeled as a graph. It supports impact analysis for nodes, aspects, and flows, showing reverse dependencies, transitive dependencies, and other relevant relationships.

## Functions

### `collectReverseDependents`
**Purpose:** Collects reverse dependencies for a given target node in the graph.  
**Usage:** Used to identify nodes that directly or indirectly depend on the target node.  
**Behavior:**  
- Builds a reverse adjacency map for structural relationships (`uses`, `calls`, `extends`, `implements`).  
- Returns direct dependents, all dependents (including transitive), and metadata about the relationships.  

### `buildTransitiveChains`
**Purpose:** Constructs transitive dependency chains for a target node.  
**Usage:** Used to visualize how transitive dependencies are connected to the target node.  
**Behavior:**  
- Traverses the reverse dependency graph to build paths from transitive dependents back to the target node.  
- Returns chains of dependencies as strings.  

### `collectDescendants`
**Purpose:** Collects all descendant nodes of a given node in the graph.  
**Usage:** Used to identify nodes that are hierarchically below the target node.  
**Behavior:**  
- Performs a depth-first search to collect all child nodes.  
- Returns a sorted list of descendant paths.  

### `collectIndirectDependents`
**Purpose:** Finds indirect dependents of a set of directly affected nodes.  
**Usage:** Used to identify nodes that are indirectly impacted by changes in the directly affected nodes.  
**Behavior:**  
- Builds a reverse adjacency map for structural and event-based relationships.  
- Performs BFS to find the shortest path from indirect dependents to directly affected nodes.  
- Returns indirect paths and the corresponding dependency chains.  

### `runSimulation`
**Purpose:** Simulates the impact of changes on context packages.  
**Usage:** Used to compare the current state of context packages with a baseline (e.g., `HEAD`).  
**Behavior:**  
- Loads a baseline graph from a Git reference.  
- Detects drift in the graph.  
- Computes budget breakdowns and reports changes in context packages.  

### `handleAspectImpact`
**Purpose:** Analyzes the impact of changes in a specific aspect.  
**Usage:** Used to identify nodes and flows affected by changes in an aspect.  
**Behavior:**  
- Collects directly and indirectly affected nodes.  
- Reports propagating flows, implied aspects, and total scope.  
- Optionally runs a simulation for affected nodes.  

### `handleFlowImpact`
**Purpose:** Analyzes the impact of changes in a specific flow.  
**Usage:** Used to identify nodes affected by changes in a flow.  
**Behavior:**  
- Collects participants in the flow and their descendants.  
- Reports indirectly affected nodes and flow aspects.  
- Optionally runs a simulation for affected nodes.  

### `registerImpactCommand`
**Purpose:** Registers a CLI command for impact analysis.  
**Usage:** Provides a command-line interface for analyzing the impact of changes in nodes, aspects, or flows.  
**Behavior:**  
- Validates input options.  
- Delegates to appropriate handlers (`handleAspectImpact`, `handleFlowImpact`, or node-specific analysis).  
- Supports filtering by method and simulation of context package impact.  

## Usage

To use the impact analysis tool, register the `impact` command with a `commander` program instance:

```typescript
import { Command } from 'commander';
import { registerImpactCommand } from './impact-analyzer.js';

const program = new Command();
registerImpactCommand(program);
program.parse(process.argv);
```

Run the command with appropriate options:

```bash
# Analyze impact of changes in a node
node cli.js impact --node path/to/node

# Analyze impact of changes in an aspect
node cli.js impact --aspect aspect-id

# Analyze impact of changes in a flow
node cli.js impact --flow flow-name

# Simulate context package impact
node cli.js impact --node path/to/node --simulate
```

## Behavior

- **Node Impact Analysis:**  
  - Shows direct, transitive, and event-based dependents.  
  - Reports descendants, flows, and aspects in scope.  
  - Optionally filters by method and simulates context package impact.  

- **Aspect Impact Analysis:**  
  - Identifies directly and indirectly affected nodes.  
  - Reports propagating flows, implied aspects, and total scope.  
  - Optionally simulates context package impact.  

- **Flow Impact Analysis:**  
  - Identifies participants and indirectly affected nodes.  
  - Reports flow aspects and total scope.  
  - Optionally simulates context package impact.  

## Error Handling

- Exits with an error if required options are missing or invalid.  
- Handles errors during graph loading or analysis gracefully.  

## Dependencies

- `commander`: For CLI command registration.  
- `graph-loader`, `graph-from-git`, `context-builder`, `drift-detector`: For graph operations and analysis.  
- `types`: For type definitions.  

This documentation provides a comprehensive overview of the module's purpose, usage, and behavior, adhering to the specified guidelines.