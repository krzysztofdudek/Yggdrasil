## Responsibility

Unified graph health check orchestrator. Combines four subsystems into a single `CheckResult`:

1. **Structural validation** (E001-E041) — delegates to `cli/core/validator`
2. **Drift classification** (E020/E021) — direct drift from own/source file changes, cascade drift from upstream context changes; annotates E021 with cached verification labels (`last verified: pass/fail`, `never verified`); invalidates cached LLM results on any drift
3. **Coverage scan** (E022) — finds git-tracked source files not covered by any node mapping
4. **Orphaned drift state** (W005) — finds drift-state entries for nodes no longer in the graph

Also computes `suggestedNext`: the highest-priority actionable command with workflow anchor, preferring batch approve commands when multiple cascade nodes share the same upstream cause.
