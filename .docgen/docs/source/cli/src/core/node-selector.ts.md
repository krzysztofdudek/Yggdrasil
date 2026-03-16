# Node Selection Algorithm Documentation

## Overview

This module provides functionality to select relevant nodes from a graph based on a given task description. It uses a scoring system to rank nodes and flows, considering content matches, node specificity, and flow participation.

## Key Components

### `SelectionResult` Interface

Represents a selected node with its score and metadata.

```typescript
export interface SelectionResult {
  node: string; // Node path
  score: number; // Relevance score
  name: string; // Node name
}
```

### `countHits` Function

Counts the occurrences of search tokens in a given text, case-insensitively.

**Parameters:**

- `tokens`: Array of search terms
- `text`: Text to search within

**Returns:** Number of token matches

### `collectAspectContent` Function

Aggregates content from aspects associated with a graph node.

**Parameters:**

- `graphNode`: Node to collect aspects from
- `aspects`: List of available aspects

**Returns:** Concatenated aspect content

### `scoreNodeS1` Function

Calculates a node's relevance score based on token matches in artifacts and associated aspects.

**Scoring Weights:**

- `responsibility.md`: 3x weight
- `interface.md`: 2x weight
- Other artifacts: 1x weight
- Aspect content: 2x weight

**Parameters:**

- `graphNode`: Node to score
- `tokens`: Search terms
- `aspects`: Available aspects

**Returns:** Node relevance score

### `pathDepth` Function

Determines a node's specificity by counting path segments.

**Parameters:**

- `nodePath`: Node's path string

**Returns:** Path depth (number of segments)

### `selectNodes` Function

Primary node selection function. Ranks nodes by score and specificity, falling back to flow-based selection if no direct matches are found.

**Parameters:**

- `graph`: Graph data structure
- `task`: Task description
- `limit`: Maximum results to return

**Returns:** Array of `SelectionResult` objects

**Selection Process:**

1. Tokenize task description
2. Score nodes based on artifact and aspect matches
3. Sort by score, then path depth (specificity)
4. Return top `limit` results
5. Fallback to `selectFromFlows` if no direct matches

### `selectFromFlows` Function

Alternative selection method based on flow participation. Scores flows by token matches and selects participating nodes.

**Parameters:**

- `graph`: Graph data structure
- `tokens`: Search terms
- `limit`: Maximum results to return

**Returns:** Array of `SelectionResult` objects

**Selection Process:**

1. Score flows based on artifact and name matches
2. Sort flows by score
3. Select unique participating nodes in score order
4. Return top `limit` results

## Usage

```typescript
const results = selectNodes(graph, 'task description', 5);
// results: Array of top 5 most relevant nodes
```

## Behavior

- **Primary Strategy:** Direct node scoring based on content matches
- **Fallback Strategy:** Flow-based selection when direct matches are absent
- **Ties:** Broken by path depth (deeper nodes preferred)
- **Case Insensitivity:** Token matching is case-insensitive
- **Content Aggregation:** Aspects contribute to node scoring

This algorithm prioritizes nodes with:

1. Higher token match counts
2. More specific paths (deeper hierarchy)
3. Relevant aspect associations
4. Participation in high-scoring flows (fallback)