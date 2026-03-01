# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-01

### Changed

- **BREAKING:** Renamed `.yggdrasil/templates/` to `.yggdrasil/schemas/` — existing
  repositories must rename the directory manually or re-run `yg init`.
- Enriched schema files (node.yaml, aspect.yaml, flow.yaml) with self-documenting
  YAML comments describing every field.
- Renamed `source/cli/graph-templates/` to `source/cli/graph-schemas/`.
- Renamed `template-parser.ts` to `schema-parser.ts`.

## [Unreleased]

### Breaking

- **Context format:** Aspects in hierarchy/own/flow blocks via `aspects="tag1,tag2"` attribute; no `source` on `<aspect>`.
- **config.tags removed:** Tag = aspect directory name (e.g. `aspects/deterministic/` → tag `deterministic`). Valid tags = `yg tags` output.
- **aspect.yaml:** `tag` field removed; tag inferred from directory name.
- **New:** `yg tags` command — lists valid tags (aspect directory names).

### Added

- **Hierarchy tag inheritance:** Tags from ancestors (root→parent) propagate to child nodes. Child receives aspects for all tags in its hierarchy. Provenance: `source="hierarchy:<path>"` for ancestor tags, `source="node"` for own tags. Precedence: node > hierarchy > flow.
- **Flow aspects:** Optional `aspects: string[]` in `flow.yaml`. Tags propagate to all participants; aspects appear in context with `source="flow:Name"`. Validation: flow.aspects tags must exist in config and have corresponding aspect.
- **Context format (XML-like tags):** `yg build-context` outputs plain text with XML-like tags (`<context-package>`, `<global>`, `<aspect>`, `<flow>`, etc.) instead of Markdown. Content between tags is raw text. Provenance on aspects: `source="node"` or `source="flow:Name"`.
- **Flow description.md format:** Required sections (Business context, Trigger, Goal, Participants, Paths, Invariants). `## Paths` must contain at least `### Happy path`; each other business path gets its own subsection. One flow = one business process with all variants. Spec in graph.md, rules.ts, tools.md.
- **Aspect composition (`implies`):** Aspects can declare `implies: [tag, ...]` to pull in other aspects automatically. Enables bundle aspects (e.g. HIPAA) that include sub-aspects. Tools resolve implications recursively with cycle detection.
- **`node_types` with `required_tags`:** Config supports `{ name, required_tags? }` per node type. Nodes of that type must have coverage (direct tag or via implies) for required tags; W011 warns when missing.
- **Validation codes:** E016 (implied-aspect-missing), E017 (aspect-implies-cycle), W011 (missing-required-tag-coverage).

### Changed

- **Documentation:** `docs/configuration.md` — node_types format; `docs/idea/tools.md` — config schema, aspect.yaml implies, full validation table including W010 (missing-schema); `validator/logic.md` — aligned with current checks (removed knowledge-related, added implies/required_tags).

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
