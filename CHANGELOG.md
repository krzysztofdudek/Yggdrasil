# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.0.0] - 2026-04-14

### Architecture

- **Removed blackbox nodes.** All nodes are proper nodes. Nodes without
  aspects auto-approve without hashing or LLM verification — same coverage
  benefit as blackbox, zero edge cases. Anti-laundering check removed.
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
  aspect verification. Configure via `reviewer:` section in `yg-config.yaml`.
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
- **Reviewer is required for approve.** `yg approve` errors if no reviewer
  is configured. Aspects are always verified — no opt-out.
- **`reviewer.context_length_field`** config option for Ollama — specifies
  the model_info key for context window size.
- **8 reviewer providers.** API: Anthropic, OpenAI, Google, OpenAI-compatible,
  Ollama. CLI: Claude Code, Codex, Gemini CLI.
  Configure via `reviewer:` section in `yg-config.yaml`.
- **Self-contained reviewer prompt.** All content (aspect rules, node
  description, source files) inline. CLI and API providers receive
  identical prompt — only transport differs.
- **Provider registry.** Self-registering providers replace switch-based
  factory.
- **Progressive disclosure in context output.** `yg context --node` shows
  overview (aspects, flows, dependents with consequence framing).
  `yg context --file` shows per-file details (aspects to satisfy,
  dependencies consumed, back-pointer to node).
- **`yg context --file`** unmapped output includes actionable next step
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
- **Interactive `yg init` wizard.** Platform selection, reviewer setup
  with model fetching from provider API, connection validation.
- **`yg init --upgrade --platform <name>`** — non-interactive rules and
  schemas refresh. Skips interactive prompts for CI and scripting use.
- **`yg-secrets.yaml`** — gitignored file for API keys. Created by
  `yg init` when an API provider is selected.
- **Append-only audit log** (`.yggdrasil/.audit-log.jsonl`) — every
  approve records timestamp, node, action, hashes, changed files.
- **Drift detection.** `source-drift` (source files changed),
  `upstream-drift` (aspects, flows, dependencies changed — collapsed
  per-node with cause identification), `unmapped-files` (coverage
  enforcement), `orphaned-drift-state` (warns about deleted nodes).
- **CLI messages** follow consistent what/why/next structure via
  `buildIssueMessage` helper.
- **`yg-architecture.yaml`** — separate file for node type definitions
  with default aspects and relation constraints per type. Created by
  `yg init` with 5 default types (module, service, library, infrastructure, data).
- **v3→v4 migration.** `migrateTo4` transforms a v3 `.yggdrasil/`
  directory: splits `node_types` to `yg-architecture.yaml`, flattens
  node aspects and mapping, removes node/flow artifacts, strips aspect
  `stability`, resets drift state. Warns about dropped aspect exceptions
  and anchors.
- **`consensus: N`** reviewer config — runs N review passes per aspect
  and requires majority agreement. Higher confidence, proportionally
  higher cost.
- **`name` field removed from `yg-config.yaml`.** Project name is
  derived from the directory name at runtime.
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
- **Aspect check step (5c)** in Modify Source Code workflow.
- **Aspect discovery** applies to brownfield and greenfield.
- **New file creation trigger** in agent rules.

### Fixed

- **`needsChunking` removed from `LlmProvider` interface.** All providers
  receive same self-contained prompt. Chunking is `aspect-verifier.ts`
  responsibility.
- **`verifyAspect()` simplified** from `verifyAspect(params: AspectVerifyParams)`
  to `verifyAspect(prompt: string)`. Providers are dumb pipes.
- **Reviewer prompt redesigned.** Node context replaced by one-line node
  description. Aspect content inline instead of file path reference.
- **Context output** uses `.yggdrasil/` prefix and `read:` label for aspect
  paths — agents can use paths directly without guessing the prefix.
- **Ollama context window** auto-detection works with models that use
  architecture-prefixed keys (e.g. `qwen35.context_length`).

## [3.0.0] - 2026-03-29

### Breaking

- **Artifacts removed from `yg-config.yaml`.** The three standard artifacts
  (`responsibility.md`, `interface.md`, `internals.md`) are now hardcoded in
  the CLI. The `artifacts` section is no longer read from config. Migration
  to 3.0.0 removes the section automatically. Custom artifact files remain
  on disk but the CLI will ignore them.
- **E013 and E020 validation rules removed.** E020 (missing standard artifact
  in config) and E013 (invalid artifact condition) are no longer needed since
  artifacts are hardcoded.

### Added

- **`yg build-context --self` flag.** Returns only the node's own artifacts — no
  hierarchy, dependencies, aspects, or flows. Designed for file-level graph
  updates where cross-cutting context was already loaded at task-level. Reduces
  token cost from ~8K to ~2-3K per file interaction.
- **Migration to 3.0.0.** Automatically removes `artifacts` section from
  `yg-config.yaml`. Warns if custom (non-standard) artifacts were present.

### Changed

- **Agent rules: greenfield spec-knowledge transfer (Track A).** Added
  spec-level trigger to `critical_protocol` with two-category knowledge split:
  (a) knowledge that maps to source files → node artifacts later, (b) knowledge
  that will NEVER be in source code → graph immediately. Greenfield workflow
  updated: step 0 (route spec knowledge), step 5 (every file must be mapped),
  step 6 (write `internals.md` with design decisions — as numbered step).
  Research result: 6.6 → 10.0/10.0 on spec-knowledge transfer.
- **Agent rules: brownfield context reading (Track B).** Separated task-level
  READ phase (aspects, flows, relations, parent — collect constraints before
  designing) from file-level WRITE phase (local artifacts, graph updates).
  Guard: file-level step warns if task-level READ was skipped. Research result:
  1.82 → 7.04/10 on aspect compliance.
- **Standard artifacts hardcoded in agent rules and CLI.** The three artifacts
  are referenced by name everywhere — rules, validator, context builder. No
  longer configurable.

## [2.12.0] - 2026-03-26

### Changed

- **Agent rules: task-level graph trigger.** Added a task-level trigger
  (`yg select --task`) alongside the existing file-level trigger
  (`yg build-context --file`). Root cause: agents in brainstorming/design/planning
  modes skipped graph context because the file-level trigger didn't fire — they
  didn't think of themselves as "interacting with a source file." Real-world
  impact: an agent designed a 4-feature admin panel by reading 6+ source files
  without loading graph context, missing cross-cutting aspects, flows, and
  conventions. Three changes: (1) expanded `critical_protocol` to lead with the
  task-level trigger, (2) added task-level entry to Quick Start, (3) added
  brainstorming correct/wrong example pair, (4) closed Context Assembly loophole
  ("the map alone is sufficient" → "read ALL artifact files" + measured ~8K token
  cost), (5) added 3 evasion patterns, (6) added failure state for brainstorming
  without graph.

## [2.11.0] - 2026-03-25

### Changed

- **drift:** Blackbox nodes are excluded from drift detection — no source
  hashing, no `.drift-state/` file. Existing orphaned state files are cleaned
  up on `drift-sync --all`.

## [2.10.0] - 2026-03-25

### Changed

- **Agent rules: flow creation enforcement.** Agents were skipping flow creation
  during greenfield implementation — building nodes and aspects but treating
  business processes as optional. New rules: flow identification heuristic
  (expanded to cover single-actor workflows, not just multi-actor processes),
  flow verification from specs (mandatory check per spec business process),
  flow participant maintenance (update flow `nodes` after node splits/renames).
  Added step 4b to Modify Source Code checklist (update flows after node
  restructuring). Added 3 evasion patterns and 3 failure states for flow
  omission. Root cause: agents dismissed single-actor workflows (blog
  publishing, portfolio management) as "just CRUD" rather than goal-directed
  business processes.

## [2.9.0] - 2026-03-25

### Changed

- **Agent rules v2: spec ingestion & non-code knowledge.** Major rules update driven by
  a real-world finding: during full-system implementation from external specs, the agent
  captured only ~30% of spec knowledge — all technical, zero business context. The root
  cause was a file-centric protocol with no triggers for knowledge that has no source file.
  New sections: Working from External Specifications, Non-Code Knowledge, Aspect Discovery
  During Implementation. Expanded: completeness test (3 checks), information routing table
  (6 new entries), graph audit (Step 3: non-derivable knowledge), evasion patterns (+6),
  failure states (+4). Added node sizing rule for greenfield workflows.

## [2.8.0] - 2026-03-21

### Added

- **`yg build-context --file <path>`** — resolves owning node and assembles context
  in one step. Reduces the agent workflow from two commands (`yg owner` + `yg build-context
  --node`) to one.
- **`yg impact --file <path>`** — resolves owning node and shows blast radius in one
  step. All existing flags (`--simulate`, `--method`) work with `--file`.
- **W017 wide-node** — validation warning when a node maps more source files than
  `quality.max_mapping_source_files` (default: 10). Suggests splitting into child nodes.
- **W018 source-only-sync** — `yg drift-sync` warns when source files changed but graph
  artifacts are unchanged, signaling that artifacts should be updated before syncing.

### Changed

- **Agent rules: motivation-first opening.** The `EXTREMELY-IMPORTANT` block now leads
  with why the graph matters ("the user loses time and opportunities") instead of
  authority-based compliance ("YOU DO NOT HAVE A CHOICE").
- **Agent rules: simplified Quick Start.** Replaced multi-step decision tree with single
  command: `yg build-context --file <path>`.
- **Agent rules: preflight exception removed.** "Read-only requests skip preflight" was
  exploitable — agents classified code analysis as read-only. No exceptions now.
- **Agent rules: self-audit removed.** Post-response self-audit was never executed by
  agents. Replaced by CLI guardrails (W017, W018) that provide feedback at the point of
  action.
- **Agent rules: 5 new evasion patterns.** Autonomous mode, repetitive patterns, batching,
  saving tool calls, "assumed not mapped."
- **Agent rules: 3 new failure states.** Batching graph updates, source-only drift-sync,
  wide umbrella nodes.

## [2.7.0] - 2026-03-20

### Changed

- **Context output v3.** Reorganized `yg build-context` output for agent readability:
  - `glossary` section at top — aspect and flow definitions (name, description, stability,
    participants, files) before any references
  - Inline `files` on every element (node, hierarchy, dependencies) — no separate file registry
  - `meta` (token count, budget, breakdown) moved to bottom
  - YAML comments before major sections for in-place guidance
  - `yg-node.yaml`, `yg-aspect.yaml`, `yg-flow.yaml` removed from file lists (metadata
    already in structured map)
  - `stability` (aspects) and `participants` (flows) surfaced in glossary
  - `meta.breakdown` now included in output

### Removed

- **`ArtifactRegistry` type** — replaced by `Glossary` + inline `files`

## [2.6.0] - 2026-03-20

### Added

- **Uniform `description` field.** Optional `description` field for nodes (`yg-node.yaml`)
  and flows (`yg-flow.yaml`) — provides quick orientation in context maps without reading
  full artifacts. Aspects already had this field.
- **Description in context output.** `yg build-context` now surfaces `description` for
  nodes, hierarchy ancestors, dependencies, aspects, and flows in the YAML map.
- **Description in `yg flows`.** `yg flows` output now includes `description` when present.
- **W016: missing-description warning.** `yg validate` now emits W016 for nodes, aspects,
  and flows that lack a `description` field, encouraging richer graph metadata.
- **Agent rules: description maintenance.** Rules now instruct agents to write `description`
  when creating elements and update it when purpose changes.

### Changed

- **Leaner flow refs in context output.** `node.flows` entries now contain only `path`
  and `aspects` — `name` and `description` are in the glossary.

### Fixed

- **No more YAML anchors in context output.** The `yaml` serializer created `&a1`/`*a1`
  aliases for duplicate arrays, making output harder to read. Disabled with
  `aliasDuplicateObjects: false`.

## [2.5.1] - 2026-03-17

### Fixed

- **Rules: flow field name mismatch.** Agent rules referenced `participants` as the
  flow YAML field name, but the schema and parser use `nodes`. Corrected rules to say
  `nodes`. Parser now also accepts `participants` as an alias for backward compatibility.
- **Flow loading resilience.** `loadFlows` no longer silently swallows parse errors
  from individual flows — only a missing `flows/` directory is tolerated.

## [2.5.0] - 2026-03-13

### Changed

- **Context budget: diagnostic breakdown.** W005/W006 now show token breakdown
  (own/hierarchy/aspects/flows/dependencies) instead of a single number. W006 no longer
  blocks — budget status changes from `'error'` to `'severe'`. New W015 warning fires
  when own artifacts exceed `own_warning` threshold — the only actionable budget warning.
  Token counting includes full dependency hierarchy cost.

## [2.4.1] - 2026-03-13

### Fixed

- **Agent rules: knowledge preservation under budget pressure.** W005 warning message
  reworded from "Consider splitting the node or reducing dependencies" to explicitly
  prohibit deleting knowledge from artifacts. Error Recovery gains W005 handling with
  concrete split procedure. New failure state: deleting artifact content to reduce
  context size.

## [2.4.0] - 2026-03-13

### Changed

- **Agent rules: graph as specification.** Rule 2 rewritten from "Code and graph are one"
  to "The graph is the specification; code implements it" — emphasizing knowledge
  absorption, immediate updates, and self-sufficiency. Subagent delegation now includes
  explicit deliverables (code + graph + validation). Failure states and self-audit
  aligned to "before moving to the next file" timing.
- **`yg build-context` output format.** Restructured from inline XML to a two-section YAML format:
  structural map (topology, relationships, aspects, flows) + artifact registry (file paths).
  Default mode returns paths only — agents read files individually using Read tool.
  New `--full` flag appends file contents below a `---` separator in XML-style tags.

### Added

- **Impact propagation to structural dependents.** All `yg impact` modes now show
  indirectly affected nodes — structural and event dependents (uses/calls/extends/implements/emits/listens) of
  affected nodes, with transitive chains. `--aspect` and `--flow` split output into
  "Directly affected" and "Indirectly affected" sections. `--node` adds an "Indirectly
  affected" section for reverse dependents of descendants. `--simulate` covers all sets.
- **Dependency hierarchy in context packages.** Dependencies now include their full parent
  hierarchy with ancestors' artifacts and effective aspects, giving agents domain-level
  context for each dependency.
- **`--full` flag for `yg build-context`.** Appends artifact file contents to the YAML map
  for use in environments without file reading capabilities.

## [2.3.3] - 2026-03-12

### Fixed

- **`yg tree` aspect display.** Aspects were rendered as `[object Object]` instead of
  their IDs. Now correctly extracts the `aspect` field from each `NodeAspectEntry` before
  joining.

## [2.3.2] - 2026-03-11

### Removed

- Removed deprecated `stack` and `standards` fields from config schema example
  (`graph-schemas/yg-config.yaml`). These fields were already ignored by the parser
  since v2.0.0 — this cleans up the last reference in the shipped schema template.

## [2.3.1] - 2026-03-09

### Changed

- Trigger release pipeline.

## [2.3.0] - 2026-03-09

### Added

- **`yg select --task` command:** Finds graph nodes relevant to a natural-language task
  description using weighted keyword matching (S1) with flow-based fallback (S2).
  Outputs YAML list of `{ node, score, name }` sorted by relevance. Based on
  experiment 5.4 findings (89% precision, 96% recall with keyword matching).

### Fixed

- **`yg init --upgrade` now updates config version.** Previously, `--upgrade` ran migrations
  but left `version` in `yg-config.yaml` unchanged, causing repeated migrations on subsequent
  upgrades. The version field is now set to the CLI version after migrations complete.
- **Polish text in CLI output.** Replaced Polish-language message in `yg owner` indirect
  mapping output and its example in `docs/concept/tools.md` with English.

### Changed

- **Documentation:** Updated "Early results" in README and docs with Series 5 invisibility
  experiment findings. Added "Task-Based Node Selection" section to engine spec.
  Added accelerated bootstrap and PR maintenance sections to integration spec.
- **Documentation:** Renamed `docs/idea/` to `docs/concept/`; updated all references in VitePress config, AGENTS.md, and graph metadata.
- **Documentation:** Fixed markdownlint errors in `docs/index.md` and `README.md` (MD001 heading-increment, MD026 trailing punctuation).

## [2.2.0] - 2026-03-06

### Added

- **Agent rules: semantic search navigation.** Added step 0 to Quick Start Protocol teaching
  agents to use semantic search tools (when available) for top-down navigation — going from
  a high-level intent to the right graph nodes before falling back to grep. Added corresponding
  evasion pattern for "I'll grep the codebase to find where to start."

## [2.1.0] - 2026-03-06

### Added

- **`version` field in `yg-config.yaml`:** Tracks the CLI version that created/last migrated this config. Used by the migration system to determine which migrations to run.
- **Migration system:** `yg init --upgrade` now detects project version and automatically
  migrates from 1.x to 2.0.0 — file renames to `yg-*` prefix, config transforms, aspects
  restructuring (`[id]` → `[{aspect: id}]`), and stack/standards content migration to root node

### Removed

- **Journal functionality:** Removed `journal-add`, `journal-read`, and `journal-archive` commands,
  `JournalEntry` type, journal store, and all journal references from preflight, agent rules,
  documentation, and graph. Journal was an unused feature that added complexity without value.

### Changed

- **Agent rules: graph-first enforcement.** Added `EXTREMELY-IMPORTANT` block at top of rules,
  evasion patterns table, and enhanced self-audit to prevent agents from skipping graph tools
  when working under skills (brainstorming, debugging, etc.). Split graph tool guidance into
  `build-context` (understanding) vs `impact` (blast radius assessment).
- **Per-node drift state storage:** Changed from single `.drift-state` JSON file to per-node files
  under `.drift-state/` directory. Each node's drift state is stored in its own JSON file
  (e.g., `.drift-state/cli/commands/aspects.json`). Enables readable git diffs and atomic writes.
  Old format migrated automatically on first read. `drift-sync --all` now garbage collects
  orphaned drift state files.
- **Drift state committed to git:** Removed `.drift-state` from `.gitignore` so drift state files
  are tracked in version control. CI pipelines can now run `yg drift` to verify graph-code consistency.

## [2.0.0] - 2026-03-05

### Changed

- **BREAKING:** All Yggdrasil YAML files renamed to `yg-*` prefix to avoid VS Code SchemaStore
  collisions: `config.yaml` → `yg-config.yaml`, `node.yaml` → `yg-node.yaml`,
  `aspect.yaml` → `yg-aspect.yaml`, `flow.yaml` → `yg-flow.yaml`
- **Renamed `structural_context` → `included_in_relations`** in artifact configuration. Clearer name
  for the flag controlling whether an artifact is included in dependency context packages.
- **Changed `node_types` from array to object** in config. Keys are type names, values have
  required `description` (agent guidance) and optional `required_aspects`. Symmetric with `artifacts`.
- **BREAKING:** `aspects` field in `node.yaml` changed from string array to object array — each
  entry is `{ aspect: id, exceptions?: string[], anchors?: string[] }`
- `aspect_exceptions` and `anchors` fields merged into unified `aspects` entries

### Added

- **Custom artifact guidance in agent rules:** Rules now document that `config.yaml` can define
  additional artifact types with `description`, `required` conditions (`always`, `never`,
  `when: has_incoming_relations`, `when: has_aspect:<id>`), and `included_in_relations`.
- **Unified `aspects` format in node.yaml schema:** Each aspect entry supports embedded `exceptions`
  (per-node deviations from aspect patterns) and `anchors` (code anchor assertions for staleness detection).
- **`stability` in aspect.yaml schema:** Documents the stability tier field.
- **Node type descriptions:** `config.yaml` node types now have a required `description` field
  providing agent guidance. Replaces hardcoded descriptions in rules.
- **Subagent delegation rule in agent rules:** Subagents must read `.yggdrasil/agent-rules.md`
  as their first action before any other work.

### Removed

- **BREAKING:** Removed `stack` and `standards` from `config.yaml` — technology and conventions now
  live in node artifacts at the appropriate hierarchy level
- Global context layer now contains only the project name
- **Legacy `tags`/`required_tags` fallbacks:** Removed backward-compatibility parsing of `tags`
  (use `aspects`) and `required_tags` (use `required_aspects`).
- **Legacy `node_types` string array format:** Removed support for `node_types: [module, service]`.
  Use object format with descriptions.
- `aspect_exceptions` field from `node.yaml` (merged into `aspects[].exceptions`)
- `anchors` field from `node.yaml` (merged into `aspects[].anchors`)
- Validation rule E018 (`invalid-aspect-exception`) — structurally impossible with unified format
- Validation rule E019 (`invalid-anchor-ref`) — structurally impossible with unified format
- `AspectException` type from public API

### Fixed

- **`stack` rationale reference:** Fixed misleading reference to `rationale` field on stack
  entries in agent rules (parser only supports flat string values).

## [1.4.3] - 2026-03-05

### Fixed

- **Manual publish:** Previous versions (1.4.0–1.4.2) were accepted by npm CI but silently
  removed from registry post-publish. Publishing manually without `--provenance` to diagnose.

## [1.4.2] - 2026-03-05

### Fixed

- **Release pipeline race condition:** Removed duplicate `push: tags` trigger from release
  workflow. Both `workflow_run` and `push: tags` fired simultaneously, causing two concurrent
  `npm publish --provenance` calls that likely corrupted the package on the registry.

## [1.4.1] - 2026-03-05

### Added

- **`stability` field in `aspect.yaml`:** Optional stability tier classification (`schema`,
  `protocol`, `implementation`) predicting aspect decay rate. Appears in context packages
  and `yg aspects` output. Guides review urgency: `implementation` aspects need review after
  any significant code change, `schema` aspects only when data models change.
- **W014 `anchor-not-found`** — `yg validate` warns when a code anchor is not found in a node's mapped source files
- **E019 `invalid-anchor-ref`** — `yg validate` errors when `anchors` key references an aspect not in the node's `aspects` list
- **`yg impact --method <name>` flag:** Filters node-mode impact to dependents whose
  `consumes` list includes the specified method (or have no `consumes`, meaning they consume
  everything). Enables method-level blast radius analysis.
- **Event relation tracking in `yg impact --node`:** Impact output now includes an
  "Event-dependent" section showing nodes connected via `emits`/`listens` relations,
  with event names. Total scope includes event dependents.
- **Agent rules: enrichment priority.** When adding artifacts incrementally, prioritize
  `interface.md` first (highest cross-module ROI), then `responsibility.md`, then
  `internals.md`. Based on experiment finding: 1.88 pts/1000 chars for interface vs lower
  for other artifacts.
- **Agent rules: aspect stability tiers in review cadence.** Agents use `stability` field
  to calibrate review urgency. Anchor-based staleness check during drift resolution.
- **Agent rules: action recognition rule.** New "Recognizing Graph-Required Actions"
  section ensures agents apply the graph protocol based on the ACTION being performed
  (understanding mapped code), not the SOURCE of the instruction (skill, plan, user,
  workflow). Prevents external workflows from overriding the graph-first protocol.

### Changed

- **BREAKING:** `anchors` field moved from `aspect.yaml` to `node.yaml` — anchors are now per-node, per-aspect maps (`anchors: { aspect-id: [pattern1, pattern2] }`) for more precise staleness detection

## [1.3.0] - 2026-03-04

### Added

- **`aspect_exceptions` in node.yaml:** Per-node exceptions to aspect-level generalizations.
  Record deviations from aspect patterns (e.g., aspect says "fire-and-forget" but this node
  awaits the call). Exceptions appear in context packages alongside aspect content.
- **E018 `invalid-aspect-exception` validation error:** Fires when `aspect_exceptions[].aspect`
  references an aspect not in the node's own `aspects` list.
- **Node type `infrastructure`:** New node type for guards, resolvers, middleware, interceptors,
  and validators that intercept or modify request flow without being explicitly called by
  business logic. Key for blast radius analysis.
- **Agent rules: Graph Audit workflow** — two-step protocol (consistency + completeness)
  for reviewing graph quality.
- **Agent rules: "rationale unknown" pattern** — when the rationale for a decision is unknown,
  record it as "rationale: unknown" instead of inventing a plausible-sounding rationale.
- **Agent rules: aspect lifecycle warning** — aspects decay catastrophically (~2.4-year
  half-life, binary). After significant feature additions, review all aspects touching the
  affected area.
- **Agent rules: value calibration** — Yggdrasil's primary value is cross-module context;
  invest depth where cross-module interactions demand it.

### Changed

- **Artifacts consolidated from 8 to 3:** `responsibility.md` (WHAT — identity, boundaries),
  `interface.md` (HOW TO USE — public API, contracts, failure modes, exposed data structures),
  `internals.md` (HOW IT WORKS + WHY — algorithms, business rules, state machines, design
  decisions with rejected alternatives). New repos get 3 artifacts; existing repos can migrate
  manually.
- **Agent rules: calibrated graph trust** — graph is primary source of architectural
  understanding; for implementation-level precision (exact behavior, error handling, edge
  cases), verify against source code.
- **Agent rules: failure states consolidated from 15 to 8** — removed redundancies,
  clearer grouping.
- **Agent rules: completeness test enhanced** — now includes both reconstruction test
  ("can another agent recreate this?") and omission test ("does the graph capture every
  important behavioral invariant?").
- **Agent rules: drift triage** — prioritize aspects and internals.md (highest decay),
  then responsibility.md and interface.md (most stable).

## [1.2.0] - 2026-03-03

### Added

- **`yg owner` ancestor hint:** When a file has no direct mapping but lies inside a mapped
  directory, the output now includes a second line explaining that context comes from the
  nearest ancestor and suggests `yg build-context --node <path>` for the agent.
- **Agent rules: "BEFORE ENDING ANY RESPONSE" self-audit:** Pre-completion checklist: did I
  modify code? If yes → did I update graph artifacts in this same response? Prevents agents
  from finishing without syncing the graph.

## [1.1.0] - 2026-03-03

### Added

- **`yg drift --limit <n>` flag:** Limits the number of entries shown per section, with
  truncation notice showing remaining count. Exit code still reflects all entries.
  Enables agents to page through large drift reports iteratively.
- **W013 `directory-without-node` warning:** `validate` now warns when a directory under
  `model/` has only subdirectories but no `node.yaml`, indicating a bare intermediate
  directory that may need a node definition. E015 is refined to fire only for directories
  with actual files (not just subdirectories).
- **Expense Tracker example:** Mini SaaS in `examples/expense-tracker/` with full Yggdrasil graph (API + Web nodes), auth, expenses, categories, budgets, reports, subscription mock. App UI and messages in English.
- **Examples blackbox node:** `examples/` mapped as blackbox in main graph — intentional coarse coverage.
- **`config.yaml` schema:** Added `graph-schemas/config.yaml` with documented fields for
  project name, stack, standards, node types, artifacts, and quality thresholds.
- **W012 validation rule:** `validate` now warns when mapping paths in `node.yaml` do not
  exist on disk, catching typos and stale mappings early instead of only at drift time.
- **Preflight bootstrap hint:** When `yg preflight` detects 0 nodes, it now displays an
  explicit message suggesting BOOTSTRAP MODE instead of silently reporting "clean."
- **`yg flows` command:** New command that lists flows with metadata (name, participants,
  nodes, aspects) in YAML output, parallel to the existing `yg aspects` command.
- **`yg drift-sync --recursive` flag:** Syncs the target node and all descendant nodes
  in one command. Parent nodes without mapping are skipped gracefully.
- **`yg owner` file existence hint:** When a file path doesn't exist on disk, the output
  now shows `(file not found)` to distinguish from files that exist but lack graph coverage.
- **`yg preflight --quick` flag:** Skips drift detection for faster results, useful for
  large repos where drift detection is slow.
- **`yg drift-sync --all` flag:** Syncs all nodes with mappings in one command, replacing
  manual per-node sync loops.
- **`.drift-state` in `.gitignore`:** `yg init` now includes `.drift-state` in the
  generated `.yggdrasil/.gitignore` since drift state is machine-local.

### Changed

- **E009 overlap model — "child wins":** Parent-child mapping containment overlaps are now
  allowed (e.g., parent maps `drivers/`, child maps `drivers/net/`). Only exact duplicates
  and overlaps between unrelated (non-hierarchical) nodes remain errors. Drift detection
  excludes child-owned files from parent hashing, preventing false parent drift.
- **Agent rules: "why NOT" prompting.** Rule 4 now explicitly instructs agents to capture
  rejected alternatives alongside design decisions: "Chose X over Y because Z." Added
  corresponding failure state and "when to ask" prompt for decisions without alternatives.
- **Agent rules: greenfield graph-first workflow.** Expanded the greenfield code guidance
  from a one-liner to a 6-step workflow: aspects → flows → nodes → build-context → implement.
  The graph serves as behavioral specification; code implements framework-specific HOW.
- **Agent rules: aspect identification guidance.** Added 3-instance heuristic ("same pattern
  in 3+ places = candidate aspect") and natural taxonomy: domain-specific, architectural,
  concurrency.
- **Agent rules: enhanced completeness test.** Now tests specifically for: rejected
  alternatives, correct algorithm (not simplified), ability to argue for current design.
- **`decisions.md` artifact description.** Updated across spec, config, and rules from
  generic "rationale" to "rejected alternatives — Chose X over Y because Z."

### Fixed

- **`build-context` scoped validation:** `build-context` no longer blocks on validation
  errors in unrelated nodes. Only errors affecting the target node, its ancestors, and its
  relation targets cause a build failure. Errors elsewhere are reported as informational.
- **CWD-relative path resolution in `yg owner`:** `yg owner --file <path>` now resolves
  paths relative to the current working directory before matching against graph mappings,
  so running from subdirectories works correctly.
- **`./` prefix normalization:** All `--node` and `--scope` arguments now strip leading
  `./` and trailing `/`, so `yg build-context --node ./foo/bar/` works as expected.
  Affected commands: `build-context`, `deps`, `drift-sync`, `impact`, `validate`, `drift`.
- **Drift-state garbage collection:** `yg drift-sync` now removes orphaned entries for
  nodes that no longer exist in the graph, preventing progressive performance degradation
  when nodes are created and later deleted.
- **`--scope` includes descendants:** `yg validate --scope foo` and `yg drift --scope foo`
  now include all descendant nodes (e.g., `foo/bar`, `foo/bar/baz`), not just the exact
  node. This makes scoped operations work naturally with hierarchical graphs.
- **Duplicate parent context in `build-context`:** When a child node has an explicit
  relation (e.g., `extends`) targeting its own parent, the parent's artifacts no longer
  appear twice (once in hierarchy, once in relational). The relational layer is skipped
  for ancestors since their context is already included via hierarchy.
- **Empty YAML file TypeError:** All parsers (node, aspect, flow, config) now guard
  against empty or non-mapping YAML content, producing a clear error message instead
  of a raw `TypeError: Cannot read properties of null`.
- **Preflight validation shows node paths:** Validation issues in `yg preflight` now
  include the affected node path (e.g., `[E004] cli/commands -> ...`), matching the
  format used by `yg validate`. Previously, node paths were silently omitted.
- **Scoped validate with parse errors:** `yg validate --scope <path>` now returns the
  parse error (E001) when the target node has a YAML syntax error, instead of the
  misleading "Node not found" message. Also handles scoping to children of broken nodes.

## [1.0.0] - 2026-03-02

### Added

- **`yg status` quality metrics:** New Quality section showing artifact fill rate, relation
  distribution (avg/max with node path), source mapping coverage, and aspect coverage.
- **`yg preflight` command:** Unified diagnostic combining journal, drift, status, and validation into a single report with exit code support.
- **Bidirectional drift detection:** `yg drift` now tracks changes to graph artifacts
  (aspects, flows, parent nodes, dependency context) alongside source files.
- New drift statuses: `source-drift`, `graph-drift`, `full-drift` replace the old
  `drift` status for finer-grained reporting.
- `--drifted-only` flag for `yg drift` to reduce output by hiding ok entries.
- `path` field on `FlowDef` for flow directory resolution.
- **Hierarchical aspect directories:** Aspects can be organized in nested directories under `aspects/` (e.g. `aspects/observability/logging/`). Nesting is organizational only — no automatic parent-child relationship; `implies` is always explicit.
- **`description` field in `aspect.yaml`:** Optional short description for discovery via `yg aspects`.
- **Hierarchy aspect propagation:** Aspects from ancestors (root→parent) propagate to child nodes. Child receives aspect content for all aspects in its hierarchy.
- **Flow aspects:** Optional `aspects: string[]` in `flow.yaml`. Aspect ids propagate to all participants. Validation: flow.aspects must correspond to aspect directories.
- **Context format (XML-like tags):** `yg build-context` outputs plain text with XML-like tags (`<context-package>`, `<global>`, `<aspect>`, `<flow>`, etc.) instead of Markdown. Content between tags is raw text.
- **Flow description.md format:** Required sections (Business context, Trigger, Goal, Participants, Paths, Invariants). `## Paths` must contain at least `### Happy path`; each other business path gets its own subsection. One flow = one business process with all variants. Spec in graph.md, rules.ts, tools.md.
- **Aspect composition (`implies`):** Aspects can declare `implies: [id, ...]` to pull in other aspects automatically. Enables bundle aspects (e.g. HIPAA) that include sub-aspects. Tools resolve implications recursively with cycle detection.
- **`node_types` with `required_aspects`:** Config supports `{ name, required_aspects? }` per node type. Nodes of that type must have coverage (direct aspect or via implies); W011 warns when missing.
- **Validation codes:** E016 (implied-aspect-missing), E017 (aspect-implies-cycle), W011 (missing-required-aspect-coverage).
- Enriched schema files (node.yaml, aspect.yaml, flow.yaml) with self-documenting
  YAML comments describing every field.

- **`yg impact --aspect <id>` mode:** Shows all nodes whose effective aspects include
  the specified aspect (own + hierarchy + flow + implies), with source attribution.
- **`yg impact --flow <name>` mode:** Shows all flow participants and their descendants.
- **`yg impact --node` enhancements:** Descendants section for parent nodes, co-aspect
  nodes section, effective aspects (own + hierarchy + flow + implies) instead of own-only.
- `collectEffectiveAspectIds` exported from context-builder for reuse.

### Tests

- **Enriched test fixture:** Added `requires-logging` aspect with description, `implies` chain
  on `requires-audit` → `requires-logging`, and `aspects: [requires-logging]` on checkout-flow.
- **Impact tests:** Source attribution (own, implied, flow, hierarchy), implies chain resolution,
  co-aspect node detection via implies and flow propagation, flow aspect display.
- **Integration tests:** Flow aspect propagation to participants via `collectEffectiveAspectIds`,
  aspect layers in context packages from flow propagation, implies chain resolution in fixture,
  non-participant isolation, flow layer `aspects` attribute.
- **E2E tests:** `impact --aspect` shows implies chain and source attribution, `impact --flow`
  shows flow aspects, `impact --node` shows co-aspect nodes.

### Fixed

- **Hierarchical `.gitignore` support in drift detection:** Directory hashing now discovers and
  respects `.gitignore` files at every level, not just the project root. Previously, patterns
  from nested `.gitignore` files (e.g. `*.db` in a subdirectory) were ignored during hash
  computation.
- **Missing gitignore filtering in `hashTrackedFiles`:** The drift detection hash function
  (`hashTrackedFiles`) was not applying any `.gitignore` filtering when expanding directory
  mappings, causing git-ignored files (`node_modules/`, `dist/`, `*.db`) to be included in
  drift hashes. This produced false drift on CI pipelines.
- **Path doubling in nested directory hashing:** `collectDirectoryFileHashes` was re-joining
  already-relative nested paths with parent paths, causing doubled path prefixes in hash
  digests.
- `yg impact --simulate` now reports correct baseline token counts (previously baseline
  context was missing node.yaml content due to temp directory cleanup).
- `yg impact` transitive dependency chains no longer include the target node in output.
- `hashPath` no longer skips mapped single files when they match `.gitignore` patterns — gitignore filtering applies only to directory scans.
- Reserved artifact name check uses `'node.yaml'` (the actual reserved filename) instead of `'node'`.
- Validator fallback budget thresholds aligned to spec defaults (10000/20000 instead of 5000/10000).
- `build-context` CLI fallback budget thresholds aligned to spec (10000/20000 instead of 5000/10000).
- `build-context` no longer exits with error on budget-error — always outputs context package, warns on stderr.
- `yg --version` now reads version from `package.json` dynamically instead of hardcoded value.
- Shallow artifact warning message now reports trimmed length (consistent with the check).
- **Crosscheck round 1 (31 items):** Comprehensive docs-vs-code-vs-rules audit.
- **Crosscheck round 2 (17 items):** Follow-up audit fixing remaining discrepancies across
  spec, user docs, rules template, and code.
- `package.json` `files` array pointed to renamed `graph-templates/` instead of
  `graph-schemas/` — schemas were missing from published npm package, breaking
  `yg init` for new users.
- Graph artifacts for `cli/io` still referenced `template-parser.ts` (renamed to
  `schema-parser.ts`) and `cli/core/context` described "6-step" assembly (spec is 5-step).
- Spec `tools.md` described tracked file collection as "six layers of context assembly"
  — clarified as "tracked file collection" (distinct from 5-step context assembly).

### Changed

- **Agent rules restructured:** Split into three cognitive sections (Core Protocol, Operations, Knowledge Base) optimized for LLM attention patterns. Added Quick Start Protocol, Bootstrap Mode, Drift Resolution, Error Recovery, and Escape Hatch.
- `.drift-state` format extended — entries now include hashes for both source and
  graph files that contribute to a node's context package.
- `yg drift` output split into two sections: "Source drift" and "Graph drift".
- `yg drift-sync --node` now captures hashes for all tracked files (source + graph),
  not just mapping files.
- Aspects now appear before relational context in context packages.
- Assembly algorithm described as 5-step (was 6-step) in docs and rules.
- Renamed `source/cli/graph-templates/` to `source/cli/graph-schemas/`.
- Renamed `template-parser.ts` to `schema-parser.ts`.
- Validation rule renames: `unknown-tag` → `unknown-aspect`, `broken-aspect-tag` → `broken-aspect-ref`, `missing-required-tag-coverage` → `missing-required-aspect-coverage`.
- **Documentation:** Updated all spec docs (`docs/idea/`), user docs (`docs/configuration.md`), graph metadata (`.yggdrasil/`), and agent rules to reflect aspects rename and hierarchy.
- Rules template: Quick Routing Reference now config-driven (no hardcoded artifact filenames).
- Rules template: flow description.md sections described as agent responsibility, not validated.
- Rules template: structural_context fallback documented in step 5.
- Spec: platform table in `tools.md` now shows delivery method (embed vs reference) per platform.
- **Artifact condition rename:** `has_tag:<name>` → `has_aspect:<name>` in config.yaml
  artifact conditions. Code accepts both for backward compatibility. Spec, user docs,
  and error messages updated to prefer `has_aspect:`.

### Removed

- Stale references to removed knowledge items concept from graph artifacts, spec,
  CHANGELOG, and test fixtures. Graph elements are: node, aspect, flow (no knowledge).
- Legacy flat string format in `.drift-state` (entries must be objects with `hash`
  and `files`).
- `getCanonicalHash` and `getFileHashes` helpers from drift-state-store (no longer
  needed with typed `DriftState`).

### Breaking

- **Context format:** Aspects in hierarchy/own/flow blocks via `aspects="id1,id2"` attribute; no `source` on `<aspect>`.
- **Aspects rename:** `node.yaml` field `tags` renamed to `aspects` (parser accepts both for backward compat). `config.yaml` field `required_tags` renamed to `required_aspects` (parser accepts both).
- **Aspect identifier:** `AspectDef.tag` renamed to `AspectDef.id` in TypeScript API. Aspect id = relative directory path under `aspects/` (e.g. `aspects/observability/logging/` → id `observability/logging`).
- **Context package XML:** `<aspect tag="...">` attribute renamed to `<aspect id="...">`.
- **`yg tags` → `yg aspects`:** Command renamed; output changed from plain text (one tag per line) to YAML with `id`, `name`, `description`, `implies`.
- **BREAKING:** Renamed `.yggdrasil/templates/` to `.yggdrasil/schemas/` — existing
  repositories must rename the directory manually or re-run `yg init`.
- **BREAKING:** Context package section order changed from
  Global → Hierarchy → OwnArtifacts → Dependencies → Aspects → Flows
  to Global → Hierarchy → OwnArtifacts → Aspects → Relational.
- Merged `Dependencies` and `Flows` sections into single `Relational` section.

## [0.3.4] - 2026-02-27

### Changed

- **Release workflow:** Triggers on `workflow_run` (after Tag Release) or `push` of tag `v*`. Fixes npm publish not running when tag is pushed by GITHUB_TOKEN.

## [0.3.3] - 2026-02-27

### Added

- **README:** Primary goals (build knowledge for new projects, reverse-engineer existing codebases, autonomous maintenance). Upgrade section with CLI update and `yg init --upgrade` instructions.
- **Rules:** Reverse-engineering order — when mapping existing code, create aspects → flows → model (never model before cross-cutting rules).

## [0.3.2] - 2026-02-25

### Changed

- **Optional artifacts:** rules no longer hardcode artifact names (logic, model, constraints, state, decisions). Agent reads `config.artifacts` and considers each artifact with `required: never` when creating/editing nodes. Added "Optional Artifacts — Explicit Consideration" block with interpretation of `required: never` and "don't be over-eager", plus post-node checklist.

## [0.3.1] - 2026-02-25

### Added

- **Answering Questions workflow** in rules: when the user asks about a specific file/area and the path is known, run `yg owner` + `yg build-context` and base the answer on that context (even when not modifying files). Failure state: answering about a mapped file without build-context when path is known.

## [0.3.0] - 2026-02-25

### Added

- Flow writing instruction in rules: write flow content (e.g. `description.md`) business-first — user/business perspective, technical details as inserts only
- **Flow propagation down hierarchy:** flows now attach to listed nodes and their descendants. A child node receives flow context when its ancestor (parent, grandparent, etc.) is a participant, even if the child is not explicitly listed in `flow.nodes`
- Tests for flow ancestor propagation

### Changed

- Drift handling: agent automatically runs `yg drift-sync` when drift is detected (preflight and wrap-up). No longer asks user "Absorb or Reject" — user does not need to know Yggdrasil internals
- Wrap-up trigger: added "ok" as a phrase that triggers session verification
- context-builder: `collectParticipatingFlows` now considers node + all ancestors; spec (docs/idea) updated accordingly

## [0.2.0] - 2026-02-24

### Changed

- Updated agent prompt; ran iterations to align code with graph

## [0.1.0] - 2026-02-21

### Added

- Initial release
