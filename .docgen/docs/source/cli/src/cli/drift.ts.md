# Drift Command Documentation

## Overview
The `drift` command is part of a CLI tool built with [Commander](https://github.com/tj/commander.js). Its purpose is to **detect divergences ("drift") between a graph representation and its mapped files**. Drift occurs when the state of the graph and the state of the source files no longer align, potentially indicating inconsistencies, missing mappings, or unmaterialized nodes.

This command provides a structured report highlighting discrepancies, helping developers maintain synchronization between their graph model and the underlying file system.

---

## Command Registration
```ts
registerDriftCommand(program: Command): void
```
- Registers the `drift` command on a Commander `program`.
- Adds options for scope, filtering, and output limits.
- Defines an asynchronous action that loads the graph, validates scope, detects drift, and prints a formatted report.

---

## Usage
```bash
cli-tool drift [options]
```

### Options
- `--scope <scope>`  
  Defines the scope of drift detection.  
  - `"all"` (default): analyze the entire graph.  
  - `<node path>`: restrict analysis to a specific node or subtree.

- `--drifted-only`  
  Suppresses "ok" entries, showing only nodes with drift or issues.

- `--limit <n>`  
  Restricts the number of entries displayed per section. Useful for large graphs.

---

## Behavior

### Scope Validation
- If a specific node path is provided:
  - Ensures the node exists in the graph.
  - Verifies that the node or its descendants have mappings.
  - Exits with an error if validation fails.

### Drift Detection
- Calls `detectDrift(graph, scopeNode)` to generate a `DriftReport`.
- The report contains categorized entries and counts of different drift types:
  - **source-drift**: mismatch between source files and graph.
  - **graph-drift**: mismatch between graph and source files.
  - **full-drift**: both sides diverged.
  - **missing**: mapped file is missing.
  - **unmaterialized**: node exists but has no materialized file.
  - **ok**: node is consistent.

### Report Printing
- Results are divided into **Source drift** and **Graph drift** sections.
- Each section shows relevant entries, filtered by `--drifted-only` and truncated by `--limit`.
- Entries are color-coded using `chalk`:
  - Green: `[ok]`
  - Red: `[drift]` (source/full)
  - Magenta: `[drift]` (graph)
  - Yellow: `[missing]`
  - Dim: `[unmat.]` or hidden entries

- Changed files are listed under each entry, indented for readability.

### Summary
At the end of the report, a summary line aggregates counts:
```
Summary: 2 source-drift, 1 graph-drift, 0 full-drift, 1 missing, 0 unmaterialized, 5 ok
```
- If `--drifted-only` is used, hidden "ok" entries are noted.

### Exit Codes
- `0`: No issues detected (all entries are "ok").
- `1`: Drift or issues detected.
- `1`: Errors during execution (e.g., invalid scope).

---

## Key Functions

### `printReport(report, driftedOnly, limit)`
- Organizes entries into source and graph sections.
- Applies filtering and truncation.
- Prints summary statistics.

### `classifyForSection(entries, section, driftedOnly)`
- Filters entries based on section relevance.
- Excludes "ok" entries if `driftedOnly` is true.

### `printSectionEntries(entries, section)`
- Prints each entry line with status and node path.
- Delegates to `printChangedFiles` for file-level details.

### `printEntryLine(entry)`
- Formats a single entry with color-coded status labels.

### `printChangedFiles(entry, section)`
- Displays changed files relevant to the section (source or graph).

---

## Practical Notes
- **Intended Audience**: Developers maintaining consistency between a graph model and its mapped files.
- **Primary Use Case**: Detecting synchronization issues in large, file-backed graph structures.
- **Design Choice**: Exit codes integrate with CI/CD pipelines, allowing automated drift detection checks.
- **Filtering**: `--drifted-only` is useful for focusing on problems without clutter from consistent nodes.
- **Scoping**: Narrowing scope to a node path speeds up detection and reduces noise in large graphs.

---

## Example Workflows

### Detect drift across the entire graph
```bash
cli-tool drift
```

### Detect drift only for a specific node
```bash
cli-tool drift --scope ./src/components
```

### Show only problematic nodes
```bash
cli-tool drift --drifted-only
```

### Limit output for readability
```bash
cli-tool drift --limit 10
```

---

## Conclusion
The `drift` command is a diagnostic tool that ensures the integrity of graph-to-file mappings. By providing scoped analysis, filtering options, and clear reporting, it helps developers quickly identify and resolve inconsistencies that could otherwise lead to errors or misaligned system