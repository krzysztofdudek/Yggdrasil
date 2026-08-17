# roots × Yggdrasil — Complete Integration Design

**Status:** design for full integration — not an MVP carve-out. Every mechanism of spec v6
(`2026-08-17-yg-roots-v6-spec.md`, prototype-synced at md5 `bc9eec11`) lands inside the Yggdrasil
CLI, for **every language Yggdrasil already ships**. The v6 spec remains the normative reference for
the *machine* (math, gates, stores' internal shapes); this document is the normative reference for
the *integration* — how the machine becomes a first-class organ of the product. Where the two could
disagree, this document wins on product surface and the spec wins on mechanism internals. Five spec
surfaces are deliberately **excluded rather than ported** — the daemon (§9), `scaffold` and the
standalone `config.json` (§3, §10), `check --exit-code` and the optional recognizer pack (§12) —
each named at its section with its reason and its cost; nothing else of v6 is left out, and §12
walks the Sync Matrix row by row to prove it.

**Grounding.** Written against the engine itself — `yg knowledge` (aspects-overview,
writing-deterministic-aspects, aspect-status, configuration, verification-and-lock), `yg schemas`,
`utils/language-registry.ts`, `cli/init-scaffold.ts`, `core/advise-nominations.ts`,
`io/config-parser.ts`, `dist/grammars/` — and against the measured prototype (65/0/0 harness over
7 models, byte-identical determinism, 0-second warm relearn, live compliance loop, live ratchet).

---

## 0. The one-paragraph shape

Yggdrasil today enforces **declared architecture**: a graph the maintainer authored, verified by
reviewers, locked by hash. roots adds **measured architecture**: the conventions the repository
actually holds, mined from every AST at every granularity across the full git history, spoken to
agents at the point of edit, queryable at the start of work, and convertible — one decision at a
time — into the enforced graph. The two layers stay distinct on purpose: the graph says *decided*,
roots says *practiced*, and only the maintainer's (or an explicitly instructed agent's) act of
**promotion** moves a fact from the second voice into the first. roots never gates CI. That owner
decision is load-bearing and appears throughout this design.

## 1. Principles inherited and enforced

1. **Roots lives inside Yggdrasil** (owner decision) — one CLI, one install, one config file, one
   `.yggdrasil/` directory. No second binary, no daemon requirement for the core paths.
2. **Roots never gates CI** (owner decision). `yg check` semantics are untouched. Every roots exit
   code that could fail a pipeline exists only behind an explicit, documented, adopter-chosen flag.
   This holds *through* promotion: a promoted aspect defaults to `status: advisory`, and an
   unverified advisory pair renders as a warning, never an error (`yg knowledge read
   aspect-status`) — so the act of promotion cannot turn a green repo red before the maintainer
   verifies and flips it to `enforced`.
3. **Suggestion-first.** A discovered convention is speech and evidence, never enforcement.
   Enforcement exists in exactly one form: a **promoted aspect** — a real, ordinary Yggdrasil
   aspect that the maintainer governs like any other. After promotion, the machine that discovered
   the rule has no runtime role in enforcing it.
4. **Total genericity** (P6 of the spec). Nothing language-, framework-, or style-specific anywhere.
   The only per-language datum in the whole subsystem is the existing
   `language-registry.ts` — roots consumes it and adds nothing beside it.
5. **Two version notions stay separate** (AGENTS.md). The graph schema version does not move for
   roots. roots' own store carries `rootsVersion` with its own migrations. `package.json` moves only
   on release, as always.
6. **Determinism is a contract** (I2a): identical inputs ⇒ byte-identical `model.json`. Measured in
   the prototype; a CI-side double-index gate keeps it true forever.
7. **Every diagnostic follows what/why/next** where it is an error surface, and the roots agent
   message template (deviation → evidence+scope → exemplar-to-copy) is the same shape wearing
   convention clothing. No internal vocabulary leaks to users (see §11 naming table).

## 2. What the results license (analysis → design inputs)

| Measured result | Design consequence |
|---|---|
| 65/0/0 detection, 130/130 silence across 7 models, full histories | the verdict path (sticky roles, specificity governance, gates) ports as-is; the harness becomes a permanent suite with 65/0/0 as the floor |
| Binding derived from `node-types.json` — 0 lines of language code across TS/TSX/JS/Py/Java/Go | all 13 code grammars integrate by derivation + a committed per-grammar snapshot; no per-language work items exist in this plan |
| Full history ~12 ms/blob, lifecycle coverage 94–96 %; warm relearn 0 parsed / 0 s; byte-identical across cache states | history is a build-time cost, not a hook-time one; `index` is incremental by default; the committed model is merge-safe by regeneration |
| Locality lattice (package → directory → role) with specificity governance | locality is core, not an option; message labels always carry their true scope |
| Compliance loop closed (WARN → fix → ledger mark), health demotion, once-per-session ignored bound | telemetry/ledger land in phase 1 — they keep speech honest, they are not analytics garnish |
| Ratchet export verified live (exit 0 clean / exit 1 planted) | promotion is proven; production upgrades it from shell-out to a self-contained `check(ctx)` (§7) |
| `where` / `spectrum` answer cold-start and depth from the model alone | the inquiry regime ships alongside the hook regime; no RAG layer anywhere |
| Two adversarial rounds; Sync Matrix with honest SIMPLIFIED/SPEC-ONLY rows | §12 enumerates exactly those rows as the work list — nothing is dropped by omission |

## 3. Product surface — the `yg roots` command tree

All subcommands live under `yg roots` (one new top-level word). Naming uses Yggdrasil's vocabulary:
*index* (like a build), *check* (like the verifier), *promote* (the bridge act).

| Command | Role | Exit codes |
|---|---|---|
| `yg roots index [--full]` | Build or refresh the field: extraction → vocabularies → roles → history join → acceptance → model. **Incremental by default** (blob cache + resume from `lastIndexedSha`); `--full` forces the walk and is the determinism reference. | 0; 1 only on I/O/config errors |
| `yg roots check <file...> [--content <p>] [--as <p>] [--session <id>] [--hook pre\|post\|bash\|stop\|generic]` | The verdict path for edited files: governed facts only, Δ-gated, budgeted, deduplicated, telemetry-recorded. `--hook` selects the channel table (DENY passes only on `pre`, and only calibrated — §9). A DENY is carried in the hook's JSON payload (`permissionDecision: "deny"`), **never in an exit code**; the spec's `check --exit-code 4` is deliberately not ported (§12). | 0 always |
| `yg roots where <query...>` | Inverse query: intent → place + norms + exemplar + co-change. Compact-map fallback. Also the feedforward brief (spec §15): `--path <p>` renders the same card for a file about to be written. | 0 |
| `yg roots spectrum <file> [--min-signal N] [--top N]` | Solicited full-lattice exploration, no acceptance cut, deep vocabulary. | 0 |
| `yg roots report [--json]` | The field: conventions by partition/locality with evidence, **coverage/debt as a pair over hook-eligible facts** (spec §16.2), distributional facts kept in their own section, trends, cohort trends, role table with `role_lift`, health, agentShare, co-change, and the normalization campaign backlog (`--campaign` exports tasks). | 0 |
| `yg roots status [--exit-code] [--diagnose]` | Freshness, history stats, active degraded modes/modulators, DENY availability, withheld counts. `--diagnose` absorbs the spec's `doctor`: grammar + `node-types.json` presence, binding-derivation sanity, store integrity, double-index determinism, incident review (there is no socket or daemon to probe — §9). `--exit-code` (2 stale / 3 alarm) is the **only** gate-capable surface, explicit and opt-in. | 0 (2/3 with flag) |
| `yg roots explain <file\|fact-id>` | Why a fact fired / didn't: gates, governance, shadowing, demotion, dedup — the debugging window. | 0 |
| `yg roots promote <fact-id> [--dir <aspects-subdir>] [--status advisory\|draft]` | The bridge: convention → real aspect (§7). Appends to the decision register. | 0 |
| `yg roots calibrate` | Temporal-split calibration; reports per-fact τ_c, DENY eligibility. | 0 |
| `yg roots seed add\|list\|rm`, `yg roots mute <fact-id> [--until]` | Maintainer steering (§17 of the spec); mute is roots' dismiss/defer, recorded in the decision register — **no inline suppression markers** (the health system silences ignored speech automatically; case law belongs in the register, not in source files). | 0 |
| `yg roots hooks install [--agent claude-code\|generic] [--git]` | Opt-in wiring (§8): agent-native hooks and/or a post-commit index trigger. Prints what it writes before writing. | 0 |
| `yg roots reset [--state\|--cache\|--all]` | Blow away derived state (never the committed stores). | 0 |

Integration into existing commands (no behavior change without roots initialized):

- **`yg context --file <f>`** appends a "conventions here" section: the governed facts for that
  file, locality-labeled, with exemplars — the same card `where` renders, scoped to one file.
- **`yg advise`** gains one nomination class, `convention-candidate`: the top promote-worthy facts
  (ranked by bits/instance × stability × calibration availability). `core/advise-nominations.ts` has
  no plugin seam — it is a pure, I/O-free module with a hardcoded `CLASS_RANK` — so the work is:
  one `CLASS_RANK` entry in the **T2 tier** (below every T0 and T1 class, sharing T1's decision
  stream and joint ten-item cap), one builder function, and the roots facts injected as plain data
  through `NominationSources` at the CLI boundary. Roots is never imported into that engine module.
  Items carry the standard `id` + `evidenceHash`, so an evidence change re-surfaces a dismissed
  candidate exactly like every other class. `dismiss`/`defer` work as-is; there is no "accept" verb
  in advise — the human action the nomination prints is `yg roots promote <fact-id>`.
- **`yg prime`** gains a roots section in the printed manual (§8.1).
- **`yg check`** — untouched semantics; prints at most one informational line
  ("conventions: N active · index M commits behind HEAD · `yg roots status`") when roots is
  initialized, silent otherwise. It reads the committed header and one `git rev-list --count`, and
  any failure of either drops the line rather than the command. Never a warning, never an error,
  never an exit-code contribution.

**Not integrated (explicit non-goals):** roots does not write architecture types, does not feed
`type-suggest`, does not edit `yg-architecture.yaml`, does not create graph nodes. Norm ≠ intent;
the only crossing is `promote`, and it produces an aspect, never structure. (A future
`type-suggest --from-roots` is imaginable; it is out of this design on purpose and listed in §15.)
Of the excluded spec surfaces listed at the head of this document, two are commands: the daemon
(§9) and `scaffold` (spec §15) — a command that emits code skeletons from a norm model is a code-generation
product with its own failure modes, and the exemplar `where` already prints is the honest version
of the same help. `brief` is not a separate command: its content is `where --path` and the roots
section of `yg context --file`.

## 4. Storage — `.yggdrasil/roots/`

Follows the AGENTS.md rule exactly: committed knowledge at the top, rebuildable state in
dot-prefixed gitignored subdirectories.

```
.yggdrasil/roots/
  model.json              # COMMITTED — the deterministic snapshot (field, roles, assignments,
                          #   locality facts, trends, calibration, co-change, aliases)
  seeds.jsonl             # COMMITTED — maintainer seeds/tensions (append-only)
  decisions.jsonl         # COMMITTED, merge=union — promotions, mutes, dismissals (case law)
  ledger.jsonl            # COMMITTED, merge=union — hook-shaped marks (the echo-defense input)
  .cache/                 # gitignored — blob cache only (content-addressed, sharded 2-hex),
                          #   plus .build.lock
  .state/                 # gitignored — telemetry.jsonl, sessions/, demotions.json,
                          #   incidents.jsonl (FIFO 500)
```

- **`model.json`'s header carries every I2a input**, not a subset:
  `{rootsVersion, headSha, lastIndexedSha, clock, bindingHash, configHash, seedsHash,
  decisionsHash, ledgerHash, dirtyHash, candidateCountLog2, rolesStale}`, excluded from the
  snapshot content hash. `decisionsHash` is new versus the spec and load-bearing here: promotions
  and mutes live in `decisions.jsonl`, and §7's promoted-fact flip must be reproducible from
  committed inputs alone.
- `init-scaffold.ts`'s managed `GITATTRIBUTES_LINES` gains three lines:
  `/.yggdrasil/roots/decisions.jsonl merge=union`, `/.yggdrasil/roots/ledger.jsonl merge=union`
  (same rationale as the advise register), and `/.yggdrasil/roots/model.json
  linguist-generated=true` — the same attribute the lock triad already carries, which is what
  keeps a generated file out of language stats and collapsed in review.
- **`model.json` is committed** — a deliberate departure from spec §4.4, which keeps the snapshot in
  the gitignored cache. It is rebuildable but expensive cold; committing it gives every clone and
  teammate the hook path instantly, keyless, with zero walk. Conflicts resolve by regeneration
  (`index --full` on the merge result — determinism makes both sides reproducible, so regeneration
  is the union of truth, not a choice of branch). Same philosophy as the lock: committed,
  generated, never hand-edited.
- The blob cache is **shared with nothing**: the relation pass's `.ast-cache/` stays separate.
  They cache different things (relation facts vs scope records) under different keys; unifying them
  is a refactor with no user-visible payoff and real invalidation-coupling risk. Explicit non-goal.
- **Writer concurrency** (spec §4.4) survives the move: every writer (`index`, `calibrate`,
  `promote`'s model flip) takes the exclusive `.cache/.build.lock`; readers — hooks, `where`,
  `spectrum`, `report`, `status`, the `yg check` note — never take it and read through
  `model.json`'s atomic rename.
- Gitignore entries ride the existing hardcoded `YGGDRASIL_GITIGNORE_LINES` (paths relative to
  `.yggdrasil/`, so: `roots/.cache/`, `roots/.state/`) and propagate via `init --upgrade`.

## 5. Languages — all of them, by derivation

The single source of truth is `language-registry.ts`. roots reads it; the prototype's `EXT2GRAMMAR`
constant does not survive the port.

**Code grammars (13), by registry id** — `typescript` (`.ts`), `tsx`, `javascript`
(`.js/.mjs/.cjs/.jsx`), `python`, `go`, `rust`, `java`, `csharp` (`.cs`), `c` (`.c/.h`), `cpp`
(`.cpp/.cc/.cxx/.hpp/.hh/.hxx`), `php` (`.php`), `ruby`, `kotlin` (`.kt/.kts`). Registry ids are
**not** the grammar asset names: `csharp`/`php` ship as `tree-sitter-c_sharp.wasm` /
`tree-sitter-php_only.wasm`, and binding derivation keys on the asset name while everything
user-facing keys on the registry id. All 16 shipped grammars already carry a `node-types.json`
beside their WASM (verified: 16 WASM / 16 node-types in `dist/grammars/`) — the v6 packaging
requirement is satisfied today; the build gains an assertion that keeps it so.

One honest gap the port would have created: spec §6.1's `EXT2GRAMMAR` mapped `.mts`/`.cts` to
typescript and the registry did not, so deleting the constant would have lost those two extensions.
**RESOLVED (owner decision, 2026-08-17): option A** — `typescript.extensions` in
`language-registry.ts` now carries `.ts`, `.mts`, `.cts` (this also closed a pre-existing engine
inconsistency: the TypeScript import resolver already resolved specifiers to `.mts`/`.cts` paths
that the registry then refused to parse). roots carries no extension map of its own; no open
items remain in this design.

Per-grammar integration is **derivation + verification**, never authorship:

1. `bindingFor(grammar)` derives scopes/imports/decorators/heritage from `node-types.json`
   (spec §6.2, with the lexical `@`/`[` decoration marker and the decoration attribution window).
2. A **committed binding snapshot** for all 16 shipped grammars
   (`tests/fixtures/roots/bindings/<grammar>.json`) is asserted in unit tests — a grammar upgrade
   that moves node types fails loudly instead of silently shifting every downstream count.
   `bindingHash` covers all derived sets and invalidates the model and blob cache by key.
3. A **golden fixture repo per code grammar** (13 total, `tests/fixtures/roots/golden/<grammar>/`)
   — a small scripted repo with a deterministic git history, an `expected.json` of MUST-mine and
   MUST-NOT-mine assertions, and one mutation-harness pass. Six grammars have measured priors
   (TS/TSX/JS/Py/Java/Go); the other seven get their goldens written during the port, with the
   expected degradation stated per grammar up front, so a golden that *under*-mines is a bug and a
   golden that mines nothing where nothing is derivable is a pass: `c` — no decorators, `#include`
   imports (E6-deco empty, E8 active, functions caught as declarator+body); `cpp` — as `c` plus
   classes, heritage via `base_class_clause`; `rust` — `impl`/`fn`/`struct` scopes, `#[...]`
   attributes admitted by the `attribute` node family and the `[` marker, traits via heritage;
   `csharp` — `attribute_list` + `[` marker, full scope surface; `kotlin` — `annotation` + `@`;
   `php`/`ruby` — scope rule holds, ruby has no decorators and degrades exactly like Go.
   The golden gate is what makes "supported" a measured word: **a grammar is supported when its
   golden passes**, and all 13 — plus §5.4's data golden — are in the phase-1 definition of done.
4. **Data grammars (json, yaml, toml)** yield no name+body scopes by construction, so they get the
   same treatment by derivation, not by special case: file/module-level surfaces only
   (`auto.filenameshape`, E12 module facts), full membership in co-change and history, no scope
   facts ever. That policy is measurable, so it is measured: a **fourteenth golden**
   (`golden/data/`, one repo mixing `.json`/`.yaml`/`.toml` with a code grammar) asserts
   MUST-mine on the file/module surfaces and MUST-NOT-mine on every scope-level enumerator — the
   gate that catches a future derivation change silently inventing scopes in a data grammar.
5. Mixed-language repos need no configuration: partitions and vocabularies are language-blind, the
   registry maps per file, and history blobs parse under the grammar of their historical path's
   extension (already prototype-proven on immich TS+Python).

## 6. Architecture inside the CLI — `source/cli/src/roots/`

One new module, mirroring spec sections; no roots import from outside surfaces except the
registry, the shared tree-sitter loader (`ast/parser.ts` — one parser pool for the whole CLI), and
`formatters/message-builder.ts`.

```
src/roots/
  binding.ts          # §6.2 derivation + snapshot types + bindingHash
  extract.ts          # §6 scope extraction, ordinals, per-scope surfaces
  enumerate.ts        # §7 twelve enumerators + per-partition vocabularies
  roles.ts            # §8 pre-bucketed weighted clustering, medoids, clone-aware ambiguity, sticky
  mine.ts             # §9 KT/MDL acceptance + every gate, locality lattice + pruning, dedup, seeds
  history.ts          # §13 walk, blob cache, lifecycle, value events, renames, co-change, resume
  weights.ts          # §9.1 survival × provenance × churn, ledger cap
  trends.ts           # §9.5–9.6 windows, cohorts, nucleation, attractor (report-only)
  calibrate.ts        # §14 temporal split, τ_c, Wilson gates
  verdict.ts          # §9.10 governance, Δ, severity, channel table, compliance closure
  speech.ts           # §11 verbalizer, budgets, dedup, session state
  inquiry.ts          # §16.2b/c spectrum + where (+ where --path, the feedforward brief)
  promote.ts          # §7: aspect generation (codegen per enumerator family)
  stores.ts           # §4/§5 model/seeds/decisions/ledger/telemetry IO, migrations, aliases,
                      #   reaping, canonical serialization (I2a)
  advise-bridge.ts    # plain-data nomination payload for the advise feed
  cli.ts              # commander wiring for the `yg roots` tree
```

Contracts with the rest of the CLI:

- **Parsers:** roots uses the CLI's existing parser pool and WASM loading — no second web-tree-sitter
  path, no `Parser.init()` duplication. The prototype's standalone loader dies in the port.
- **Messages:** CLI-facing errors go through `buildIssueMessage` (what/why/next). Agent-facing
  convention messages use the roots template (label + verbalized rule + evidence + deviation +
  exemplars + contrast line) — same three-beat structure, convention register.
- **Genericity lint (P6):** the spec's §22.9 gate ships as a local ESLint rule over
  `src/roots/**` — failing on any identifier or string literal naming a programming language,
  framework, or style, allowlisting only `language-registry.ts` imports and test fixtures. ESLint,
  not a new script, because that is what lets it ride repo-check's existing **lint** step and keeps
  the 17-step list unchanged (§13). It is dogfooded twice: as that rule, and as a deterministic
  aspect on this repo's own `src/roots/**` node, so the graph carries the constraint too.
- **Fail-open (spec I1) is product law, not an implementation detail:** one `try` around the whole
  verdict entry point — parse failure, missing grammar, corrupt session file, malformed model row
  all exit through it as zero findings plus one `incidents.jsonl` record. The one exception is the
  mutation harness, which **rethrows**; without that, a crashed engine scores as a clean run.
- **No `any` in exported types**, per the repo's standing bar.

## 7. Promotion — the bridge, productionized

`yg roots promote <fact-id>` converts a discovered convention into an ordinary Yggdrasil aspect.
The prototype proved the loop with a shell-out ratchet; the product version is self-contained:

1. **Aspect directory** under the aspects root, default `roots/<slug>/` (the `roots/` prefix is an
   organizational grouper, keeping provenance visible in the id; `--dir` overrides).
2. **`yg-aspect.yaml`**: `name`, `description` carrying the verbalized rule + evidence sentence
   ("discovered from N conforming of M established; promoted <date>"), `status: advisory` by
   default (`--status` overrides; `enforced` is a deliberate second step the maintainer takes like
   for any aspect). Optional `scope.files` narrowed to the fact's locality (its directory context
   or partition) so the aspect's subject set matches the convention's true scope. The new pair is
   unverified until `yg check --approve --only-deterministic` fills it — free, keyless, and while
   it waits it is an advisory warning, not a red gate (§1.2). `promote` prints that next command.
3. **`check.mjs`** — a real, synchronous `check(ctx)` returning `Violation[]`, generated from a
   **per-enumerator-family template** (~30–60 lines each: imports, decorations, heritage, callees,
   name shape, node-type presence, subtree shape, arity, first-statement, return shape). It touches
   **only `ctx.files[].ast` and `ctx.files[].content`**, with `walk`/`report`/`inFile` from
   `@chrisdudek/yg/ast` — never `ctx.fs`, `ctx.graph`, `ctx.node` or `ctx.parse*`. That restriction
   is not stylistic: the graphless AST runner behind `yg aspect-test --files` and `yg drill` hands a
   check nothing but `ctx.files`, and a generated check that reached for a graph accessor would be
   reported as an unsupported capability there (§13.7 depends on this). The **grandfathered set is
   inline** (scope keys frozen at promotion time): pre-existing deviations pass, new ones violate.
   No import of roots, no model read, no shell-out — closing the one gap the prototype's ratchet
   left open (its generated check shelled back into the prototype with the model path baked in).
   After promotion the aspect is independent, hashable and cacheable like any other deterministic
   aspect, and it survives a wiped roots cache or a roots uninstall.
4. **Decision register**: one `decisions.jsonl` line (fact id, evidence snapshot, aspect id, date).
   The fact flips to `promoted` at the next index — and because `decisionsHash` is a header input
   (§4), that flip is a deterministic function of committed state, reproducible on every clone,
   not a local side effect of whoever ran `promote`. Promoted facts leave the speech path (the
   aspect enforces now; double-speaking would violate the budgets' spirit) but stay in `report`
   and `explain` with their provenance, so the field does not appear to lose a convention the
   moment it becomes law.
5. **Invariants honored**: promotion never edits `yg-architecture.yaml`, never touches lock files,
   and — per the standing AGENTS.md invariant — an agent runs `promote` only on the user's explicit
   instruction or an accepted advise nomination.

Ratchet shrinkage is maintenance, not magic: when a grandfathered deviant gets fixed, the next
`yg roots index` notices the aspect's grandfather list is stale and `yg advise` nominates a
one-line shrink (regenerate the list) — same union-merged register, same explicit accept.

## 8. Agent integration — protocol first, hooks opt-in

Yggdrasil's existing agent contract is a **printed protocol** (`yg prime`, AGENTS.md digest), not a
runtime. roots integrates the same way first, so every agent that can read AGENTS.md gets the whole
loop with zero infrastructure; native hooks are an opt-in accelerator.

### 8.1 Protocol path (universal, default)

`templates/rules.ts` (full manual) and `templates/digest.ts` (committed digest) gain a roots
section — written domain-neutrally per the Product Scope rule (examples speak of "handlers in an
e-commerce app", never Yggdrasil internals):

- **Task start:** "if you don't know where a thing belongs, ask the repo:
  `yg roots where "<what you're adding>"`; going deeper is `yg roots spectrum <file>`."
- **After editing a file:** "run `yg roots check <file>`; treat WARN output as a teammate pointing
  at the house style — follow it or say why not." (`--session <id>` only if the runtime hands the
  agent one; the fallback ladder below covers every runtime that does not.)
- **Before finishing:** "run `yg roots check --hook stop` once for the completeness sweep."
- Session identity: `--session` from the agent's own id when it has one; otherwise the spec's
  fallback ladder — `sha256(ppid ∥ cwd ∥ ppid-start-time)`, degrading to `ppid ∥ cwd ∥ UTC-day`
  only when the process start time is unreadable. (The day-granular form alone would merge two
  same-day sessions in one checkout into one budget.) Budgets and dedup work identically on both
  paths; session state is an append-only event log, never a rewritten file.
- The digest regeneration procedure is the standing one: edit templates, rebuild,
  `node source/cli/dist/bin.js init --upgrade` at root **and in every `examples/*/` carrying its own
  graph** (repo-check's digest gate enforces this).

On the protocol path DENY does not exist — the channel table downgrades to WARN (I2b: downgrade or
silence, never upgrade). This is correct, not a gap: a printed protocol cannot block a write.

### 8.2 Native hooks (opt-in): `yg roots hooks install`

- `--agent claude-code` writes `.claude/settings.local.json` by default — the machine-local file,
  per spec I8 — with `--commit` selecting the shared `.claude/settings.json` and printing the
  asymmetry it creates (teammates and CI stay unhooked until they install; the committed ledger
  still regulates the model everywhere). Entries: PostToolUse (Edit|Write →
  `yg roots check <file> --hook post`), PreToolUse (only if the adopter passes `--enable-deny` AND
  calibration has armed — otherwise not installed), Stop (`--hook stop`, honoring
  `stop_hook_active`), Bash sweep with the spec's debounce/flood bounds. The command prints the
  exact JSON before writing, never edits other keys, and probe-executes each installed hook
  afterwards (a silent ENOENT fail-open is the worst failure mode).
- `--agent generic` prints the equivalent wiring instructions for other runtimes instead of writing
  anything.
- `--git` installs a post-commit/post-merge hook running `yg roots index` (incremental — measured
  at "exactly the new blobs, ~0 s"), guarded to no-op when `.yggdrasil/roots/` is absent.
- Nothing is installed by `yg init` by default. Hook installation is always a separate, explicit,
  printed-before-written act.

### 8.3 The two regimes, restated as product law

Unsolicited speech (check/hook path) is gated, budgeted, deduplicated, health-demoted — precision
over recall, because agents stop listening to noisy tools. Solicited inquiry (`where`, `spectrum`)
inverts the trade and exposes the full field with continuous scores. No surface may blur this line:
an `obs`-grade spectrum row entering the hook path is a defect by definition (spec §16.2b).

## 9. DENY — exists, armed rarely, never in CI

DENY keeps every spec gate: only on the PreToolUse channel, only for facts that passed
calibration's Wilson lower bound (≥ 0.9 precision over ≥ 35 events), only with the §9.9
structural-reach test and the `denyExtraBits` margin, never for never-seen values, never
deduplicated (a block a retry defeats is not a block). It is expressed as
`permissionDecision: "deny"` in the hook's JSON, not as an exit code, and plays no part in CI under
any configuration — the pre channel exists only inside an agent session.

**One spec precondition is deliberately not met: the daemon.** Spec §12.6 makes a resident process
DENY's precondition — for latency (50 ms served vs a 700 ms cold load) and for model freshness
across commits. A daemon is a second lifecycle (socket, handshake, idle exit, background reindex,
Windows pipes) inside a CLI that has none, and principle 1 forbids the requirement. The costs are
stated, not hidden: the pre hook loads the committed `model.json` cold and arms DENY only when that
load fits the channel budget (self-disabling with one incident otherwise), and a model stale since
the last `index` downgrades DENY to a post-tool WARN with a staleness note (I2b: downgrade or
silence, never upgrade) — which is what §8.2's `--git` trigger exists to prevent.
Honest expectations print where adopters see them (`yg roots status`: "DENY: not armed — no fact
has enough calibration events"): every repo tested so far reported calibration *unavailable*, so
DENY is designed, harness-tested (`retry_denied_edit`), and expected to arm rarely and late.

## 10. Configuration — one file, one block

A `roots:` block in the existing `yg-config.yaml` (no second config file — spec §4.5's
`.yggdrasil/roots/config.json` does not survive the integration). The block carries the spec's key
tree **verbatim, key for key**, with spec defaults — `include`/`exclude`, `partition`, `history`
(`full: true`, `maxCommits: 0`, uncapped by owner directive), `enumerate`, `weights`, `mdl`
(including `dirContextMinScopes`), `thresholds` (including `absenceGapBitsStructural`), `calib`,
`trend`, `cochange`, `ledger`, `budgets`, `health`, `completeness`, `seed_tension`, `report`,
`hooks`, `roles`, `sessions` — minus two: `version` (the host config's `version:` is the graph
schema version and is not roots' to move) and `daemon` (no daemon — §9). No key is renamed;
inventing local names for spec keys would break the spec's constant table as the reference.
Unknown keys inside the block are rejected with a what/why/next error, matching both the spec's
hard-error rule and the existing `signals:`/`events:` blocks. Older CLIs tolerate the block
(top-level unknown keys are not rejected), so adding it does not fork the config format.
Absent block ⇒ roots is dormant (no `.yggdrasil/roots/` reads, the one-line `yg check` note does
not print). `yg roots index` on a repo without the block scaffolds it with defaults, printed first.

Hashing and versioning: `configHash` is the sha256 of the canonicalized merged `roots:` subtree
only, so a reviewer-tier edit does not invalidate the model and a roots-threshold edit does not
touch the graph lock. The block carries no version of its own; `model.json`'s header
`rootsVersion` governs store migrations through the CLI's existing `migrations/` infrastructure.
The graph schema version is untouched by any of this — promoted aspects are ordinary graph objects
the current schema already describes.

## 11. Naming — nothing internal leaks

| Internal (spec) term | User-facing term |
|---|---|
| FACT / pid / surface | convention / property |
| partition `_all` | "package-wide (`<pkg>`)" / "repo-wide" |
| directory context `d[...]` | "local to `<dir>/`" |
| role r<N> | "group «label»" (medoid label) |
| sticky role | (never surfaces; `explain` says "this file's group") |
| survived-raw share | "N of M established conform" |
| Δ bits / τ | (never surfaces in messages; `explain` shows them) |
| hook_shaped / ledger cap | "(N echo-shaped conformers excluded from evidence)" |
| nucleation stand-down | "a newer pattern is emerging here — not flagged" |
| promote | promote (deliberately shared vocabulary with the graph) |

The `where`/`spectrum`/`report` renderers keep numbers (share, counts) because they are evidence,
not internals; thresholds, cell keys, and enumerator ids appear only in `yg roots explain`.

## 12. Port plan — from `roots2.mjs` to `src/roots/`

The prototype is the semantics reference; the port is typed, decomposed, and closes every
SIMPLIFIED/SPEC-ONLY row of the Sync Matrix that phase 1–3 owns:

**Ports as-is (semantics frozen by the harness):** binding derivation + decoration window +
lexical marker; ordinal scope keys; twelve enumerators + per-partition vocabularies; pre-bucketed
weighted clustering + clone-aware ambiguity; the full acceptance chain (KT/MDL, index cost,
fire-ability, survived-raw share, vacuous, absence tiers, placement, fallback buckets, locality pruning,
correlation dedup); specificity governance; compliance closure with the once-per-session ignored
bound; health demotion; verbalizer; spectrum; where; incremental blob cache.

**Productionized in the port — every SIMPLIFIED / SPEC-ONLY row of the Sync Matrix, named:**

- *Correctness, not polish:* **survived-raw fails closed without history** (the prototype marks
  every instance survived when `ageFn` is null, inverting §9.4c and §21.1's J4 silence — five of
  seven measured models ran that way, and shipping it would make a historyless repo *loudest*
  instead of silent); §7.3 tautology filter (its absence also mis-sizes `C`, which is counted once
  repo-wide over filtered candidates, not per partition); ledger weight cap applied inside `w(s,q)`
  before mining and unreleased marks excluded from the survived-raw population; per-fact
  expected-flip filter plus the cross-session closure pass in demotion pooling; `stable_id` (with
  partition + arity + `#k`) replacing the prototype's `relPath#kind#name#k`; null-prototype /
  own-property reads wherever a mined value can collide with an `Object.prototype` key
  (`constructor` is a real method name).
- *Specified but never built:* §8.9b file-scope derived roles (today no file scope carries a role);
  §9.4g stability days; §9.4h `factCap`; §17.3 seed tension (`fix_touches` are collected and never
  read); §9.11 exemplar ranking by `w·m1·centrality` with render-time re-validation; real
  `role_lift` held-out DL with overlap-group exclusion and decorative-role demotion; calibration's
  ascending-Δ grid, family/cluster pools and UB-demotion branch; incidents FIFO 500; the channel
  table + `stop_hook_active`; persisted `aliases`; reaping; `dirtyWeight`.
- *Fidelity fixes:* author identity as sha256 with `Co-Authored-By` trailers and the G.1 fix
  classifier (prototype: FNV hash, no trailers, looser regex); partition roots extended with
  `*.csproj`/`*.sln`/`setup.cfg`; trend `lowSampleMin` 8 with provenance-weighted window shares and
  §9.5's real attractor formula; nucleation's undocumented foothold term either specified or
  removed; dedup lead tie-break and message ordering by `surface asc`; the role-clustering weight
  floor specified rather than hidden; T1's `{unit_plural}` / `{stability_note}` / `{seed_note}` /
  per-row deviation phrase.
- *Infrastructure:* sharded `.cache/blobs/` keyed `blobSha∥extractorVersion∥bindingHash`; walk
  resume from `lastIndexedSha`; the build lock; sessions as append-only event logs; canonical-JSON
  stores with schema versions and atomic writes; sorted-iteration lint + content hashing +
  double-build determinism; genericity lint (as an ESLint rule — §6).

**Explicitly not ported, each with its reason:** `EXT2GRAMMAR` (the registry is the source of
truth — §5); the standalone WASM loader (one parser pool); the shell-out ratchet checker (replaced
by §7 codegen); `mutate-test`'s CLI entry (it becomes a test suite, not a shipped command); the
daemon and its socket/staleness machinery (§9); `check --exit-code` (spec §19's exit 4 — the one
surface that could let roots fail a pipeline by accident; `status --exit-code` remains the single
opt-in gate); `scaffold` (§3); the recognizer pack (spec §10.2 ships none in phase 1 anyway, and a
named-fix layer is a message-quality feature that should be earned from telemetry, not designed
ahead of it — its interface stays in the spec, unimplemented, and it changes no verdict if ever
added).

## 13. Testing — the harness becomes law

Per repo conventions (real on-disk fixtures, built-binary E2E, no artificial mocking):

1. **Unit**: every enumerator (table-driven per Appendix B row), binding snapshots for all **16**
   shipped grammars (the three data grammars included — their snapshot asserts an empty scope set,
   which is the mechanism §5.4 rests on), MDL math against Appendix E's derived fixtures,
   weights/gates/dedup/governance, verbalizer rows, store canonicalization, migrations.
2. **Golden repos**: 13 code grammars + the data-grammar golden (§5.4), scripted deterministic
   histories (`GIT_*_DATE`, `TZ=UTC`, fixed default branch — a determinism block added to
   `tests/support/git-fixture.ts`), MUST-mine / MUST-NOT-mine per golden; CI rebuilds each golden
   from its builder and asserts equality with the committed bundle (fixture-equivalence, §22.7b).
3. **Mutation harness** (ported from `mutate-test`): floor = 65/0/0, 130/130; anchored operators,
   multi-syntax candidates, placement validation by re-extraction, hermetic state; run over the
   goldens (fast) in every repo-check, over the big corpus (nest/immich/flask…) in a scheduled
   job, not the commit gate.
4. **Determinism**: double `index --full` byte-identity; incremental ≡ full on the goldens;
   cache-state independence (measured property, now asserted).
5. **Null control**: shuffled-label null on every golden — 0 accepted role/locality conventions.
   **Fail-closed control**: a golden with its history stripped mines a field but speaks nothing
   (the J4 silence), and `status` explains why.
6. **Compliance loop E2E**: spawn the built `bin.js` (`check` → plant → fix → ledger/telemetry
   assertions) on a fixture project — the flask JSONTag scenario, miniaturized. Fault injection at
   each stage asserts the fail-open boundary returns zero findings + one incident.
7. **Promote E2E**: promote a golden fact → generated aspect passes `yg aspect-test --files` clean
   (the graphless runner, `ctx.files` only — which is what proves the check carries no roots
   dependency), fails on a planted violation, passes on a grandfathered deviant, and survives
   `yg check --approve --only-deterministic` inside the fixture graph — proving the bridge lands in
   the real lock. A second assertion covers the CI contract: before approval the new pair is an
   advisory warning and `yg check` still exits 0.
8. **Hook integration**: recorded stdin fixtures per channel, exact JSON out, `stop_hook_active`,
   debounce/flood, and the DENY-downgrade path when the model is stale.
9. **Coverage** rides the existing ≥ 90 % gate; roots adds no new repo-check step for itself —
   everything above enters through the existing typecheck/lint/build/test/coverage steps, and the
   genericity lint rides the lint step as an ESLint rule (§6), so the AGENTS.md 17-step list is
   unchanged. Two obligations that list does impose: the digest gate means the §8.1 rules/digest
   edit must be regenerated at the repo root **and in every `examples/*/`** carrying its own graph,
   and the big-corpus harness run (nest/immich/flask…) lives beside the gate as a scheduled job,
   documented in `scripts/` as a measurement instrument — never as a commit-time step.

## 14. Documentation

- **docs/**: a concepts page (measured vs declared architecture, the two regimes, locality); a
  quickstart (`index` → first `where`/`check` → first `promote`); a reference page per command
  group; an honesty page (no-history repos, DENY arming expectations and the no-daemon
  consequences, promoted-fact lifecycle).
- **Knowledge base**: `roots-overview` (mental model, storage, never-gates-CI) and
  `roots-promotion` (fact → aspect, ratchet shrinkage, register semantics), listed like any topic.
- **Schemas**: `yg schemas read config` gains the `roots:` block; a `roots-model` schema documents
  the committed snapshot header for tooling.
- **rules.ts/digest.ts**: §8.1 content, regenerated per the standing procedure (root + examples).
- **CHANGELOG**: one `## [Unreleased]` entry per shipped phase, release-notes voice.

## 15. Phases — complete design, staged landing

Everything above is designed now; phases stage the landing so each release is green and useful.
This is not scope reduction: every phase's content is specified in this document and the v6 spec.

- **Phase 1 — the voice and the bridge.** `src/roots/` core (extract/enumerate/roles/mine/verdict/
  speech/stores), `index` (incremental included), **the full-history walk with the sharded blob
  cache, per-scope lifecycle and history weights**, `check` (post/bash/stop/generic channels),
  `where`, `spectrum`, `report`, `status`, `explain`, `mute`, `promote` + advise nominations,
  protocol-path rules.ts/digest, storage + gitattributes + config block, all 14 golden repos, unit
  + harness + determinism + null + fail-closed gates, docs. The history layer is phase 1, not
  phase 2, for a structural reason: the survived-raw gate fails closed without lifecycle data, so a
  phase 1 that shipped mining without history would ship a product that is correctly silent — a
  voice with nothing to say. DoD: all §13 suites green; 14/14 goldens; harness ≥ 65/0/0; warm index
  ≈ 0 parses; dogfood on this repo mines a field and `promote` produces an aspect that survives
  repo-check.
- **Phase 2 — memory over time.** Value events, trends + cohorts + nucleation, co-change +
  completeness sweep, calibration + `calibrate`, walk resume from `lastIndexedSha`, git-hook
  trigger. DoD: replay determinism on goldens; trend/nucleation goldens; calibration correctly
  reports *unavailable* where it is.
- **Phase 3 — judgment and steering.** Native hook installer (claude-code + generic), DENY on the
  pre channel behind calibration, seeds + tensions, campaign export, ratchet-shrink nominations.
  DoD: hook fixtures green; DENY harness row green; `hooks install` round-trip test.

**Open items deliberately excluded** (revisit after phase 3, each needs its own design):
`type-suggest --from-roots`; roots-aware `yg simulate`; cross-repo federation of fields; portal
visualization of the convention field.

## 16. Risks, named

1. **Noise erosion** — the product dies if agents learn to ignore it. The mitigations are
   mechanisms, not intentions: budgets, dedup, health demotion, absence tiers, locality shadowing.
   The phase-1 dogfood here is the canary: if roots annoys the maintainer, it ships nowhere.
2. **Echo** — agents write what roots says, roots learns what agents wrote. `agentShare` alarm,
   ledger cap, hook-shaped exclusion from evidence; phase 1–2, none optional.
3. **Seven unmeasured grammars** — rust/csharp/c/cpp/php/ruby/kotlin get their first real contact
   in the goldens. The golden gate turns that into a work item with a binary per-grammar outcome;
   §5's degradation policy covers the honest worst case.
4. **Committed-model churn** — `model.json` moves on every index of a moving repo. Mitigated by
   `linguist-generated`, deterministic regeneration on conflict, and the fact that only an explicit
   `index` writes it (no daemon, §9). If churn still irritates in dogfood, gitignoring the model and
   rebuilding on clone is a one-line storage flip that changes nothing else here.
5. **Prompt-free by design** — zero LLM calls anywhere: no reviewer cost, no keys, no code leaving
   the machine. Listed as a risk because it must *stay* true; any future feature wanting a model
   call goes through its own design review, not through roots' plumbing.

---

*End of integration design. Mechanism internals: the v6 spec. Measured evidence: the prototype
report. Both are kept in sync with this document's claims.*
