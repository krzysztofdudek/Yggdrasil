# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
