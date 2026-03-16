# Graph Validation Module

This module provides a comprehensive validation system for a graph-based model, ensuring structural integrity, adherence to configuration rules, and best practices.

## Purpose

The primary purpose of this module is to validate a given `Graph` object against a set of predefined rules. These rules cover various aspects of the graph, including node types, relations, aspects, artifacts, and more. The validation process helps identify errors, warnings, and potential improvements in the graph structure.

## Usage

The main function `validate(graph, scope)` is the entry point for running validations. It takes a `Graph` object and an optional `scope` parameter to limit the validation to specific nodes.

```typescript
import { validate } from './validator';

const validationResult = await validate(graph, 'specific/node/path');
```

## Behavior

### Validation Rules

The module includes numerous validation rules, each checking a specific aspect of the graph. These rules are categorized into errors and warnings, with corresponding severity levels.

- **Node Types (Rule 0)**: Ensures nodes have valid types defined in the configuration.
- **Relation Targets (Rule 1)**: Verifies that relation targets exist and provides suggestions for similar node paths.
- **Aspects Defined (Rule 2)**: Checks that node aspects reference defined aspects.
- **Aspect IDs (Rule 3)**: Validates aspect IDs derived from directory paths.
- **Aspect ID Uniqueness (Rule 3.1)**: Ensures aspect IDs are unique across aspects.
- **Implied Aspects (Rule 3.2)**: Verifies that implied aspects exist.
- **Aspect Implies Graph (Rule 3.3)**: Detects cycles in the aspect implication graph.
- **Required Aspects Coverage (Rule 3.4)**: Checks that nodes have required aspects based on their type.
- **Circular Dependencies (Rule 4)**: Identifies structural cycles in the graph, tolerating cycles involving blackbox nodes.
- **Mapping Ownership Overlap (Rule 5)**: Detects overlapping mapping paths between nodes.
- **Mapping Paths Existence (Rule 5.1)**: Ensures mapping paths exist on disk.
- **Required Artifacts (Rule 6)**: Verifies the presence of required artifacts based on configuration.
- **Broken Flow References (Rule 6.1)**: Checks for non-existent nodes referenced in flows.
- **Flow Aspect IDs (Rule 6.2)**: Validates aspect IDs referenced in flows.
- **Invalid Artifact Conditions (Rule 6.3)**: Identifies invalid conditions in artifact requirements.
- **Shallow Artifacts (Rule 6.4)**: Warns about artifacts with content below a minimum length.
- **High Fan-Out (Rule 6.5)**: Warns about nodes with a high number of direct relations.
- **Unpaired Events (Rule 6.6)**: Detects unpaired event relations (emits without listens or vice versa).
- **Schema Validation (Rule 6.7)**: Ensures required schemas are present.
- **Directories with Node YAML (Rule 6.8)**: Checks that directories with files or subdirectories have a `yg-node.yaml` file.
- **Anchor Presence (Rule 6.9)**: Verifies that anchor strings exist in mapped source files.
- **Context Budget (Rule 6.10)**: Warns about nodes exceeding context token budgets.

### Validation Result

The validation process returns a `ValidationResult` object containing:

- `issues`: An array of `ValidationIssue` objects, each representing a validation problem.
- `nodesScanned`: The number of nodes scanned during validation.

### Issue Filtering by Scope

The `scope` parameter allows filtering validation issues to a specific node or its descendants. If the specified node does not exist, an error is returned.

### Error Handling

The module handles various error scenarios, such as configuration errors, node parse errors, and inaccessible files, ensuring robust validation even in partially broken graphs.

## Key Functions

- **`getAspectIds(aspects)`**: Extracts aspect IDs from node aspect entries.
- **`findSimilar(target, candidates)`**: Finds similar node paths for suggestion purposes.
- **`checkNodeTypes(graph)`**: Validates node types against the configuration.
- **`checkRelationTargets(graph)`**: Checks relation targets and provides suggestions.
- **`checkAspectsDefined(graph)`**: Ensures node aspects reference defined aspects.
- **`checkNoCycles(graph)`**: Detects structural cycles in the graph.
- **`checkMappingOverlap(graph)`**: Identifies overlapping mapping paths.
- **`checkRequiredArtifacts(graph)`**: Verifies required artifacts based on configuration.
- **`checkContextBudget(graph)`**: Warns about nodes exceeding context token budgets.

## Configuration

The validation process relies on the graph's configuration (`graph.config`) for various thresholds and rules, such as:

- `node_types`: Allowed node types.
- `artifacts`: Required artifacts and conditions.
- `quality`: Context budget thresholds, minimum artifact length, and maximum direct relations.

## Error Codes

Each validation issue includes a unique error code (e.g., `E001`, `W001`) to help identify and categorize problems.

## Performance Considerations

The module is designed to handle large graphs efficiently, with optimizations for common operations like cycle detection and path comparison. Asynchronous operations, such as file access, are used to avoid blocking the event loop.