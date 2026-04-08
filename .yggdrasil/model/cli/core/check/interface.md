# Check Interface

**`runCheck(graph, gitTrackedFiles)`** — runs health check pipeline. Pass `null` for gitTrackedFiles when git is unavailable (E022 skipped).

**`suggestedNext` contract:** Always present when issues exist. Points to one concrete `yg` command targeting the highest-priority issue. Priority: drift (E020) > cascade (E021) > structural > coverage > completeness. This ordering exists because drift blocks approve, which blocks everything else — agents should resolve drift first.

**`scanUncoveredFiles(graph, gitTrackedFiles)`** — returns git-tracked files not covered by any node mapping. Excludes `.yggdrasil/` files.

## Failure Modes

- Graph load errors: caller's responsibility (runCheck assumes valid Graph).
- Git unavailable: pass null, E022 skipped.
