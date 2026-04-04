## Constraints

# Core Constraints

## No direct filesystem access

All file I/O goes through cli/io. Core functions receive typed data structures, not file paths to read. This keeps core testable with in-memory data and decoupled from filesystem layout.

## No process-level side effects

Core never calls process.exit, process.stdout.write, or process.stderr.write. Functions return results or throw errors. Callers (commands) decide how to present results and handle failures. This ensures core can be consumed by any caller, not just the CLI.

## Functions throw on error, never swallow

When core encounters an invalid state — missing node, broken relation, cycle in structural dependencies — it throws. Core never silently returns partial results or logs warnings to stderr. The caller is always informed of failures explicitly.

## Determinism

Same graph state always produces same context package, validation result, and drift report. No heuristics, no guessing, no repository search.

## Context assembly algorithm (fixed order)

For node N at path P with aspects A, buildContext executes in this order:

1. GLOBAL — yg-config.yaml (project name)
2. HIERARCHY — artifacts of each ancestor (root down to parent of N)
3. OWN — N's yg-node.yaml (raw from disk) and N's content artifacts (all .md matching STANDARD_ARTIFACTS)
4. ASPECTS — for each aspect in A (union from hierarchy + own + flow blocks, expanded via implies), content of matching aspect
5. RELATIONAL — for each structural relation: target's structural_context artifacts (or fallback: all standard artifacts), annotate with consumes/failure from relation; for each event relation: event name + consumes; for each participating flow: flow artifacts

## Broken references block

buildContext throws if relation target missing. validate reports E004 for broken relations. resolveDeps throws on cycles.

## Token heuristic

estimateTokens uses ~4 chars/token. Budget thresholds from config.quality.context_budget.

## Structural relations acyclic

uses, calls, extends, implements must not form cycles. emits, listens may cycle (event relations do not create dependency edges). Cycles involving at least one blackbox node are tolerated.

## Decisions

# Core Decisions

**Reference:** docs/concept/engine.md (Context assembly, validation, drift, dependencies)

## Why core is separated from commands

Core implements the deterministic mechanics — the algorithms that operate on the graph. Separating core from commands enables testing domain logic without Commander, process.exit, or stdout/stderr. It also enables potential reuse beyond the CLI — the same graph operations could be consumed by a language server, a web API, or a programmatic SDK without changes to core.

## Why each core component is a separate module

Each component (loader, context-builder, validator, drift-detector, dependency-resolver) has a single responsibility and can be tested, evolved, and understood independently. The loader knows how to scan the filesystem and build the graph; it does not know about context assembly. The validator knows how to check structural integrity; it does not know about drift. This separation makes the codebase navigable and prevents coupling between orthogonal algorithms.

## 5-step context assembly

The algorithm is fixed (docs/concept/engine.md). Order: global, hierarchy, own, aspects, relational (structural deps + events + flows). Each step is mechanical: read declarations, copy content, annotate with YAML metadata. Tools never interpret Markdown content — they copy and annotate. The agent interprets.

## Why determinism matters

The graph is the intended truth. If tools produced different output for the same input, the system would be unreliable. CI, agents, and humans must get identical results. Determinism is the foundation of trust.

## Why core doesn't parse YAML

Separation of concerns. The io layer parses files; core consumes typed structures. Core focuses on graph logic — assembly, validation, dependency resolution. IO focuses on file format. Clear boundary, testable in isolation.

## Why claim verification is per-node not per-file (v4)

Chose to verify claims at node granularity (all node source files concatenated) rather than per-file. Reason: aspects apply to nodes, not files. A claim like "no Date.now()" must hold across ALL files in the node. Per-file would miss cross-file patterns and create overhead of N LLM calls per node. For large nodes, source is chunked by file boundaries — all chunks must pass. Rejected alternative: per-file verification — rejected because claims are node-level properties.

## Why approve runs both claim verification and artifact review (v4)

Two distinct LLM operations at approve time: (1) claims check if code satisfies aspect rules, (2) artifact review checks if documentation is current. Both are needed: claims ensure behavioral correctness, artifacts ensure documentation accuracy. They fire different error codes (E055 vs E056) with different fix paths. Rejected alternative: single combined LLM check — rejected because the fix actions are different (fix code vs fix docs).
