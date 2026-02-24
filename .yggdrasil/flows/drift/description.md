# Drift Flow

End-to-end flow for `yg drift` and `yg drift-sync`: detect and sync divergence between graph and mapped files.

**Sequence:** commands/drift (orchestrates) → loader (load graph) → drift-detector (hash comparison; uses cli/io for readDriftState, writeDriftState).

**Participants:**

- `cli/commands/drift` — orchestrates loadGraph, detectDrift, syncDriftState
- `cli/core/loader` — loads graph (mappings for hash resolution)
- `cli/core/drift-detector` — computes hashes, compares to baseline, reports ok/drift/missing/unmaterialized; consumes cli/io internally

**Output:** Drift report to stdout; drift-sync updates `.yggdrasil/.drift-state`.
