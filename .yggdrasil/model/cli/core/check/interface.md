# Check Interface

**`runCheck(graph, gitTrackedFiles)`** — runs health check pipeline. Pass `null` for gitTrackedFiles when git is unavailable (E022 skipped).

**`suggestedNext` contract:** Always present when errors exist. Points to one concrete `yg` command targeting the highest-priority issue. Priority: drift (E020) > cascade (E021) > structural > coverage > completeness. This ordering exists because drift blocks approve, which blocks everything else — agents should resolve drift first. When cascade errors are present and 2+ nodes share the same upstream cause entity (aspect, flow, or parent), suggests a batch approve command (`yg approve --aspect`/`--flow`/`--node`) targeting that entity rather than single-node approve — the largest such group is chosen to maximize impact.

**`scanUncoveredFiles(graph, gitTrackedFiles)`** — returns git-tracked files not covered by any node mapping. Excludes `.yggdrasil/` files.

**`classifyDrift(graph)`** — classifies all nodes into E020 (direct drift) and E021 (cascade) in a single hash pass. Exported for use by approve (determines refusal type) and check pipeline. Side effect: when drift is detected for a node, invalidates cached LLM results (`aspectResults`, `artifactReview`) in that node's drift-state entry so stale reviewer verdicts are not carried forward.

**`buildCoverageIssue(uncoveredFiles, totalGitFiles)`** — constructs a structured E022 issue object from the list of all uncovered files and total git file count. Returns `null` when there are no uncovered files. Exported for use by the check pipeline when building coverage error blocks.

**`detectOrphanedDriftState(graph)`** — finds drift-state entries referencing nodes no longer in the graph. Exported for cleanup guidance in the check pipeline.

## Failure Modes

- Graph load errors: caller's responsibility (runCheck assumes valid Graph).
- Git unavailable: pass null, E022 skipped.
