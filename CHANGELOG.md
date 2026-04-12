# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0]

### Architecture

- **Enforcement-only model.** Aspects (content.md) are the only Markdown
  in the graph. Everything else is YAML metadata. Node knowledge lives
  in `yg-node.yaml` (description field) and aspect content.md files
  (enforceable rules). Flows are `yg-flow.yaml` only.
- **Binary approve model.** Source or upstream changed → run reviewer →
  pass or fail. The escape hatch for false positives is improving the
  aspect content.md, not bypassing enforcement.
- **Descriptive error codes.** Kebab-case identifiers (yaml-invalid,
  wide-node, source-drift, upstream-drift) instead of numeric codes.
- **Typed ports.** Nodes declare named ports with required aspects.
  Consumers reference ports via `consumes` field on relations.
  `consumes-without-ports` fires when `consumes` is declared on a
  relation to a target that has no ports.
- **Flat mapping.** Node mapping is a simple list of file/directory paths.
  Verification is handled by the LLM reviewer layer.

### Features

- **Claude Code provider (`claude-code`)** — spawns `claude` CLI for
  aspect verification. Configure via `reviewer: { claude-code: { model: haiku } }`.
- **`yg approve --aspect <id>`** — batch approve all cascade nodes
  from a specific aspect change.
- **`yg approve --flow <name>`** — batch approve all cascade nodes
  from a specific flow change.
- **`yg approve --node`** is variadic — accepts multiple node paths
  for batch approval. On a no-mapping parent, auto-redirects to batch
  approve cascaded children.
- **`parallel: N`** in `yg-config.yaml` controls concurrent approval
  limit (default: 1 = sequential).
- **`debug: true`** in `yg-config.yaml` enables structured append log at
  `.yggdrasil/.debug.log`.
- **`reviewer.verify_aspects`** config option (default: `true`) to control
  aspect verification during approve.
- **`reviewer.context_length_field`** config option for Ollama — specifies
  the model_info key for context window size.
- **`needsChunking`** on `LlmProvider` interface — CLI providers read
  files themselves; API providers get content chunked into the prompt.
- **Progressive disclosure in context output.** `yg context --node` shows
  overview (aspects, flows, dependents with consequence framing).
  `yg context --file` shows per-file details (aspects to satisfy,
  dependencies consumed, back-pointer to node).
- **`yg context --file`** shows blackbox decomposition guidance when file
  is inside a blackbox node; unmapped output includes actionable next step
  with candidate node listing.
- **`yg approve`** success shows verification summary when LLM ran.
- **`yg impact`** shows cascade prediction — lists nodes that will enter
  cascade drift if the target is modified. Supports `--node`, `--file`,
  `--aspect`, and `--flow` modes.
- **`yg check`** unified gate combining structural integrity, drift
  detection, coverage, and completeness. Suggested next command shows
  one concrete step + remaining scale. Detects cascade patterns —
  suggests `--aspect` or `--flow` batch commands when >=2 cascades
  share the same cause.
- **`yg aspects`** — usage stats per aspect (by source: architecture,
  direct, implied, flow), orphan detection.
- **`yg flows`** — participant count with node names, flow aspects.
- **Reviewer provider integration.** `reviewer` section in yg-config.yaml
  (provider, model, endpoint, temperature, consensus, max_tokens).
  Supports Ollama (default) and Claude Code.
- **`yg-secrets.yaml`** — gitignored file for API keys and LLM config
  overrides. Template created by init.
- **Graceful LLM degradation.** No LLM configured → check/approve work
  without semantic verification. Notice shown to user.
- **Append-only audit log** (`.yggdrasil/.audit-log.jsonl`) — every
  approve records timestamp, node, action, hashes, changed files.
- **Blackbox enforcement.** Source changes on blackbox nodes always
  refused. Anti-laundering check shows conflicting files and owning nodes.
- **Drift detection.** `source-drift` (source files changed),
  `upstream-drift` (aspects, flows, dependencies changed — collapsed
  per-node with cause identification), `unmapped-files` (coverage
  enforcement), `orphaned-drift-state` (warns about deleted nodes).
- **CLI messages** follow consistent what/why/next structure via
  `buildIssueMessage` helper.
- **Consequence framing for dependents.** 1-5: plain list, 6-15: cascade
  warning with count, 16+: HIGH blast radius warning.

### Agent Rules

- **Greenfield graph-first workflow** — mandatory ordering: aspects
  first, then flows, then nodes. Code comes last.
- **Node sizing rule** — one node per cohesive feature area, split
  when >10 files or >3 distinct workflows.
- **Flow identification heuristic** — guidance for recognizing flows
  in specs, conversations, and code (multi-actor AND single-actor).
- **Subagent delegation protocol** — subagents must read agent-rules.md
  and deliver graph updates alongside code. Incomplete work rejected.
- **Aspect check step (5b)** in Modify Source Code workflow.
- **Aspect discovery** applies to brownfield and greenfield.
- **New file creation trigger** in agent rules.

### Fixed

- **Ollama context window** auto-detection works with models that use
  architecture-prefixed keys (e.g. `qwen35.context_length`).
