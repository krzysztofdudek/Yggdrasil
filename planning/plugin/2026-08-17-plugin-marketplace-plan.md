# Yggdrasil — Unified Implementation Plan: complete roots · four plugin marketplaces · context disclosure

**Base branch:** `feat/progressive-mode-live-scope` (unreleased). The implementation branch is cut
from it; nothing here targets `main` directly.

**Scope law:** this plan covers, in full, with nothing deferred out of it:
(A) the **complete roots subsystem** exactly as the integration design specifies it
(`planning/roots/2026-08-17-yg-roots-integration-design.md` — every mechanism, all 16 grammars,
all commands, all stores, promotion, calibration, DENY);
(B) **this repository as a plugin marketplace for all four host tools** — Claude Code, GitHub
Copilot, Cursor, OpenAI Codex — each with a first-class plugin (verified August 2026: all four
have plugin systems with GitHub-repo marketplaces; facts in Appendix A);
(C) the **progressive-disclosure redesign of `yg context`**, including its progressive-mode
integration and the roots conventions section.
Anything removed from this scope requires the owner's explicit decision — the plan itself never
drops an item.

**Normative companions.** Mechanism internals: the v6 spec. Integration shape: the roots
integration design. Progressive-mode semantics: `docs/progressive-mode.md` on the base branch.
Where this plan sequences or refines those documents it says so; it contradicts none of them.

---

## 0. One paragraph of shape

Roots lands as `source/cli/src/roots/` and the `yg roots` command tree — measured architecture
beside the declared graph, keyless and deterministic, never gating CI. The plugin layer makes the
whole product ambient in agent sessions: one repo, four marketplace manifests, four plugins built
from one shared core — session bootstrap (live digest + check header), post-edit whisper
(context brief + roots verdicts), stop sweep (yours-scoped, completeness), pre-edit DENY (roots'
calibrated channel only, on hosts with reliable hooks), and a read-only MCP server as the runtime
every host shares. `yg context` becomes layered — brief by default where machines consume it,
expansion one command away, progressive-mode scope marking and cost preview built in, roots
conventions as a first-class section. All three parts interleave in one dependency graph (§5):
roots' verdict path is a prerequisite of the plugin's whisper and of context's conventions
section, so roots is built first-among-equals, not deferred.

## PART A — Complete roots implementation

Work packages R1–R10 realize the integration design in full. Each names its design sections;
the design's §12 port-plan buckets (as-is vs productionized vs excluded-with-reason) are the
authoritative mechanism inventory — R-packages below partition that inventory completely.

### R1 — Foundations: module, stores, config (design §4, §6, §10)
`src/roots/` skeleton (binding, extract, enumerate, roles, mine, history, weights, trends,
calibrate, verdict, speech, inquiry, promote, stores, advise-bridge, cli). Storage
`.yggdrasil/roots/`: committed `model.json` (full I2a header incl. `decisionsHash`),
`seeds.jsonl`, `decisions.jsonl` + `ledger.jsonl` (both `merge=union` via `init-scaffold.ts`'s
managed `.gitattributes` list), gitignored `.cache/` + `.state/`; scaffold gitignore entries.
Config: `roots:` block in `yg-config.yaml`, spec §4.5 keys verbatim (minus `version`/`daemon`),
per-block unknown-key rejection, `configHash` scoped to the subtree; absent block ⇒ dormant.
`rootsVersion` migrations ride the existing `migrations/` infra. Shared parser pool
(`ast/parser.ts`) — the prototype's standalone WASM loader does not port. Genericity lint (P6)
as an ESLint rule over `src/roots/**` (allowlist: `language-registry.ts` imports, fixtures).

### R2 — Extraction & enumeration (design §5, §6; spec §6–§7)
Binding derivation from `node-types.json` (lexical `@`/`[` marker; decoration attribution window
`(loRow, bodyRow]`), scope ordinals + `skeyR` keys everywhere, twelve enumerators,
per-partition vocabularies (deterministic selection), relative-import normalization. **Committed
binding snapshots for all 16 shipped grammars** asserted in unit tests; build assertion that every
grammar WASM ships its `node-types.json`. Extensions come from `language-registry.ts` only
(`.mts`/`.cts` already added on this branch — cherry-picked onto the implementation branch).

### R3 — Roles & acceptance (design §12; spec §8–§9)
Pre-bucketed weighted clustering (Lance-Williams, weighted DL, weighted medoids), clone-aware
ambiguity (`cloneMedoidJaccard` 0.6), sticky-role resolution; full acceptance chain: KT/MDL vs
parent posterior, index cost, fire-ability, survived-raw ≥ 2/3 — **fail-closed without history**
(the prototype's fail-open inversion is corrected here, per design §12) — vacuous filter,
two-tier absence τ (3.5 vocabulary / 4.5 structural), placement group-only, fallback buckets,
locality lattice (dirMin 25, redundant- and nested-refinement pruning), correlation dedup, seeds
capped 0.5×n_eff. Productionized rows owned here: §7.3 tautology filter, §9.4g stability,
§9.4h factCap, real `role_lift` (held-out DL, overlap-group exclusion, decorative demotion).

### R4 — Full history & weights (design §12; spec §13, §9.1)
Full walk (`--reverse --raw --no-abbrev --no-merges -M`), **sharded** persistent blob cache
`.cache/blobs/<2-hex>/` keyed `blobSha∥extractorVersion∥bindingHash`, **resume from
`lastIndexedSha`** (full walk only on `--full` or unreachable SHA), per-scope lifecycle with
rename replay, value events (change signature incl. decorations/supertypes/nameshape), clock =
HEAD committer timestamp, co-change (mega-commit cap 30, 5000 pairs by descending support),
weights survival × provenance × churn with floor — ledger cap applied **inside `w(s,q)`** before
mining (productionized from the prototype's fact-level approximation). History defaults uncapped
(`history.full: true`, `maxCommits: 0`).

### R5 — Verdict, speech, telemetry (design §3, §8.3, §12; spec §9.10, §11, §18)
Specificity governance (role < dir < `_all`, smallest evidence class), Δ gates with calibrated
τ_c override, channel table (DENY passes only on `pre`; downgrade-never-upgrade elsewhere),
severity, novelty capped at WARN, verbalizer with locality labels + contrast line, budgets
(3/response, 12 WARN/session), WARN-only dedup, compliance closure (complied → ledger mark;
ignored once per session), health demotion (Wilson LB, expected-flip filter — telemetry carries
expected/observed/Δ), sessions as **append-only event logs** (productionized), incidents FIFO 500,
fail-open on the hook path with harness rethrow. Naming table (design §11) binds all rendered
output; agent messages keep the three-beat deviation → evidence+scope → exemplar shape.

### R6 — Trends, calibration, DENY (design §9, §12; spec §9.5–9.6, §14)
Trend windows (`lowSampleMin` 8), cohort trends, nucleation stand-down (≥2 human authors),
attractor report-only; temporal-split calibration with family/cluster pools and the UB-demotion
branch; `yg roots calibrate`; DENY arming: Wilson LB ≥ 0.9 over ≥ 35 events, pre channel only,
carried in hook JSON (`permissionDecision`), never an exit code, never in CI; `status` prints
arming state honestly ("not armed — no fact has enough calibration events" is the expected
early message).

### R7 — Inquiry & reporting (design §3; spec §16)
`where` (lexical over repo-native tokens, cards with placement histogram + norms + exemplars +
co-change, compact-map fallback, `--path` feedforward brief), `spectrum` (deep vocabulary,
no acceptance cut, NORM/obs marking, `--min-signal`/`--top`), `report` (field, coverage/debt
pair, distributional section, trends/cohorts, role table with `role_lift`, health, agentShare,
co-change, `--campaign` export), `status [--exit-code] [--diagnose]` (the only gate-capable
surface, opt-in; `--diagnose` folds the spec's doctor), `explain` (gates, governance, shadowing,
demotion, dedup — where internals may legitimately surface).

### R8 — Promotion & advise bridge (design §7; §3)
`yg roots promote <fact-id>`: real aspect under `roots/<slug>/` — `yg-aspect.yaml` (evidence
sentence, `status: advisory` default, optional `scope.files` narrowed to the fact's locality) +
generated **self-contained `check(ctx)`** from per-enumerator-family templates (tree-sitter
detection via `ctx.files[].ast`, inline grandfathered scope-key set, zero roots dependency —
runnable by `yg aspect-test --files` and `drill` graphlessly); decision-register append; promoted
facts leave the speech path at next index. Ratchet-shrink nominations when grandfathered deviants
get fixed. Advise integration the way the engine actually works: a T2 nomination class
`convention-candidate` added to `CLASS_RANK`, a builder fed via `NominationSources` plain data —
flowing through the existing dismiss/defer register. `yg roots seed add/list/rm`, `mute`
(register-recorded, no inline markers), `reset`, `hooks install [--agent] [--git] [--enable-deny]`
(prints before writing; targets `settings.local.json` by default, `--commit` for the shared file).

### R9 — Protocol & product integrations (design §3, §8.1)
`templates/rules.ts` + `templates/digest.ts` roots section (domain-neutral; task start `where`,
post-edit `check`, stop sweep; session identity precedence: host-provided id first, spec fallback
last) — regenerated at root **and every `examples/*/`** per the standing digest gate.
`yg check` gains the single informational line when roots is initialized (never a warning, never
exit-code). `yg context` conventions section lands in C3 (PART C). Two knowledge topics
(`roots-overview`, `roots-promotion`), schemas additions (`roots:` config block, model header),
user docs pages (concepts, quickstart, per-command reference, honesty page). CHANGELOG entries
per landing.

### R10 — roots test suites (design §13)
Unit (enumerators table-driven per Appendix B; binding snapshots ×16; MDL vs derived Appendix E
fixtures; gates/governance/dedup; verbalizer; store canonicalization; migrations). Goldens:
**13 code-grammar fixture repos with scripted deterministic histories + 1 data-grammar golden**
(json/yaml/toml files must yield file/module-level facts only via the empty-scope-set path),
MUST-mine / MUST-NOT-mine per golden, CI fixture-equivalence rebuild. Mutation harness ported as
a permanent suite — floor **65/0/0, 130/130**; anchored operators, multi-syntax candidates,
placement validation by re-extraction, hermetic state; goldens in every gate run, big-corpus
sweep as a scheduled instrument beside the gate. Determinism: double `index --full`
byte-identity; incremental ≡ full; cache-state independence. Null control per golden (0 accepted
role/locality conventions on shuffled labels). Compliance-loop E2E and promote E2E (generated
aspect survives `yg check --approve --only-deterministic` in a fixture graph) through the built
`bin.js`. Hook-channel stdin/stdout fixtures incl. `stop_hook_active` and debounce/flood.
Coverage rides the existing ≥ 90 % gate; **no new repo-check steps** — shellcheck for plugin
scripts enters via lint config, the AGENTS.md 17-step list is untouched.

## PART B — Four marketplaces, four plugins, one shared core

Verified August 2026 (Appendix A): every host has a plugin system, a GitHub repo can BE a
marketplace for it, and all four plugin formats carry skills (shared SKILL.md format), hooks,
and MCP registration. The design therefore ships **one shared core and four thin adapters** —
no "grades of integration": each host gets a real plugin.

### P1 — Shared plugin core (`plugin/core/`)
- `scripts/`: `session-start.sh`, `post-edit.sh`, `stop-sweep.sh`, `pre-edit-deny.sh`, `lib.sh` —
  POSIX sh, shellcheck-clean, host-agnostic (host adapters pass event payloads in a normalized
  env). Every script opens with the two guards: no `yg` on PATH → one-sentence install note
  (`npm i -g @chrisdudek/yg`, then `yg prime`) once per session, then exit 0; no `.yggdrasil/` →
  silent exit 0. Version handshake: `minCliVersion` constant; older CLI ⇒ one notice, never a
  failure.
- Behaviors: **session-start** emits live `yg prime --digest` + the `yg check` header line (which
  under progressive mode already carries "N obligations outside your changes vs <ref>") + three
  first-commands, hard budget ≤ 40 lines; **post-edit** emits the delta-relevant part of
  `yg context --file <f> --brief` (C1) — rules whose pairs the edit invalidated — plus
  `yg roots check <f> --hook post` when roots is initialized; once per file per session;
  **stop-sweep** honors the host's stop-loop guard, runs `yg check` (scoped to *yours* under
  progressive mode) + `yg roots check --hook stop` completeness sweep; informative, never a veto;
  **pre-edit-deny** calls `yg roots check <f> --hook pre` and relays a DENY only when roots
  calibration has armed — otherwise instant silent pass.
- `skills/yggdrasil/SKILL.md` — generated from a new template beside digest.ts (single source;
  freshness asserted like the digest); teaches the workflow loop and `yg knowledge`. Artifact
  names route through `utils/rules-artifact-names.ts` (the single-source aspect extends to every
  new artifact name this plan introduces).
- **No static digest anywhere in the plugin** — live CLI output or the install note. A bundled
  copy is a staleness bug by construction.

### P2 — Marketplace manifests in this repository (one per host)
- Claude Code: `.claude-plugin/marketplace.json` (name `yggdrasil`, owner, plugins[]) →
  `plugin/claude-code/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`
  (SessionStart / PostToolUse `Write|Edit` / Stop / PreToolUse), skills + `mcpServers` inline.
- GitHub Copilot: `.github/plugin/marketplace.json` → `plugin/copilot/` with root `plugin.json`
  (kebab-case name), hooks.json, SKILL.md, `.mcp.json`; adopt the vendor-neutral Open Plugin
  Spec `$schema` field. Install: `copilot plugin marketplace add krzysztofdudek/Yggdrasil`.
- Cursor: `.cursor-plugin/marketplace.json` → `plugin/cursor/` with `.cursor-plugin/plugin.json`,
  `hooks/hooks.json` (sessionStart / afterFileEdit / stop / preToolUse), a rules `.mdc`
  (alwaysApply, digest-generated), `mcp.json`. Import via Dashboard → Plugins → repo URL.
- Codex: `plugin/codex/` with `.codex-plugin/plugin.json` (skills + mcpServers + hooks pointers)
  installable via `codex plugin marketplace add`; hooks marked best-effort in the manifest docs
  (host hook runtime still experimental — shipped, not depended on; the skill and MCP carry the
  protocol regardless).
- Each adapter's manifest/hooks reference the shared core scripts (repo-relative for path-source
  plugins; the per-host plugin root variable — e.g. `${CLAUDE_PLUGIN_ROOT}` — where the host
  provides one). First implementation task per adapter: freeze the JSON against a live install of
  that host (schema-assertion tests pin the shapes; README records last-verified host versions).
- This repo dogfoods all four: committed host config enables the local plugin
  (`.claude/settings.json` `extraKnownMarketplaces`/`enabledPlugins`; Cursor/Copilot/Codex
  equivalents where they support project-scoped enablement).
- Distribution docs: README one-liners per host + a docs page ("Agent integration: plugins,
  hooks, MCP") with the per-host capability table.

### P3 — `yg mcp` — the shared runtime (all four hosts)
Stdio MCP server, read-only tools: `prime_digest`, `context_for_file` (consumes C1 brief),
`check_status` (grouped findings honoring progressive mode), `impact`, `find`, `knowledge_read`,
`roots_where`, `roots_spectrum`, `roots_check_file`. **No write tools** — approve/log/suppress/
promote stay in the shell where the accountable session and human-confirmation invariants live.
Starts only where `.yggdrasil/` exists. One integration test per tool over real stdio, incl.
progressive header passthrough and a roots-dormant repo (roots tools report dormancy, not error).
Registered in all four plugins' MCP blocks: `{"command": "yg", "args": ["mcp"]}`.

### P4 — Plugin ↔ roots channels (in scope NOW, not "when roots exists")
The post-edit, stop-sweep, and pre-edit-deny scripts wire roots' §8.2 channels from day one —
R5/R6 are their prerequisite in the dependency graph, not an external assumption. On hosts with
reliable hook runtimes (Claude Code, Cursor, Copilot per Appendix A; Codex best-effort) this
replaces any need for `yg roots hooks install` — that command remains for plugin-less setups and
for the `--git` post-commit index trigger. DENY: only via pre-edit-deny, only armed, only
JSON — consistent across design, R6, and this package.

## PART C — `yg context` progressive disclosure

### C1 — Layering
`--brief`: owner + type, one line per rule (`[status] id — first sentence` + `read:` path),
log-gate state, one-hop relations, flows; ≤ 30 lines; the full dump remains the CLI default
(the manual already teaches it) — `--brief` is what hooks and MCP consume. Per-item expansion:
`yg context --file X --aspect <id>` prints that one rule in full. Trail pointers close the brief:
up to three `next:` lines (owner log read, parent node context, node aspect list) — depth is one
explicit command away, same two-regime law as roots.

### C2 — Progressive-mode integration (the base branch's missing piece)
When `progressive.reference` is set: per-rule pair marking **yours / inherited** reusing the
same measurement `yg check` computes (read-only reuse; implementation extracts the scope
computation into a callable module if the branch has it welded into check — first task of C2 is
that refactor, behavior-preserving, covered by the branch's existing tests), plus the one-line
scope header, plus the **arm preview**: "editing this file invalidates N pairs (M free / K
reviewer calls)" folded from the expected-pairs set (no reviewer contact). An exploring agent
learns cost and accountability before touching a file.

### C3 — Roots conventions section
The governed-facts card (locality-labeled, exemplars, contrast line) as a first-class brief
section once R5 lands — the same renderer `where` uses, scoped to one file. Dormant-roots repos:
section absent, zero cost.

## §5 — Dependency graph and increment sequence (one program, interleaved)

```
R1 ──► R2 ──► R3 ──► R5 ──► R6 ─────────► (DENY in P4)
        │      │      ├──► R7 (inquiry/report)
        │      │      └──► R8 (promote/advise)   R4 ──► R5-weights, R6-calib
C1 ─────┼──────┼──► P3 (mcp) ──► P2 adapters
        │      └──► C3 (conventions in brief)
C2 (scope-reuse refactor) — independent of roots; before or parallel to C1 landing
P1 core scripts ──► P2 manifests; P4 = P1 scripts + R5/R6 outputs
R9 protocol + R10 suites ride their packages; docs ride each landing
```

Increment order (each lands green on the base branch):
1. **C1 + C2** (context layering + scope reuse — immediately useful, no roots dependency)
2. **R1–R3** (roots mining core + gates; goldens for the 6 measured grammars start here)
3. **R4** (history + incremental) → 4. **R5** (verdict/speech/telemetry) → 5. **P3** (mcp, incl.
   roots tools) + **P1** (core scripts)
6. **P2** (four manifests + adapters, dogfood enabled) + **P4** (channels live)
7. **R6** (trends/calibration/DENY — pre-edit-deny arms itself when calibration does)
8. **R7 + R8 + C3** (inquiry, promote, advise, conventions section)
9. **R9 + R10 completion** (all 16 grammar goldens green, harness floor held, docs/knowledge)

## §6 — Decisions binding this plan (so implementation never re-litigates)

1. Roots never gates CI; promotion lands `advisory`; the only exit-code gate is opt-in
   `yg roots status --exit-code`. Holds across every package above.
2. Speech is gated/budgeted/deduplicated; inquiry is unbounded — no surface blurs the line
   (plugin whisper budgets included).
3. MCP is read-only. Writes stay in the shell.
4. No static digest in any plugin. Live CLI or one-sentence note.
5. Fail-closed survived-raw without history; fail-open only on the hook execution path (I1),
   with harness rethrow.
6. Hooks whisper; the only deny is roots' calibrated pre channel.
7. Every new installed-artifact name goes through `rules-artifact-names.ts`; every generated
   artifact joins the digest-freshness gate.
8. Nothing in this plan may be descoped without the owner's explicit written decision.

## §7 — Risks

1. **Host-API drift** (four young plugin systems): schema-assertion tests per adapter; freeze
   against live installs; README records last-verified versions. Codex prose docs were
   secondary-sourced (egress-blocked) — its adapter's first task re-verifies against a live
   `codex` install.
2. **Noise erosion**: budgets/dedup in scripts from day one; this repo dogfoods all four plugins;
   annoyance here blocks shipping.
3. **Scope-measurement reuse (C2)**: if the branch's measurement is not cleanly separable, the
   refactor is the cost — bounded, behavior-preserving, protected by existing branch tests.
4. **Roots echo/quality risks**: carried unchanged from the integration design (§16 there);
   agentShare alarm, ledger cap, hook-shaped exclusion are R4/R5 content, not options.
5. **Codex hook reliability**: shipped best-effort; skill + MCP carry the protocol there
   regardless; revisit when the host stabilizes.

---

## Appendix A — Verified host plugin systems (August 2026)

| Host | Since | Marketplace manifest (repo = marketplace) | Plugin manifest | Carries | Install |
|---|---|---|---|---|---|
| Claude Code | 2025-10 | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` | commands, agents, skills, hooks (~20 events), MCP, LSP | `/plugin marketplace add owner/repo` → `/plugin install name@marketplace`; team: `extraKnownMarketplaces`+`enabledPlugins` |
| GitHub Copilot | ~2026-01 | `.github/plugin/marketplace.json` | root `plugin.json` (kebab-case name) | agents (`*.agent.md`), skills, hooks, MCP, LSP; Open Plugin Spec `$schema` | `copilot plugin marketplace add owner/repo` → `copilot plugin install name@marketplace`; also `OWNER/REPO[:PATH]` |
| Cursor | 2026-02 | `.cursor-plugin/marketplace.json` | `.cursor-plugin/plugin.json` | rules (`.mdc`), skills, agents, commands, hooks (~18 events), MCP | Dashboard → Plugins → import repo URL; public: cursor.com/marketplace; team policies Required/Optional |
| OpenAI Codex | ~2026-03 | third-party repo as marketplace | `.codex-plugin/plugin.json` (+`interface` block) | skills, MCP, hooks (host runtime experimental), commands/agents | `codex plugin marketplace add owner/repo` → `codex plugin add name@marketplace` |

Cross-host: SKILL.md format shared (Claude/Copilot/Cursor/Codex); MCP universal; AGENTS.md read
natively by Copilot (since 06/2026), Cursor, Codex — and by Claude Code via the committed
CLAUDE.md import. Primary-source confidence: Claude Code, Copilot, Cursor manifests fetched from
official repos/docs; Codex schema confirmed from a live third-party plugin manifest, prose docs
secondary-sourced (egress-blocked) — re-verify at P2.

*End of plan. Companions: roots integration design (mechanism-complete), v6 spec, progressive-mode
docs on the base branch.*
