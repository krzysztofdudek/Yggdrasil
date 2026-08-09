# Agent Instructions — Yggdrasil Repository

You work on the Yggdrasil repository: an open-source CLI that makes a rule written once hold in every later session. A rule is attached to the code it governs, the agent editing a file gets only the rules that touch it, and a change has to satisfy them before it moves on. Some rules are local scripts that run for free; some are prose a separate model judges. Every verdict is tied by hash to the code it checked, so CI re-proves the set without a key.

This repo both implements that tool and runs it on itself, so the graph under `.yggdrasil/` is a live example as well as the thing being enforced on your work here.

## Context — Where Things Live

| Path                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `source/cli/`           | Implementation — CLI code.                                                          |
| `.yggdrasil/model/cli/` | Graph — describes intended CLI architecture. Aspects enforce rules on source code.  |
| `docs/`                 | User docs — for adopters.                                                           |
| `scripts/`              | The quality gate (`repo-check.sh`) plus dogfood **measurement instruments** — deliberately NOT `yg` commands. See [CONTRIBUTING](CONTRIBUTING.md#the-scripts-directory) before assuming one belongs in the CLI. |
| `tools/`                | Repo tooling outside the shipped CLI (the demo GIF renderer). Has its own README. |
| `.plans/`               | Agent working dir — design docs and implementation plans. **Ignore skill paths** (e.g. `docs/plans/`) — always use `<root>/.plans/YYYY-MM-DD-<topic>-design.md` and `.plans/YYYY-MM-DD-<topic>-plan.md`. Gitignored; not committed. |

## Product Scope

`rules.ts` (printed by `yg prime`) and the committed AGENTS.md digest are consumed by agents in ANY repository that adopts Yggdrasil — not just this one. When editing rules content, examples, or guidance: use domain-neutral examples (no Yggdrasil-specific types or commands). Think "what would help an agent working on an e-commerce app or a mobile game?" not "what would help an agent working on this CLI."

## Constraints

- Never hand-edit the marker-delimited Yggdrasil digest block in `AGENTS.md` (or `.clinerules/yggdrasil.md`) — it is generated. To change rules content: edit `source/cli/src/templates/rules.ts` (full manual) or `source/cli/src/templates/digest.ts` (committed digest), then rebuild and regenerate: `node source/cli/dist/bin.js init --upgrade` from repo root (repo-check's digest assertion fails the commit otherwise — it tells you the exact command).
- **Ignore the generated digest block** for understanding; the source of truth is `templates/rules.ts` + `templates/digest.ts`.
- **Always reflect changes in corresponding documentation.** When modifying code behavior, algorithms, or data structures, identify and update all documentation that describes the changed behavior — `docs/` (user docs) and `.yggdrasil/` (graph metadata). Changes to behavior are not complete until every document describing that behavior is consistent.
- **NEVER run `yg init` from a subdirectory.** Always run from the repository root. Running from `source/cli/` or any subdirectory creates a new `.yggdrasil/` there or corrupts the project config. Use `node source/cli/dist/bin.js` for local builds, not `npx yg` (which may use a cached global version).

## Yggdrasil-derived local state lives under `.yggdrasil/`

All Yggdrasil-derived local/rebuildable state (caches, indexes, scratch state) MUST live under the `.yggdrasil/` directory — never at the repo root or elsewhere. Gitignore it within `.yggdrasil/` (it is rebuildable and must not be committed). Examples: the relation pass's content-addressed AST fact cache lives under `.yggdrasil/.ast-cache/`, and the deterministic-verdict cache at `.yggdrasil/.yg-lock.deterministic.json` (rebuilt for free by `yg check --approve --only-deterministic`) — both dot-prefixed and gitignored. (`.symbols-cache/` is a retired predecessor: nothing writes it any more, and it stays in the installed gitignore list only so an old checkout's leftovers keep being ignored. Do not treat it as the live cache.) Do not scatter Yggdrasil state outside `.yggdrasil/` (no root-level `.yg-cache/` etc.). The committed graph (model/aspects/flows/lock) also lives here; keep derived state in dot-prefixed, gitignored subdirectories so it never mixes with the committed graph.

## Adding Support for a New Agent

Universal install covers every agent that reads AGENTS.md natively; Claude Code via the `CLAUDE.md` import; Cline via `.clinerules/`. A new agent needing a bespoke file is a design decision — open it with the maintainer before adding an installer.

## Version Bump & Changelog

- **Changelog is always updated.** Every code or behavior change gets an entry under `## [Unreleased]` in `CHANGELOG.md`. This happens as part of normal work — do not wait for a release.
- **A changelog entry records what changed between versions — it is not a work log.** Write for someone reading release notes: what was wrong, what is now true, why it matters to them. Leave out how you found it, what you ran to verify it, and the order you did things in. "Verified by reproducing each case and comparing output" is your method, not a change. One entry per change, not one per step; group related fixes rather than listing each file you touched.
- **Version bumps only on explicit user request.** Never bump the version in `source/cli/package.json` unless the user explicitly asks for a release. When they do:
  1. Bump version (patch/minor/major per [semver](https://semver.org/)).
  2. Run `npm install` in `source/cli/` to update `package-lock.json`.
  3. Move current version entries to a release section in `CHANGELOG.md`.
- **Two distinct version notions — do not conflate them.** The `package.json` version is the release/marketing version and moves on every release. The **graph schema version** is separate: it lives in `CLI_SUPPORTED_SCHEMA` (`core/graph-loader.ts`) and the `version:` field of `templates/default-config.ts`, and it advances ONLY when the graph format/migrations change — never for a code-only patch. `yg init` compares a project's graph version against `CLI_SUPPORTED_SCHEMA` (not the package version) to decide whether an upgrade is needed. Bumping `package.json` does NOT require bumping the schema version; bump the schema version (in both places, plus a migration) only when the graph format actually changes.

## CLI Message Design Principle

Every diagnostic message the CLI outputs to an agent must follow the **what / why / next** structure:

- **WHAT** happened — facts, one line or short block
- **WHY** it's a problem — context the agent needs to understand the situation
- **NEXT** — concrete command or instruction to resolve

Use `buildIssueMessage({ what, why, next })` from `source/cli/src/formatters/message-builder.ts` for all error/warning messages in validator, check, approve, and build-context. The builder enforces the structure; the caller handles presentation (indentation, error code prefix).

This applies to CLI output only. Rules.ts (system prompt) provides the map — workflow, vocabulary, categories. CLI provides the GPS — specific errors, next commands. They share vocabulary but never duplicate information.

## Quality Gate

**ALWAYS run `scripts/repo-check.sh` from repo root before ANY commit and ensure it passes cleanly.** Do not commit with failing checks. This is non-negotiable — every commit must leave the repo in a green state. Do not run these individually before committing — `repo-check.sh` covers everything. The pre-commit hook also runs `repo-check.sh`, so there is no need to run it manually before committing either.

The gate is 17 fail-fast steps, in order: CLI typecheck; portal-e2e typecheck; lint; build; a built-binary guard (so the E2E suites cannot silently skip); a pack smoke; the deterministic cache as a test prerequisite; tests with coverage; a coverage >= 90% threshold; the AST-cache false-green audit; a Chromium-present guard; the portal E2E driving real Chromium through Playwright; docs build; markdown lint; digest freshness; a reviewer prompt-size headroom measurement (reports the largest assembled LLM prompt and its margin under the configured tier ceiling — never fails the gate on its own); and finally the graph check, which runs `yg check --approve --only-deterministic` (free and keyless — it rebuilds the cache and reports in one step).

Two of those bite in ways the category list would not warn you about:

- **The portal E2E needs Chromium installed for Playwright.** Without it the guard fails the gate by design rather than letting the suite skip. Install it once: `(cd source/cli && npx playwright install --with-deps chromium)`.
- **The digest gate is not repo-root-only.** It checks both installed artifacts — `AGENTS.md` and `.clinerules/yggdrasil.md` — at the repo root *and* in every `examples/*/` directory that carries its own `.yggdrasil/`. So after editing `templates/digest.ts`, one `init --upgrade` at the root is not enough: each such example needs its own, run from that directory against this repo's built binary. A newly added example with a graph but no agent-rules install fails this step too.

Only seven of the seventeen steps are themselves protected against being quietly dropped, by the advisory `repo-check-gate-steps` rule (typecheck, lint, build, test/coverage, docs build, markdownlint, graph check). The other ten rest on this list alone — if you add or remove a step, update it here.

## Dogfood Issue Tracking

While working in this repo, if you encounter a problem with the CLI itself or with the rules/knowledge content (contradictions, missing warnings, misleading examples), append an entry to `.temp/dogfood-report.md`. Format:

```
## <date> — <short title>
**WHAT:** <what happened>
**WHERE:** <file:line or command>
**WHY:** <why it matters>
**REPRO:** <steps to reproduce>
```

Mark entries **RESOLVED** (with commit SHA) once fixed, or **DEFERRED** (with reason) when punted.

## Memory

Do NOT use the auto memory system. All persistent knowledge goes into CLAUDE.md or AGENTS.md — nowhere else.

## Working Preferences (maintainer-set; apply by default in this repo)

- **Quality over cost.** Iterate as much as needed; do not skimp on rigor to save effort or tokens.
- **High bar, out-of-the-box.** Aim for genuinely excellent — not "good enough" — and think past the obvious framing.
- **Never hardcode assumptions; derive and verify.** Establish facts from the real config/code and check them, rather than asserting "probably X" when X depends on configuration. (E.g. whether a reviewer costs money or needs an API key depends on the configured provider — a hosted API does; a local/CLI provider like `claude-code` does not — read the config, don't guess.)
- **Don't expose internals in user-facing surfaces.** A person sees *what* is happening in plain terms — not the names of commands, flags, or internal mechanisms.
- **Use multi-agent processes for substantive work** — opinion panels, adversarial review, research workflows — rather than a single pass. When external research is wanted, offer a ready-to-run research prompt in a code block so the maintainer can run it with their own agent.
- **Subagents run on Sonnet or Opus only — set the model explicitly on every spawn.** Never launch a subagent that silently inherits the session model. Default to Sonnet for research/mechanical work, Opus for hard synthesis or judging. Instruct subagents not to spawn their own agents (nested spawns would bypass the model choice).
- **Ground yourself before designing.** Read all of `yg knowledge` and `yg schemas` so you understand the engine completely before proposing a design.
- **Graph before code, hierarchically; lock the design in.** Design the target architecture + aspects up front, then calibrate as work proceeds. Concrete ("betonuj") the intended rules, relations, and architecture in Yggdrasil — a hierarchical model + aspects — so a future session cannot build anything inconsistent with the design (`yg check` refuses the drift). Where a preference here is mechanically checkable, prefer encoding it as an **aspect**, not just prose.
- **No artificial mocking.** Tests run against real on-disk fixture projects (a real `.yggdrasil/` graph + real source), never fabricated data. E2E tests use **only the public CLI surface** (spawn the built `bin.js`), drive the real output in **Playwright + Chromium** — every path, properly, not a token smoke test — and assert consistency with `yg check`. This matches the repo's existing `source/cli/tests/fixtures/**` + `source/cli/tests/e2e/` convention.

**Task-dependent — ask, don't assume.** A few preferences vary by task; at the start of a relevant task, ask the maintainer rather than defaulting:
- **Working mode** — run fully autonomously with minimal reporting, or collaborate with check-ins along the way.
- **Visual deliverables** — whether to route the visual layer through Claude Design (rendered previews on claude.ai) for review.

## When Evaluating `yg check` or `scripts/repo-check.sh`

Consider both:

1. **Product** — Is the command correct and useful for adopters?
2. **Dogfood** — Is this repo's graph coverage correct and complete?

<!-- yggdrasil:start -->
<!-- yggdrasil:digest cli=5.7.2 sha256=a94d3f23a66367520d042063e75e36f6ef1ad1ab5d131592f5f34160912c506f -->
## Yggdrasil

This repository is managed by Yggdrasil — continuous architecture enforcement.
An architecture graph in `.yggdrasil/` defines the rules; a reviewer verifies
source code against them, and `yg check` blocks CI whenever an enforced rule
is violated or unverified.

**Required first step:** run `yg prime` and follow the protocol it prints
before making any change. The full, current operating manual comes from the
installed CLI — this block is only the standing summary. If `yg prime` is not
a recognized command, the installed Yggdrasil CLI predates this integration:
update the `@chrisdudek/yg` package before proceeding.

Non-negotiable invariants (they hold even before reading the manual):

- Never write a `yg-suppress` marker without the user's explicit
  confirmation. The reviewer honors suppressions unconditionally — an
  unauthorized suppress silently disables a rule.
- Never change a rule's `review_by:` date; renewing or retiring a rule is
  the user's decision.
- Treat `yg advise` items and incidents as proposals: dismissing, deferring,
  or recording one requires the user's approval. Never fabricate an incident.
- Changes to `.yggdrasil/yg-architecture.yaml` require the user's
  confirmation.
- Log entries (`yg log add`) carry WHY in self-contained prose — no
  references to plans, file paths, steps, or conversation state.
- Never hand-edit `.yggdrasil/` lock files.
- If the user explicitly requests a code-only change without graph updates,
  comply but warn: the affected rules stay unverified and CI stays red. Do
  not run `yg check --approve` — leave the rules unverified.

Start every session with `yg check`; re-print the manual any time with
`yg prime`.
<!-- yggdrasil:end -->
