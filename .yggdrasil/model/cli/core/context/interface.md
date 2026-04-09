# Context Builder Interface

**Primary entry point:** `buildContext` assembles the full ContextPackage via 6-layer composition (global → hierarchy → own → relational → flows → aspects). Commands don't call this directly — they use the formatter-facing functions below.

**For commands:** `buildNodeContextData` (when you have a node path — full context for `yg context --node`) and `buildFileContextData` (when you have a file path — narrow per-file view for `yg context --file`). These build formatter-facing data structures directly from the graph — they do not consume ContextPackage.

**Cross-cutting queries:** `collectEffectiveAspectIds` resolves the complete aspect set for a node — authoritative source used by check, approve, aspects, and impact. `collectTrackedFiles` returns all files tracked for drift with layer classification driving E020 vs E021.

## Failure Modes

- Node not found: throws.
- Broken relation target: throws.
- Aspect implies cycle: throws.
