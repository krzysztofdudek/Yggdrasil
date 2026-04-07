# Approve Command Internals

## Logic

The approve command operates in two modes:

1. **Single node** (`--node <path>` where node has mapping): loads graph, creates reviewer provider, calls `approveNode()` from `cli/core/approve`, formats result.
2. **Batch** (`--aspect <id>`, `--flow <name>`, or `--node <path>` where node has no mapping): loads graph, runs `classifyDrift()`, filters E021 issues by cause prefix, runs `approveNode()` on each matched node via `runBatch` semaphore, formats batch output with per-node results and summary.

Batch orchestration lives entirely in the CLI layer (`cli/approve.ts`). Core approve logic (`core/approve.ts`) is unaware of batch — it always processes one node.

### Cause Matching

Each E021 issue carries `cascadeCauses` with file paths relative to project root, including the `.yggdrasil/` prefix. Batch filtering matches these paths against a prefix:
- `--aspect X` matches files under `<yggPrefix>/aspects/X/`
- `--flow X` matches files under `<yggPrefix>/flows/X/`
- `--node X` (no mapping) matches files under `<yggPrefix>/model/X/`

### No-Mapping Parent Detection

When `--node <path>` targets a node without mapping, the CLI intercepts BEFORE calling `approveNode()` (which throws on no-mapping). It redirects to batch mode using the parent's model path as the cause prefix.

### Parallel Execution

`runBatch` implements a worker-pool semaphore. `N` workers each loop `queue.shift()` until empty. Concurrency is capped at `config.parallel` (default 1 = sequential). Results are collected in input order regardless of completion order. Each node's drift state is a separate file — no write contention.

## Decisions

Chose plain batch execution of `approveNode` over cascade-aware Row 4 bypass. Each node goes through the same three-axis check and reviewer verification. Rejected: `cascadeApprove` flag that would auto-bypass Row 4 — added complexity for no semantic benefit. The agent already has `--reviewed` to express "I checked, this is fine."

Chose to implement batch orchestration in CLI layer only, not in `core/approve.ts`. Rejected: adding batch awareness to the core function — the core function does one thing well (approve a single node), and batch is presentation logic.

Chose uniform `--node`/`--aspect`/`--flow` entity flags across approve (and future commands). Rejected: single `--path` flag with auto-resolution by directory — uniform flags reduce agent learning curve and eliminate ambiguity.
