# Context Builder Interface

Callers follow one of two paths depending on whether they have a node path or a file path:

**Node path → `buildNodeContextData(graph, nodePath)`** returns everything an agent needs before working on a node: which aspects to satisfy, which dependencies to check, which flows the node participates in, and the token budget. The `yg context --node` command renders this.

**File path → `buildFileContextData(graph, filePath, nodePath)`** returns the narrow view for a specific file: which aspects apply, which dependencies it consumes. The `yg context --file` command renders this.

**Cross-cutting queries** used by multiple commands: `collectEffectiveAspectIds` resolves the complete aspect set (own + inherited + flow + implied) — authoritative for check, approve, aspects, and impact. `collectTrackedFiles` returns all files a node tracks for drift — each tagged with its layer, which drives E020 vs E021 classification.

## Failure Modes

- Node not found: throws — caller provided an invalid path.
- Broken relation target: throws — graph has a dangling reference that must be fixed before context can be assembled.
- Aspect implies cycle: throws — circular implies chain detected.
