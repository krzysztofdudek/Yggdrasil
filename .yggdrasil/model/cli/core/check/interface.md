## Interface

### `runCheck(graph: Graph, gitTrackedFiles: string[] | null): Promise<CheckResult>`

Runs the full graph health check. Returns `CheckResult` with all issues, counts, and suggested next command.

- `gitTrackedFiles`: pass `null` to skip E022 (no git available)

### `CheckResult`

```typescript
interface CheckResult {
  projectName: string;
  nodeCount: number;
  nodeTypeCounts: Map<string, number>;
  aspectCount: number;
  flowCount: number;
  coveredFiles: number;
  totalFiles: number;
  issues: CheckIssue[];
  suggestedNext: string | null;  // highest-priority next command
}
```

### `CheckIssue`

Extends `ValidationIssue` with:

- `driftSubtype?: DriftStatus` — for E020: source-drift, graph-drift, full-drift, missing, unmaterialized
- `directChangedFiles?: DriftFileChange[]` — for E020: changed source/graph files
- `cascadeCauses?: CascadeCause[]` — for E021: what triggered the cascade
- `uncoveredFiles?: string[]` — for E022: file paths not covered
- `uncoveredCount?: number` — for E022: total count
- `anchorsPassing?: boolean` — for E021: whether anchors still match source

### `scanUncoveredFiles(graph, gitTrackedFiles): string[]`

Returns sorted list of git-tracked files not covered by any node mapping. Excludes `.yggdrasil/` files.

### `buildCoverageIssue(uncoveredFiles, totalGitFiles): CheckIssue | null`

Builds the E022 issue from uncovered files list.

### Failure modes

- Returns empty issues array on graph load errors (caller handles load failure)

- git unavailable: pass null for gitTrackedFiles, E022 is skipped
