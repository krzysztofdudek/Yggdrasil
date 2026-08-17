# Yggdrasil Agent Plugin & Marketplace — Implementation Plan

**Base branch:** `feat/progressive-mode-live-scope` (unreleased; all work stacks on it — a new branch
is cut from it, never from `main`). **Deliverable of this plan:** this repository becomes the
**plugin marketplace**, and a plugin brings Yggdrasil to agents *before* `yg init` has ever run in
a repo — carrying what today has to be copied into each repository, detecting the missing CLI,
and wiring the right hooks automatically where the host tool supports them.

**Grounding.** Written against: the progressive-mode branch (docs/progressive-mode.md, the rules.ts
protocol additions, config `progressive:` block), the current installer surfaces
(`init-scaffold.ts`, `rules-artifacts.ts`, the three installed artifacts AGENTS.md / CLAUDE.md /
`.clinerules/yggdrasil.md`), the roots integration design (hooks §8.2, two-regimes law), and an
August-2026 survey of the four host tools' extensibility (verified against official docs; the one
low-confidence area is flagged in §3.4).

---

## 0. The problem this solves

Today the agent contract travels **inside each adopted repository**: `yg init` writes the digest
into AGENTS.md, the CLAUDE.md import, and `.clinerules/`. That is correct and stays — it is the
universal, tool-agnostic baseline. But it has three gaps a plugin closes:

1. **Cold start.** An agent opening a repo that *uses* Yggdrasil but whose CLI is not installed
   locally gets a digest telling it to run `yg prime` — and a shell that says `command not found`.
   Nothing tells it how to fix that. The plugin detects the situation at session start and says
   exactly one thing: install `@chrisdudek/yg`, then `yg prime`.
2. **No runtime.** The digest is prose; nothing *runs*. Host-native hooks can execute the protocol
   automatically — fresh `yg prime --digest` injected at session start (never stale, because it
   comes from the installed CLI, not from a committed copy), a check whisper after edits, a
   completeness nudge at stop — with the noise discipline the roots design already codified.
3. **Distribution.** A team's agents should get all of this by adding one marketplace and
   installing one plugin — not by every repo copying hook scripts around.

## 1. The honest per-tool reality (what the plugin can even be)

| Tool | Installable unit a third-party repo can ship | Hooks | Reads AGENTS.md natively |
|---|---|---|---|
| **Claude Code** | full plugin via marketplace repo (`.claude-plugin/marketplace.json`): commands, skills, hooks, MCP | yes — mature (SessionStart, PreToolUse, PostToolUse, Stop, …) | via the CLAUDE.md `@AGENTS.md` import `yg init` already writes |
| **Cursor** | no plugin/marketplace; unit = committed `.cursor/hooks.json` + `.cursor/rules/*.mdc` + `.cursor/mcp.json` | yes — mature (sessionStart, preToolUse, postToolUse, afterFileEdit, stop, …) | yes (native) |
| **Codex** (OpenAI CLI) | no plugin/marketplace; unit = AGENTS.md + `.codex/skills/` (same SKILL.md format as Claude) + MCP in config.toml; hooks exist but are feature-flagged, experimental, with a known repo-local reliability bug | experimental — do not depend on | yes (native) |
| **GitHub Copilot** | no plugin, no hooks (Extensions deprecated 11/2025 in favor of MCP); unit = AGENTS.md (read natively since 06/2026) + `.github/copilot-instructions.md` + MCP server | none | yes (since 06/2026) |

Design consequence, stated bluntly: **"one plugin for four tools" is really one *distribution repo*
with four grades of integration.** Claude Code gets a true plugin from a true marketplace. Cursor
gets committed hook/rules files (installed by `yg init --agent cursor`, opt-in). Codex and Copilot
get what they can take: the AGENTS.md they already read, plus an optional MCP server that is the
only *runtime* mechanism all four tools share. The plan never pretends a host has a capability it
lacks.

## 2. Architecture — four layers, each degrading to the one below

```
L3  Claude Code plugin (marketplace: THIS repo)        ← hooks + skill + MCP, auto-wired
L2  Cursor hooks + rules  /  Codex skill               ← committed files, installed by yg init --agent
L1  MCP server (`yg mcp`)                              ← the one runtime shared by all four tools
L0  AGENTS.md digest + CLAUDE.md import + .clinerules  ← today's universal baseline (unchanged)
```

Every layer above L0 is **additive and optional**; removing any of them leaves a working contract.
Every hook script begins with the same two guards and degrades to *silence*, never to an error:

```sh
command -v yg >/dev/null 2>&1 || { emit_install_note_once; exit 0; }
[ -d .yggdrasil ] || exit 0     # repo does not use Yggdrasil — the plugin stays mute
```

The install note (the only thing the plugin says when the CLI is missing) is one sentence:
*"This repository is governed by Yggdrasil; install the CLI (`npm i -g @chrisdudek/yg`) and run
`yg prime` before editing."* It is emitted once per session, not per event.

## 3. Work packages

### WP1 — The marketplace in this repository

- `.claude-plugin/marketplace.json` at repo root: `name: "yggdrasil"`, owner block, one plugin
  entry `{ "name": "yggdrasil", "source": "./plugin/claude-code" }`. Adding a second plugin later
  (e.g. a roots-specific one) is an array append.
- `plugin/claude-code/` — the plugin itself (WP2). `plugin/` also hosts the per-tool assets the
  installer copies for Cursor/Codex (WP4), so all agent-integration material lives under one root
  with one README.
- Version discipline: the plugin's `plugin.json` `version` tracks the CLI's minor version it was
  tested against; the SessionStart hook compares `yg --version` against a `minCliVersion` baked
  into the plugin and *says* (once) when the CLI is older than the plugin expects. No hard failure.
- Install UX documented in README + docs: `/plugin marketplace add krzysztofdudek/Yggdrasil`,
  `/plugin install yggdrasil@yggdrasil`; team-wide via `.claude/settings.json`
  `extraKnownMarketplaces` + `enabledPlugins` (this repo dogfoods that in its own settings).

### WP2 — The Claude Code plugin

Layout (component dirs at plugin root, manifest in `.claude-plugin/`):

```
plugin/claude-code/
  .claude-plugin/plugin.json
  hooks/hooks.json
  scripts/session-start.sh  post-edit.sh  stop-sweep.sh  lib.sh
  skills/yggdrasil/SKILL.md
  commands/yg-status.md            (thin: prints yg check header + suggestedNext)
```

Hooks (`hooks.json`), each `type: "command"` calling a script under `${CLAUDE_PLUGIN_ROOT}`:

| Event | Script behavior (after the two guards of §2) |
|---|---|
| `SessionStart` | Emit `additionalContext`: live `yg prime --digest` output + the `yg check` header line (which under progressive mode already carries "N obligations outside your changes vs <ref>") + one line naming the three commands that matter first (`yg prime`, `yg context --file`, `yg check`). Budget: ≤ 40 lines of context, hard-truncated. |
| `PostToolUse` (matcher `Write\|Edit`) | Whisper, not gate: run `yg context --file <edited> --brief` (WP6) and emit only the **delta-relevant** part — the rules whose pairs the edit just invalidated (computed the cheap way: the brief's arm-preview, §WP6). Budgeted: max 1 emission per file per session (session-scoped dedup file under `/tmp`), silence when the file is unmapped and type-uncovered. When the roots subsystem exists and is initialized, the same script appends `yg roots check <file> --hook post` output — the roots design's §8.2 wiring lands here *for free* instead of via `yg roots hooks install --agent claude-code`. |
| `Stop` | Honor `stop_hook_active`. Run `yg check`; if anything the session is accountable for is red (progressive mode: *yours*; otherwise: anything), emit a one-paragraph reminder with the header line and `suggestedNext`. Never blocks — it informs the stop, it does not veto it. |

Deliberate omissions, named: no `PreToolUse` deny hook until roots' calibrated DENY exists (the
plugin has nothing legitimate to block with today); no `UserPromptSubmit` hook (adds latency to
every prompt for no protocol value).

The **skill** (`skills/yggdrasil/SKILL.md`) is the interactive counterpart: description-triggered
("architecture rules, yg, Yggdrasil, why is the build red, where do I put X"), teaching the
workflow loop and pointing at `yg knowledge`. Content is generated from the same source as the
digest (one new template in `templates/`), so the digest-staleness gate learned in this repo
applies: a build-time assertion keeps SKILL.md and digest.ts in step.

### WP3 — `yg mcp` — the cross-tool runtime (the only one all four hosts share)

New CLI subcommand: `yg mcp` runs a **stdio MCP server** exposing read-only graph intelligence as
tools: `prime_digest`, `context_for_file`, `check_status` (header + grouped findings, honoring
progressive mode), `impact`, `find`, `knowledge_read`, plus — post-roots — `roots_where` /
`roots_spectrum`. Explicitly **no write tools** (no approve, no log add, no suppress): MCP callers
are not the accountable session the lock/log semantics assume; writes stay in the shell where the
human confirms them. Implementation: thin adapter over the same core functions the CLI commands
call; JSON-RPC framing via the official SDK; one integration test per tool speaking real stdio.

Registration recipes shipped in docs and `plugin/`:
Claude Code — bundled in the plugin's `mcpServers` (`{"yggdrasil":{"command":"yg","args":["mcp"]}}`);
Cursor — `.cursor/mcp.json`; Codex — `codex mcp add yggdrasil -- yg mcp`; Copilot/VS Code — MCP
config pointing at `yg mcp`. Same guard philosophy: the server starts only where `.yggdrasil/`
exists; otherwise it exits with a clear message.

### WP4 — Per-tool installers: `yg init --agent <tool>` (opt-in, printed before written)

Extends `yg init`/`--upgrade` with explicit, additive agent wiring (the universal L0 artifacts
remain unconditional, exactly as today):

- `--agent cursor`: writes `.cursor/hooks.json` (sessionStart / afterFileEdit / stop — same three
  behaviors as WP2, same scripts vendored into `.yggdrasil/agents/cursor/` so the repo is
  self-contained) and `.cursor/rules/yggdrasil.mdc` (`alwaysApply: true`, content = digest). Both
  merged non-destructively: existing keys preserved, ours added; refusal with a clear message when
  a same-named key exists with different content.
- `--agent codex`: writes `.codex/skills/yggdrasil/SKILL.md` (same generated content as WP2's
  skill). **No Codex hooks** — feature-flagged + known repo-local reliability bug; revisit when
  stable (tracked as an explicit deferral, not silently dropped).
- `--agent copilot`: writes `.github/instructions/yggdrasil.instructions.md` (`applyTo: "**"`,
  digest content) — additive next to any existing copilot-instructions.md. Nothing else exists to
  install there.
- Per AGENTS.md's standing rule ("a new agent needing a bespoke file is a design decision — open
  it with the maintainer"): this WP *is* that decision, taken once here for the three tools above;
  the digest-freshness gate extends to every artifact this WP writes (one generated-content
  assertion covering AGENTS.md, .clinerules, SKILL.md, .mdc, .instructions.md).

### WP5 — Plugin-side delivery of "what is currently copied into the repo"

The plugin must be useful in a repo where `yg init` has *not* installed artifacts (adopter added
the marketplace org-wide before the repo adopted): the SessionStart hook's live `yg prime --digest`
covers exactly the content that would have been committed — fresher, since it comes from the
installed CLI. When the CLI is absent too, the single install note (§2) is the entire delivery.
No static digest copy is bundled in the plugin — a bundled copy is a staleness bug by construction;
the CLI is the single source, and the one-sentence note is evergreen.

### WP6 — `yg context` progressive disclosure (the exploration surface)

Today `yg context --file` prints every applicable rule's full description inline — correct for
"about to edit", heavy for "exploring". Layered redesign, all read-only:

1. **`--brief` (and the default for the MCP `context_for_file` tool):** owner + type, one line per
   rule — `[status] id — first sentence` + its `read:` path — log-gate state, relations one-hop,
   flows. Target ≤ 30 lines. The full dump stays as today's default CLI behavior (agents' manual
   already teaches it), `--brief` is the opt-in compact form the hooks and MCP use.
2. **Expansion pointer per item:** every brief line ends with the exact command that expands it
   (`yg context --file X --aspect <id>` prints that one rule's full text + references list). One
   new flag, no new subcommand.
3. **Progressive-mode awareness (the branch's one missing integration):** when `progressive.reference`
   is set, context marks each rule's pairs for this file as **yours** (in measured scope now) or
   **inherited** (outside changes), using the same measurement `yg check` already computes — and
   prints the one-line scope header ("your change so far: N files; this file is/is not in it").
   An exploring agent learns *before editing* whether touching this file pulls inherited debt into
   scope. Cheap: the measurement is already produced per run; context reuses it read-only.
4. **Arm preview:** one line — "editing this file invalidates N pairs (M free / K reviewer calls)"
   — the `yg impact --file` number folded into context so the cost signal arrives at exploration
   time, not after the edit. Computed from the same expected-pairs set; no reviewer contact.
5. **Trail pointers, not content:** the brief ends with up to three `next:` lines (log read for the
   owner node; the parent node's context; the aspect list of the node) — teaching the *next* layer
   instead of dumping it. This is the same two-regime law as roots: unsolicited output stays small;
   depth is one explicit command away.
6. **Reserved section for roots** (post-integration): the conventions card from the roots design
   §3 lands as section 6 of the brief — the design already specifies it; this WP only keeps the
   slot stable so the plugin's post-edit whisper needs no format change later.

### WP7 — Tests, docs, gate

- **Tests** (repo conventions: real fixture repos, built-binary E2E, no mocks): marketplace/plugin
  JSON schema assertions (valid against Claude Code's documented shapes); hook scripts run against
  a fixture repo in three states (no CLI on PATH → single note; CLI + no `.yggdrasil/` → silence;
  full → correct emissions, budget respected, dedup honored) — the "no CLI" case runs the scripts
  with a stripped PATH; `yg mcp` integration tests over real stdio (one per tool call, incl.
  progressive-mode header passthrough); `yg init --agent <tool>` round-trip tests (fresh write,
  idempotent upgrade, non-destructive merge, refusal on conflict); `yg context --brief`/`--aspect`
  golden outputs incl. progressive yours/inherited marking; generated-content freshness assertion
  across all five artifact kinds.
- **Docs**: one new docs page ("Agent integration: plugin, hooks, MCP") with the per-tool honesty
  table from §1; README section for the marketplace add/install one-liners; CLI reference entries
  (`yg mcp`, `yg init --agent`, `yg context --brief/--aspect`); knowledge topic `agent-integration`.
- **Digest/rules updates**: rules.ts gains the MCP note ("if your host exposes yggdrasil MCP tools,
  `context_for_file` before editing replaces the shell call") — domain-neutral wording; regenerate
  via the standing procedure (root + every `examples/*/`).
- **Changelog**: one entry per shipped WP under `## [Unreleased]`.
- **Repo-check**: no new gate steps; everything rides typecheck/lint/build/test/coverage. The
  plugin's shell scripts get shellcheck via the existing lint step (config addition, not a step).

## 4. Order of work and dependencies

```
WP6 (context --brief/--aspect + progressive marking)   ── no deps; immediately useful in CLI alone
WP3 (yg mcp)                                           ── consumes WP6's brief as its context tool
WP1+WP2 (marketplace + Claude Code plugin)             ── hooks consume WP6 (--brief) and ship WP3 registration
WP4 (init --agent cursor/codex/copilot)                ── vendors WP2's scripts; independent of WP3
WP5 is a property of WP2, verified by its tests
WP7 rides each WP's landing
```

Suggested increments (each lands green on the progressive base branch):
1. WP6 → 2. WP3 → 3. WP1+WP2 → 4. WP4 → 5. docs/knowledge polish (WP7 tail).

## 5. Decisions taken here (so implementation doesn't re-litigate)

1. **No static digest bundled in the plugin** — live CLI output or the one-sentence install note
   (§WP5). Staleness is the enemy the whole product exists to kill; the plugin must not reintroduce it.
2. **MCP server is read-only.** Writes (approve, log, suppress, promote) remain shell-only, where
   the accountable session and the human-confirmation invariants live.
3. **Hooks whisper, never gate** — until roots' calibrated DENY exists; then only its pre channel
   may deny, exactly per the roots design. Progressive mode's philosophy (only what you reached
   blocks) extends to plugin behavior: the Stop-hook reminder scopes to *yours* under measurement.
4. **Cursor/Codex/Copilot wiring is repo-committed via `yg init --agent`, not user-global** — the
   repo is the unit of team consistency (same reason the digest is committed), and none of the
   three has a marketplace to distribute through anyway.
5. **Codex hooks: explicitly deferred** (flagged experimental + known bug), revisited on stability
   — recorded here so it is a decision, not an omission.
6. **The plugin never runs `yg init` or writes into the repo** — it wires the session, not the
   project. Repo mutation stays behind explicit `yg init` invocations by the human/agent.

## 6. Risks

1. **Host-API drift** (plugin manifests, hook schemas are young): pinned by schema-assertion tests
   that fail loudly on shape changes; the plugin's own README states the last-verified host
   versions. Cursor's exact hook field names are the one low-confidence area (docs unreachable
   directly during research — corroborated via secondary sources): WP4's first task is a live
   verification against a real Cursor install before the JSON is frozen.
2. **Noise erosion** — same canary as roots: budgets and dedup are in the hook scripts from day
   one, and this repo dogfoods the plugin (own `.claude/settings.json` enables it); if it annoys
   here, it ships nowhere.
3. **Version skew** (plugin newer than CLI): `minCliVersion` handshake in SessionStart, one-line
   notice, never a failure (§WP1).
4. **PATH reality** (agent shells without global npm bin): the guard treats "not found" as the
   install-note case; docs show `npx @chrisdudek/yg` as the no-install alternative the hooks also
   try (`command -v yg || npx --yes @chrisdudek/yg` is deliberately NOT used in hooks — network
   latency per event is unacceptable; npx appears only in the printed advice).

---
*Companion documents: roots integration design (hooks §8.2 lands inside WP2's post-edit script);
progressive-mode docs on the base branch (the measurement WP6.3 reuses).*
