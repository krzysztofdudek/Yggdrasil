# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

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

### Removed

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
- **Rules:** Reverse-engineering order — when mapping existing code, create aspects → flows → knowledge → model (never model before cross-cutting rules and shared wisdom).

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
- Tests for flow ancestor propagation, flow-scoped knowledge, and scope-nodes knowledge

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
