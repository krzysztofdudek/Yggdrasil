# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Documentation:** Renamed `docs/idea/` to `docs/concept/`; updated all references in VitePress config, AGENTS.md, and graph metadata.

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
