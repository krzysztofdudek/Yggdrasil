```markdown
# `registerTreeCommand` Function Documentation

## Purpose
Registers a CLI command (`tree`) to display a graph structure as a tree. The command allows users to visualize the hierarchy of graph nodes, optionally filtering by a root path or limiting the depth of the tree.

## Usage
The `registerTreeCommand` function is intended to be used with the `commander` library to extend a CLI program with the `tree` command. It provides options to customize the output based on the user's needs.

### Command Syntax
```bash
tree [options]
```

### Options
- `--root <path>`: Displays only the subtree rooted at the specified path. If the path is not found, an error is shown.
- `--depth <n>`: Limits the tree display to the specified maximum depth.

### Example
```bash
# Display the entire graph tree
tree

# Display the subtree rooted at 'model/core'
tree --root model/core

# Display the tree with a maximum depth of 2
tree --depth 2
```

## Behavior
1. **Graph Loading**: The command loads the graph from the current working directory using `loadGraph`.
2. **Root Selection**:
   - If `--root` is provided, it validates the path and uses the corresponding node as the root.
   - Otherwise, it selects all root nodes (nodes with no parent) and sorts them alphabetically.
3. **Tree Construction**:
   - The tree is constructed recursively using the `printNode` function.
   - Nodes are displayed with their path, type, aspects, blackbox status, and relation count.
   - The tree structure is visualized using ASCII connectors (`├──`, `└──`, `│`).
4. **Depth Limiting**: If `--depth` is specified, the recursion stops at the given depth.
5. **Error Handling**: Errors during graph loading or invalid paths are caught and displayed to `stderr`.

## `printNode` Function
Recursively prints a node and its children in a tree format. It handles indentation, connectors, and node metadata display. The function respects the maximum depth specified by the `--depth` option.

### Parameters
- `node`: The current graph node to print.
- `prefix`: The indentation prefix for the current node.
- `isLast`: Indicates if the node is the last child in its parent's list.
- `depth`: The current depth in the tree.
- `maxDepth`: The maximum depth to recurse, if specified.

### Output
Each node is printed in the format:
```
<prefix><connector><node-name>/ [<type>] aspects:<aspects> ■ blackbox -> <relation-count> relations
```

## Notes
- The command assumes the graph is loaded from the current working directory.
- Node paths are trimmed and normalized before processing.
- The tree is sorted alphabetically at each level for consistency.
```