# `yg roots` — Emergent Normative Field Engine
## Consolidated Specification v6 (complete, self-contained, prototype-synced)

**Status:** **v6 — EMERGENT, PROTOTYPE-SYNCED. Supersedes v5.2 entirely; every restated v5 mechanism remains normative.** v6 is v5.2's mechanism inventory and statistical core, re-expressed over an *emergent* feature space: nothing about a programming language, a framework, or a coding style is written down anywhere in the product. Language bindings are **derived** from each tree-sitter grammar's `node-types.json`; features are enumerated generically from raw ASTs and paths; conventions are discovered by the unchanged v5 MDL machinery. Every mechanism in this document has been exercised by a complete working prototype (`roots2.mjs`) on ten real repositories across five languages; Appendix F is the mechanism-by-mechanism sync matrix between this spec and that prototype, with each row marked **MEASURED**, **SIMPLIFIED / production adds …**, or **SPEC-ONLY**. **Synced against prototype revision `md5 bc9eec11…`, 790 lines** — Appendix F's line numbers are valid for exactly that revision and are stamped there; function names are the durable pointers.
**Audience:** an implementing agent (or engineer) with full access to the Yggdrasil repository but no access to the design conversation. Nothing is incorporated by reference: material that earlier drafts pointed at is restated here in full.
**Language of code and identifiers:** English. **Target runtime:** Node.js ≥ 22, TypeScript ≥ 5.5 (the host package's existing pins).
**Normative keywords:** MUST / MUST NOT / SHOULD / MAY per RFC 2119. Every numeric constant either carries a config key (§4.5) or is marked **fixed** here.

**Owner decisions (binding):** `roots` ships inside `@chrisdudek/yg` as the complete product — no experiment gate, no separate package. `roots` NEVER gates CI: every read surface exits 0 by default (§19); nonzero signaling is opt-in via `--exit-code`. Phases (§23) are risk-first; every phase lands components in final form. **Total genericity is binding:** no hardcoded language, framework, or style semantics anywhere outside the extension→grammar map (§6.1) and the fixed binding-derivation rules (§6.2).

**What v6 replaces, and why (no silent drops).** Three v5 subsystems are replaced by strictly better emergent equivalents; each is named at its section:
1. **The hand-written predicate catalog (v5 Appendix B, ~50 rows across 4 languages) → the 12 generic enumerators (§7, Appendix B).** *Replaced by better:* the catalog was a per-language authoring burden that capped discovery at what a human anticipated. The enumerators found strictly more, including entire framework ontologies nobody encoded (NestJS guards/interceptors/pipes/resolvers, Spring's `@RequestParam`/`@ModelAttribute`, Flask's `@bp.route`/`View`/`MethodView`) — measured 25 vs 5 role conventions on the same corpus.
2. **The transform/witness registry (v5 §10, Appendix C) → agent-as-witness (§10).** *Replaced by better:* the consuming agent already writes code; showing it an exemplar contrast is a strictly more general "witness" than a registry of hand-written refactors, and it removes the v5 rule that a convention could be accepted yet permanently mute. An **optional recognizer pack** keeps the named-fix UX for the handful of cases where a canonical mechanical fix reads better than an exemplar.
3. **The 22 hand-assigned predicate families (v5 §7.5) → correlation clusters over discovered surfaces (§9.4e).** *Replaced by better:* families were an authored grouping used for dedup and pooling; conform-set clustering derives the same grouping from data and compresses 2–93 correlated surfaces into one FACT (measured 3.5–58×).

Everything else from v5.2 — the statistical core, the weights, the history layer, calibration, seeds, telemetry, the ledger regulator, the hook runtime, the three stores, the invariants, Appendix E's worked constants — is **restated here unchanged and remains normative**.

---

## 0. One-paragraph summary

`roots` learns the unwritten conventions of a repository from its code and its complete git history — no rules are written, no catalog is authored, no language is special-cased — and enforces them at agent edit time through coding-agent hooks (Claude Code first). Features are enumerated generically from raw syntax trees whose shape the product learns from each grammar's own metadata; conventions are the statistically broken symmetries in that space. When an agent's edit deviates from how *this* repository does things, the hook returns a contrastive, exemplar-backed explanation and the agent — the witness — writes the conforming edit. When an edit is genuinely novel, `roots` stays silent, because silence falls out of repo-dependent conditions. A reporting surface tracks consistency as a (coverage, debt) pair and generates normalization campaigns; a discovered fact can be promoted, on request, into a permanently enforced Yggdrasil aspect with a grandfathering ratchet. The product instruments its own effectiveness: every intervention is logged, per-convention compliance is measured, and conventions agents ignore are automatically demoted.

---

## 1. Glossary (binding)

| Term | Definition |
|---|---|
| **Scope** | A code unit at granularity `method`, `type`, `file`, `module`. Scopes nest (§6.3). |
| **Binding** | The per-grammar derivation (§6.2) of which node types are scopes, imports, decorators, heritage. Computed from `node-types.json`; never authored. |
| **Enumerator** | One of the 12 generic feature generators (§7, Appendix B). Produces surfaces; knows nothing about any language. |
| **Surface** | A named, typed, deterministic feature of a scope produced by an enumerator: boolean (closed alphabet) or categorical (open alphabet with escape `⊥`). v5's "predicate"; renamed because surfaces are generated, not declared. |
| **Vocabulary** | The per-partition, support-pruned set of concrete tokens an enumerator instantiates (§7.2). |
| **Convention** | A (role, surface) or (`_all`, surface) pair accepted by the MDL criterion §9.4. Discovered, never declared. |
| **FACT** | The lead member of a correlation cluster of conventions sharing a conform set (§9.4e). The unit of speech and of reporting. |
| **Role** | A cluster of `method`/`type` scopes induced from catalog-free, directory-free features (§8.1). `file` scopes take a derived role (§8.9b). |
| **Sticky role** | The indexed role of a known scope, which the verdict MUST use in preference to re-classification (§8.6). |
| **`_all`** | The pseudo-role of every non-excluded scope of a partition and kind; hosts partition-global conventions (§9.4b). Shadowed, per surface, by the more specific role or directory convention (§9.4i, §9.10). |
| **Directory context** | A spatial cell `d[<dir>]:<kind>` over an ancestor directory large enough to be a sub-community but smaller than the partition (§9.4i). Sits between the role and `_all` in specificity. |
| **Preference gap Δ** | `log2(p̂(expected)/p̂(observed))` bits — the severity currency (§9.7). |
| **Witness** | The consuming agent, shown the exemplar contrast (§10). Every hook-eligible FACT therefore has a witness; v5's "observation tier" for want-of-transform is retired. |
| **Recognizer** | An optional, named mechanical fix for a recognized fact family (§10.2, Appendix C). UX layer, never a gate. |
| **Seed** | Maintainer-authored exemplar with extra weight for explicitly listed surfaces; committed, audited (§17). |
| **Field partition** | Unit of vocabulary/role/convention computation: nearest package root (§6.8). |
| **`hook_shaped`** | Committed provenance mark: this (scope, surface) reached its value because roots asked (§18.3). Weight-capped until independently ratified. |
| **`agentShare`** | Unsurvived-agent fraction of recent norm weight — a cohort composition diagnostic (§18.4), not a loop gain. |
| **Coverage / debt** | §16.2. Read as a pair; computed over hook-eligible FACTs. |

---

## 2. Principles, operationalized

**P1 — Convention = broken symmetry; novelty = the repo has not voted.** The space of enforceable choices is enumerated generically per repository (§7), not per language. Silence on novelty is produced by: no accepted convention covers the (role, surface); the scope's role is ambiguous (§8.7); or the partition never expressed the choice at all — the **vacuous filter** (§9.4d), which is P1 applied literally: a negative fact about a token the partition has never once used is a non-choice, not a convention. A **never-before-seen categorical value** is semi-novel: it can be warned about (once, with a novelty note) but never denied (§9.7).

**P2 — The currency is the bit, spent twice.** A convention exists iff conditional coding beats the partition-level code on the convention's own instances, after paying parameter cost and the model-index cost `log2(C₂)` — the multiple-comparison control lives inside the formalism (§9.4). Severity is the preference gap Δ — a property of the contrast, not of sample size: no ceiling, no saturation.

**P3 — The norm is the survived stock; the attractor is advisory.** Hooks enforce only what is overwhelmingly established in the survived stock (`expected` = weighted argmax, guarded by a raw-count gate so displayed evidence always agrees — §9.4c). Trends serve reporting/campaigns and **standing down** (nucleation suppression, §9.6). Hooks never enforce a minority value; transition enforcement is structurally impossible, not merely disabled (Appendix E.5).

**P4 — Severity escalates with architectural reach.** DENY requires calibrated precision (§14), high coupling (§9.9), and the daemon (§12.6). Everything else is at most WARN. v5's `arch_class` flag was a property of hand-authored catalog rows; with no catalog it is replaced by the **structural-reach test** of §9.9 (coupling percentile + cross-file surface class), plus `seed --arch` as the audited manual route.

**P5 — The loop is regulated with shared state.** The committed `hook-ledger.jsonl` (§18.3) caps the weight of code that conforms *because roots asked*, on every machine and in CI, until survival plus genuinely independent human touch ratifies it. `agentShare` (§18.4) is the composition diagnostic; compliance telemetry (§18.1–18.2) demotes conventions agents ignore.

**P6 — Genericity is a correctness property, not an aesthetic.** Any behavior that cannot be derived from (a) a grammar's own `node-types.json`, (b) the repository's own content, or (c) the extension→grammar map, MUST NOT exist in the product. This is testable: §22.9 is a lint that fails the build on any language, framework, or style identifier in `src/roots/**` outside `EXT2GRAMMAR`.

---

## 3. Product definition

### 3.1 Goals
G1 hook-time contrastive feedback (latency §20); G2 self-emerging conventions + authored seed priors (yg rules = written constitution; roots = read constitution; seeds = written priors over it); G3 reporting & campaigns (§16); G4 feedforward brief/scaffold (§15); G5 completeness checking (§13.5, Appendix G.4); G6 self-measurement with automatic demotion (§18); **G7 promotion of a discovered fact into a permanently enforced Yggdrasil aspect with a grandfathering ratchet (§24).**

### 3.2 Non-goals & honest scope
- No embeddings, no cross-repo field (reserved interfaces live as doc-commented TypeScript in `src/roots/ext/`; no plumbing), no NL artifacts, no network, no auto-refactors.
- **Hook-speech domain.** Every accepted, hook-eligible FACT can speak, because the witness is the consuming agent (§10). This is a deliberate widening of v5, whose per-(pid, expected) witness table left whole families permanently mute. What remains report-only is decided by *statistics*, not by a transform inventory: minority-argmax facts, fallback-bucket argmax facts (§9.4c), vacuous facts (§9.4d), and locally demoted facts (§18.2).
- roots does not rank or judge code quality. A convention is a majority, not a virtue.

### 3.3 Invariants (binding — I1–I10 restated from v5, unchanged by emergence)
- **I1 Fail-open:** any hook error ⇒ allow silently + incident record (§21.1). A broken roots MUST NOT block an edit.
- **I2a Model determinism:** given identical (HEAD SHA, dirty-file content hashes, merged-config hash, `seeds.jsonl` hash, `hook-ledger.jsonl` content hash, roots version), a full build (`index --full`) produces byte-identical model artifacts. Sorted iteration everywhere in model code (lint-enforced); clock = HEAD committer timestamp (§20.2); no surrogate ids in any hashed/exported artifact. The ledger hash is computed over the working-tree file content; `.yggdrasil/roots/**` files are excluded from `dirtyHash` (they are separately hashed inputs). **Emergent addition:** vocabulary selection (§7.2) MUST be deterministic — support-then-count ordering with `token asc` as the total tie-break — because a vocabulary flip changes every downstream count.
- **I2b Local modulation, declared:** hook *speech* is additionally modulated by machine-local state. Modulators MAY downgrade severity or silence; they MUST NOT upgrade. The complete modulator table: (1) session dedup + budgets (§11.3); (2) telemetry demotion (§18.2, via `demotions.json`); (3) staleness ⇒ DENY findings delivered as post-tool WARN with a staleness note (§12.7); (4) daemon-absent ⇒ same downgrade (§12.6); (5) bash-sweep `seedTruncated`/`floodSkipped` suppression (§12.4). `status` lists every active modulator.
- **I3 No network. I4 No exfiltration** — instrumentation is local files under the repo; nothing is transmitted.
- **I5 Silence on ambiguity:** role-ambiguous scopes get no role-conditioned messages; `_all` conventions still apply.
- **I6 Budgeted interruption** (§11.3).
- **I7 Three stores, three lifecycles** (§4.4): committed inputs; rebuildable cache (safe to wipe); durable local state (survives `index --full`; only `roots reset --state` clears it).
- **I8 Read-only toward source.** `init` writes only: `.yggdrasil/roots/config.json`, gitignore entries, `.claude/settings.local.json` (or `settings.json` with `--commit-hooks`), and the ledger file header — each enumerated in the confirmation prompt. Hooks append only to `.roots-state/` and `hook-ledger.jsonl`. `export-aspect` (§24) writes only under `.yggdrasil/aspects/` and only on explicit request.
- **I9 Language-agnostic core — strengthened to total genericity (P6):** there are no language adapters. `EXT2GRAMMAR` (§6.1) is the only per-language datum in the product.
- **I10 Yggdrasil-optional:** no graph, no problem. roots MUST NOT create or modify graph nodes, `yg-architecture.yaml`, or lock files **except** through `export-aspect` (§24), which is an explicit, confirmed, user-initiated command.

### 3.4 User journeys (acceptance-level)
- **J1:** `npx yg roots init` on a mature repo in any supported grammar → index within budget → hooks installed on confirmation → a session violating a mined FACT receives ≥ 1 correct contrastive warning; a session writing conforming or novel code receives zero messages (first Bash sweep seeds silently, §12.4). Verified by the mutation harness (§22.4) — **measured on the final prototype: 65 planted deviations detected, 0 missed (over mutable cases — §22.4), 0 false fires, 130/130 silence on unmutated exemplars, across 7 models spanning TypeScript/JavaScript and Python including two full-history models** (qualifiers in H.4) (an earlier operator generation scored 40/43 with 1 false fire; every gap was a harness-mechanics artifact — wrong-occurrence anchoring, injection outside the body — eliminated by anchoring operators at the exemplar's recorded line and validating injection placement by re-extraction).
- **J2:** `yg roots report` → coverage/debt, top FACTs, trends, cohort trends, campaigns, convention health.
- **J3:** `yg roots seed add src/handlers/refund-handler.ts --surfaces <list> --weight 8 --note "target handler shape"` → posteriors shift for exactly those surfaces (seeds *nudge*: the pseudo-count cap means a seed cannot conjure a convention out of an empty cell — stated limitation, §17.1), decision entry written, tension surfaced if present.
- **J4:** repo with < 300 scopes or no git history → init succeeds, hooks install, system silent, `status` explains why.
- **J5 (new):** an agent, having received a WARN it agrees with, asks for the convention to become permanent → `yg roots export-aspect <factKey>` → a `yg-aspect.yaml` + standalone ratchet check appear under `.yggdrasil/aspects/`, grandfathering today's deviants; `yg check` and CI enforce it from then on. **Prototype-verified live** (§24, Appendix H.5).

---

## 4. Architecture & repository integration

### 4.1 Placement (verified against the real repo)
All code at **`source/cli/src/roots/**`** (a sibling of `source/cli` would silently escape the repo's typecheck/lint/coverage globs). Tests: `source/cli/tests/roots/**`, `tests/e2e/roots-*`, fixtures `tests/fixtures/golden/roots-*`.

Module map: `extract/ binding/ enumerate/ roles/ history/ norm/ verbalize/ calibrate/ verdict/ hook/ report/ seed/ store/ telemetry/ aspect/ cli/ shared/` with responsibilities as named throughout this spec. Note `binding/` and `enumerate/` replace v5's `adapters/` and `predicates/`. CLI commands register in `src/bin.ts` like the existing ~22 commands; handlers load roots via dynamic `import()` — with `tsup` `splitting: false` this defers execution, not bundle parse.

**Reuse contract.** MUST use: existing web-tree-sitter ^0.26 + `dist/grammars/` assets, `ParseCache` + WASM tree lifecycle discipline, sha256 utils from `src/io/hash.ts`, `tests/support/git-fixture.ts` for git-touching tests. **New code (verified not reusable):** scope-granular extraction, the repo-wide `--raw` walk + `cat-file --batch` client (`src/utils/git.ts` has two per-file helpers only, one using the forbidden `--follow`), the daemon.

**Grammar assets.** The product's language reach equals the set of grammar WASMs shipped in `dist/grammars/` plus their `node-types.json` files. Both are already produced by the existing build for 12 grammars. **The `node-types.json` files MUST be shipped alongside the WASMs** — they are the binding source (§6.2) and are today used only at build time. This is the single packaging change v6 requires.

**Host-repo obligation (budgeted in Phase 1):** the maintainer authors `yg-architecture.yaml` node types and the `model/cli/roots/**` node subtree during the Phase-1 design-lock step — never created programmatically (I10). The Phase-1 task list also includes extending `tests/support/git-fixture.ts` with a determinism block (§20.2).

### 4.2 Data flow
1. `index`: bindings → extract → vocabularies → enumerate → roles → full-history join → norm (accept → gates → dedup) → calibrate → snapshot. Pure per I2a.
2. Hook: post-edit content → extract + enumerate for changed scopes (+ enclosing type + file) → **sticky-role lookup, else classify** → verdict §9.10 → protocol response. Hooks never mutate the model (they append only to local state and the ledger).
3. `report`/`campaign`/`seed`/`brief`/`export-aspect` read the same model.

### 4.3 Dependencies
`web-tree-sitter` ^0.26 (present), `zod` ^3 (new, pure JS). No storage dependency (JSON stores), no git library, no native modules, no ML/network/telemetry packages — MUST NOT add any.

### 4.4 The three stores (I7) — unchanged from v5

```
.yggdrasil/roots/                     # COMMITTED
  config.json  seeds.jsonl  decisions.jsonl  hook-ledger.jsonl

.yggdrasil/.roots-cache/              # GITIGNORED, rebuildable, safe to wipe
  model.json                          # string-keyed snapshot (Appendix D) — the model file the hook loads
  scopes/<2-hex>.json  blobs/<2-hex>.json      # blobs/ = the content-addressed historical-blob AST cache (§13.2)
  lifecycle.json  aliases.json  cochange.json  calibration.json
  roots.sock                          # daemon socket (runtime, not data)

.yggdrasil/.roots-state/              # GITIGNORED, durable; survives index --full
  telemetry.jsonl                     # retention: telemetryRetentionDays, compacted at index
  demotions.json                      # materialized §18.2 output; the hook reads this, never telemetry.jsonl
  debt.series.jsonl  incidents.jsonl  sessions/<id>.jsonl
```
Gitignore entries are added to the hardcoded list in `init-scaffold.ts` and propagate via `init --upgrade`. `model.json` header: `{rootsVersion, configHash, seedsHash, ledgerHash, headSha, lastIndexedSha, dirtyHash, clock, candidateCountLog2, rolesStale, bindingHash}` — **excluded from the snapshot content hash**. `bindingHash` (new) = sha256 over the sorted derived binding sets of every grammar used, so a grammar upgrade that changes node types invalidates the model rather than silently shifting features.

**Writer concurrency (binding):** all cache writers (`index`, `init`, `calibrate`, the daemon's background reindex) take a single exclusive `.roots-cache/.build.lock` (O_EXCL, pid inside, stale after 15 min — **fixed**). The daemon **skips** its debounced reindex when the lock is held (retry on next debounce); CLI builds wait briefly, then fail with a what/why/next message naming the holder. Readers (hooks, `report`, `status`) never take the lock — `model.json`'s atomic rename gives them a consistent view; §18.2's demotions aggregation runs inside the lock with the snapshot write.

### 4.5 Configuration (complete; unknown keys ⇒ hard error; `configHash` = sha256 of merged canonical JSON)

```jsonc
{
  "version": 1,
  "include": ["**/*"], "exclude": [],
  "partition": { "mode": "auto" },
  "history": {
    "full": true,                     // v6 DEFAULT: walk EVERY commit. windowMonths applies only when false.
    "windowMonths": 24, "maxCommits": 0,   // 0 = uncapped (the v6 default); nonzero caps for emergency use only
    "megaCommitFileCap": 30,
    "churnEarlyDays": 14,
    "blobMaxBytes": 1500000,
    "lifecycleFileMaxKb": 300, "lifecycleMaxAppearances": 200,
    "agentIdentities": ["claude","copilot","cursor","codex","devin","\\bbot\\b","gpt","gemini","dependabot"]
  },
  "enumerate": {                      // §7.2 — support floors and per-partition top-K per enumerator
    "support":  { "nodeType": 20, "call": 8, "import": 5, "supertype": 4, "shape": 15, "decorator": 8 },
    "topK":     { "nodeType": 30, "call": 80, "import": 60, "supertype": 30, "shape": 40, "decorator": 40 },
    "shapeDepth": 2, "shapeMaxStatements": 20, "pathSegments": 3, "localVarSampleMax": 20
  },
  "weights": {
    "survivalFullDays": 120, "freshPenaltyDays": 14,
    "agentBase": 0.15, "agentPromoteDays": 180,
    "baseFloor": 0.05,
    "hookShapedWeight": 0.15,         // cap applied LAST, after degraded modes (§9.1)
    "noLifecycleWeight": 0.3, "dirtyWeight": 0.3,
    "seedDefaultWeight": 8, "seedCapFraction": 0.5
  },
  "mdl": { "acceptMarginBits": 4.0, "minInstancesRaw": 5, "minInstancesEff": 3, "factCap": 400,
           "dedupJaccard": 0.9, "dirContextMinScopes": 25 },   // §9.4i directory contexts
  "thresholds": {
    "preferenceGapBits": 2.5,         // τΔ default for presence/categorical facts; calibration may only raise it
    "absenceGapBits": 3.5,            // τ for VOCABULARY absence facts (call/decorator/import/supertype) — §9.4f
    "absenceGapBitsStructural": 4.5,  // τ for STRUCTURAL absence facts (auto.has:/auto.stshape:) — §9.4f
    "eligibilityMinRawShare": 0.6666666666666666,
    "denyExtraBits": 1.5, "denyMinPrecision": 0.9,
    "roleAmbiguityGap": 0.15, "roleMinMembership": 0.35,
    "couplingPercentileForDeny": 75
  },
  "calib": { "horizonDays": 365, "settleDays": 30,
             "minEventsConvention": 12, "minEventsFamily": 30, "minEventsDeny": 35,
             "targetPrecision": 0.8 },
  "trend": { "windowDays": 90, "windowCount": 8, "maxWindows": 24, "attractorSlopeK": 2.0, "lowSampleMin": 8,
             "cohortBy": "birthYear",
             "nucleation": { "minSlopePerQuarter": 0.02, "minWindows": 3, "minHumanAuthors": 2 } },
  "cochange": { "minSupport": 8, "minConfidence": 0.75, "maxPairs": 5000 },
  "ledger": { "releaseStableDays": 90, "releaseMinDaysAfterMark": 14 },
  "budgets": { "maxMessagesPerResponse": 3, "sessionMaxWarnings": 12,
               "hookHardTimeoutMs": 900, "hookColdBudgetMs": 700, "daemonBudgetMs": 50,
               "bashSweepDebounceMs": 5000, "bashSweepMaxFiles": 5, "bashFloodThreshold": 20 },
  "health": { "minCompliance": 0.3, "minSamples": 8, "telemetryRetentionDays": 180, "agentShareAlarm": 0.85 },
  "completeness": { "mode": "stop-feedback-once", "maxItems": 5 },
  "seed_tension": { "minFc": 1.5, "minN": 10 },
  "report": { "topFacts": 20 },
  "hooks": { "claudeCode": { "postTool": true, "preTool": false,
                             "bash": true, "userPromptBrief": false, "stopCompleteness": true } },
  "roles": { "clusterSampleCap": 700, "reinduceTouchedFraction": 0.05, "reinduceTouchedMin": 200,
             "minClusterSize": 3, "minOwnFeatures": 2, "cloneMedoidJaccard": 0.6 },   // §8.5 clone-aware runner-up
  "sessions": { "pruneDays": 7 },
  "daemon": { "idleExitMinutes": 30, "connectTimeoutMs": 25, "reindexDebounceSeconds": 30 }
}
```
**Binding-derivation rules are NOT configuration.** The regexes and field tests of §6.2 are fixed product logic; exposing them as config would let a user break genericity by hand and would make `bindingHash` meaningless. `EXT2GRAMMAR` is likewise fixed (extending it is a product change shipping a grammar).
Constants stated in prose as **fixed** (oversize limits §6.1, module rule §6.3, 300-scope partition floor §6.8, KT α = ½ §9.3, campaign tier multipliers and task size §16.3, agentShare's 120-day cohort window §18.4, incident FIFO 500 §21.1, T5's ≤ 5 items, hook `timeout` seconds §12.2, Wilson z = 1.96 two-sided §14, build-lock staleness 15 min §4.4, dedup lead selection §9.4e) are deliberate non-config.

---

## 5. Storage — three-store JSON layer

Canonical JSON (sorted keys, `\n`, UTF-8, shortest-round-trip number formatting), atomic writes (tmp + rename), 2-hex sharding by sha256 of the record key, `schemaVersion` per store with forward-only migrations. Every array sorted by natural string key. No surrogate ids.

**Sparse booleans.** Boolean surfaces are stored only when `true`, with a per-surface **applicability domain** declared by the enumerator as a rule computable *without* evaluating the surface (Appendix B column `domain`). Example: `auto.has:<nodeType>` — domain = "all `method` scopes in cleanly-parsed files of a grammar whose vocabulary contains `<nodeType>`". Counting: `n_false(q, r) = |domain(q) ∩ members(r)| − n_true(q, r)`. A scope outside the domain contributes nothing (undecidable ≠ false). A property test asserts sparse counting ≡ dense counting on small fixtures.

**Reaping.** Every build enumerates current files and deletes store rows for missing paths. Renames from the walk write `aliases.json` (`old → new`, chains compressed); lifecycle, ledger, and calibration lookups follow aliases.

---

## 6. Extraction layer

### 6.1 Parsing and the extension→grammar map
Existing web-tree-sitter + `ParseCache`, trees explicitly released. Oversize (> `history.blobMaxBytes` / > 40k lines) ⇒ excluded. Parse errors ⇒ error-free subtrees only; root error ⇒ file granularity. Never abort (I1).

`EXT2GRAMMAR` maps file extension → grammar name and is the **only** per-language datum in the product:
`.ts .mts .cts → typescript · .tsx → tsx · .js .mjs .cjs → javascript · .py → python · .go → go · .java → java · .rb → ruby · .rs → rust · .cs → c_sharp · .php → php · .c → c · .cpp → cpp · .kt → kotlin`.
For historical blobs the grammar MUST be chosen from the **historical path's** extension recorded in the walk — never by sniffing content (§13.2).

### 6.2 Binding derivation (the heart of total genericity) — fixed rules
For each grammar `g`, load `dist/grammars/tree-sitter-<g>.node-types.json` once and derive `binding(g)`:
- **Scope node types** := every node type declaring **both** a `name` field and a `body` field. This single rule yields functions, methods, classes, structs, interfaces, modules, and impl blocks across every grammar tested, and admits nothing else.
- **Import node types** := node types whose name matches `/import|include|use_declaration|require/` and does not start with `_`.
- **Decorator node types** := node types whose name matches `/decorator|annotation|attribute_list/`, **with a lexical marker requirement at extraction time: a candidate node counts as a decoration only if its source text begins with `@` or `[`** (after leading whitespace). The name regex alone over-matches: TypeScript's `type_annotation` satisfies it, and without the marker filter a field's type (`queue: fastq.queueAsPromised<…>`) was mined as the decorator `@fastq.queueAsPromised` — spawning both a spurious role convention and a spurious repo-wide absence fact (prototype-observed on a real repo). The marker is language-lexical, not semantic: Python/TS decorators and Java/Kotlin annotations start with `@`, C# attribute lists with `[`; annotation-*shaped* grammar names that are really type syntax never do.
- **Decoration attribution window (binding).** A marker-passing candidate found among a scope node's siblings/ancestors is attributed to that scope **only if its start row lies strictly after the end row of the scope's previous non-decoration, non-comment sibling (`loRow`) and at or before the start row of the scope's own `body` (`bodyRow`)**. The window is closed on both sides for two independent reasons. Its lower bound is what prevents a preceding member's decorators — in a class body, *every* earlier method's — from being attributed to this scope; a one-sided "decorator ends at or just above my start row" test attributes the whole preceding stack and was a measured defect. Its upper bound at `bodyRow`, rather than at the scope's start row, is what makes the rule complete: a **decorator stack of any height** (any number of consecutive decorations after the previous sibling) is attributed in full, and **parameter-level annotations** — which sit lexically after the scope's name and before its body — are attributed to the scope that declares them rather than being lost. Comments between decorations do not close the window; any other sibling does.
- **Heritage node types** := node types whose name matches `/heritage|extends|implements|superclass|super_interfaces|base_|superclasses|argument_list/`, evaluated on a scope node's own named children excluding its `body`. (`argument_list` is included because Python expresses base classes that way; restricting the match to non-body children of a scope node keeps it from matching call arguments.)
- **Scope kind** := `type` when the node's `body` subtree contains at least one further scope node; `method` otherwise. Container/leaf, derived — not a keyword list.

Bindings MUST be computed once per grammar per process and cached. `bindingHash` (§4.4) covers all derived sets. A grammar that yields an empty scope set is disabled for the session with one incident (I1) — the product degrades to file/module-level facts for that language rather than failing.

**Verification (Appendix H.3):** the rules were exercised unchanged on TypeScript, TSX, JavaScript, Python, Java and Go. Java and Go required **zero lines of language-specific code** and immediately produced correct role and decorator ontologies (Spring's `@RequestParam` / `@ModelAttribute` / `@Pattern` / `@DateTimeFormat`; Go's `NewRouter` construction convention).

### 6.3 Scope model
`method`, `type`, `file`, `module`; one `file` scope per file; `module` = nearest of partition root or first directory with ≥ 3 code files (**fixed**); nesting method→type|file, type→file, file→module. Module scopes carry only the E12 surfaces (§7.1).

### 6.4 Stable identity
`stable_id = sha256hex(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ arity)[:16]` — full path including filename. Rename continuity via `aliases.json`, not identity weakening. Overloads beyond arity: `#k` by source order. Anonymous: `<anon>` + ordinal. The hook's sticky-role lookup (§8.6) keys on `relPath ∥ kind ∥ name`, which is stable under the reconstructed post-edit content and is the key persisted in the snapshot's `assignments` map.

**Occurrence ordinals are not optional, and MUST be identical on every keyed surface (binding).** Extraction assigns each scope the occurrence index of its `(kind, name)` pair within its file, in source order, and every key that names a scope carries it (suffix `#k`, elided at k = 0 so single-occurrence keys stay readable). Without it, two same-named scopes in one file — an overload pair, two `<anon>`s, a method and a same-named inner function, a repeated nested class — collapse into one key and silently share a role, a lifecycle, a verdict, a telemetry stream and a ledger mark. The ordinal MUST therefore appear in: sticky-role `assignments`, the verdict's scope key, telemetry and ledger keys, the hook-shaped weight-cap key, and — this is the half that is easy to miss — the **historical** keys of the full-history replay: lifecycle rows and value events are keyed off blob-extracted scopes, so blob extraction MUST ordinal identically or the live and historical key spaces silently fail to join, and a scope's own history attaches to its namesake. (The prototype implements this rule at its own key granularity, `relPath#kind#name#k`; production's `stable_id` subsumes it via `arity` plus `#k by source order` above.)

### 6.5 Normalization & hashing
`body_hash`: sha256 of the scope's token stream, comments stripped, literals kind-marked (`STR`/`NUM`), whitespace collapsed, identifiers kept. `signature_hash`: same over the signature region. `blob_hash`: sha256 of newline-normalized bytes.

**Change signature for value events (binding; a defect found by the prototype).** The hash that decides whether a scope *changed* between two historical blobs MUST include, at minimum: first-statement type, the set of node types present, the set of callee texts, **the decorator list, the supertype list, and the name shape**. An earlier body-only signature made a decorator added without a body change invisible — the exact event class trends and calibration exist to observe. See §13.3.

### 6.6 Incremental protocol
1. Enumerate (`git ls-files` ∪ untracked-not-ignored, filtered).
2. Unchanged (path, blob_hash) ⇒ skip; else reparse, diff scopes by stable_id, upsert/delete; reap missing files.
3. **History increment:** the walk resumes from the snapshot's `lastIndexedSha`, appending commits, lifecycle updates, and value events; a full walk runs only on `--full` or when `lastIndexedSha` is unreachable (rebase). Because every distinct blob is parsed at most once ever (§13.2), a resumed walk parses only blobs new since `lastIndexedSha`. A HEAD change re-derives every partition's norm/trends/calibration (the clock enters the weights) but re-extracts nothing for unchanged files.
4. **Vocabulary stability:** vocabularies (§7.2) are recomputed on every build. When a recomputed vocabulary differs from the snapshot's, all surfaces of the affected enumerator MUST be re-enumerated for the whole partition (they are cheap, in-memory functions of already-parsed scopes) — a partially-refreshed vocabulary would mix incomparable counts.
5. Roles: re-induce the partition only when touched-since-last-induction > `max(reinduceTouchedMin, reinduceTouchedFraction × N)`; otherwise nearest-medoid assign touched scopes and set `rolesStale: true`.
6. A build whose full input tuple (HEAD, dirty hashes, config, seeds, ledger, bindings) is unchanged performs zero writes to `.roots-cache/` — a correctness statement (I2a), not an optimization.

**Budgets:** the ≤ 3 s incremental target (§20.1) applies to non-re-induction builds; a build that re-induces roles has its own budget (≤ 60 s at N = 6000). **I2a property test:** two `--full` builds byte-identical; an incremental build equals the full build after forcing `index --full`.

### 6.7 Extraction contract
Pure functions of (tree, fileCtx, binding); no I/O; ≤ 3 ms per 1k LOC; booleans emit only `true` + domains. Scope walking MUST NOT descend into a nested scope's body when collecting a parent's statement-level features (nested scopes are their own instances); the prototype enforces this with an `isScope` guard on the descent stack and a 4000-node visit cap per scope (**fixed**, an I1 guard against pathological generated files).

### 6.8 Field partitions
`auto`: a partition root is any directory containing a non-empty `package.json`, `pyproject.toml`, `go.mod`, `pom.xml`, `Cargo.toml`, `*.csproj`/`*.sln`, or `setup.cfg`; nested roots win (closest ancestor). Files under no root ⇒ `_root`. A partition ending with < 300 scopes (**fixed**) merges into `_repo`; if the merged bucket itself has < 300 scopes there is no partition and the repo is silent (J4). Vocabularies, roles, conventions, trends and calibration are **per partition**; co-change is repo-global.
**Per-partition vocabulary is normative** (empirically motivated): a global vocabulary leaks tokens from one package into another as vacuous negatives.

**Built-in exclusions (full, binding):** `**/node_modules/**, **/bin/**, **/obj/**, **/dist/**, **/build/**, **/out/**, **/.git/**, **/.yggdrasil/**, **/vendor/**, **/target/**, **/coverage/**, **/.next/**, **/__pycache__/**, **/migrations/**, **/fixtures/**, **/benchmarks/**, **/__mocks__/**, **/*.min.*, **/*generated*/**, **/*.d.ts** — and test-pattern files (`*.test.*`, `*.spec.*`) for *convention mining*, which remain fully counted for co-change and history.** `.yggdrasil/**` is in the list because tool state polluted a dogfood run's `_root` partition. Merged with config `exclude`.

---

## 7. The enumerated feature space (replaces v5's authored predicate catalog)

### 7.1 The twelve enumerators
Each produces surfaces named `auto.<enumerator>[:<token>]`. Full table with applies-kind, type, class, domain, history class and verbalization in **Appendix B**.

| # | Enumerator | Surface(s) | Kind | What it captures |
|---|---|---|---|---|
| **E1** | Name morphology | `auto.nameshape`, `auto.filenameshape` | cat | Identifier reduced to a char-class string (`[A-Z]+`→`U`, `[a-z0-9]+`→`a`, others→`?`) with runs of period ≤ 3 folded to `(x)+`. **Casing conventions emerge** rather than being classified: `(Ua)+` is PascalCase, `a(Ua)*` camelCase, `a(_a)+` snake_case. |
| **E2** | Arity | `auto.arity` | cat | Parameter-count band `0\|1\|2\|3+`. |
| **E3** | Node-type presence | `auto.has:<nodeType>` | bool | Whether the scope's body contains a node of a vocabulary node type (statement/expression/declaration/clause types only). |
| **E4** | First statement | `auto.first1` | cat | Node type of the scope's first body statement — guard clauses, docstring-first, early-logging all fall out. |
| **E5** | Return shape | `auto.ret` | cat | Node type of the last return's expression (or `bare`). |
| **E6** | Callee & decorator vocabulary | `auto.call:<callee>`, `auto.deco:@<name>` | bool | Whether the scope calls a vocabulary callee / carries a vocabulary decorator or annotation. **This is where framework ontologies live.** |
| **E7** | Path segments | `auto.dir1..dirN` | cat | The first `enumerate.pathSegments` directory segments of the containing file. **Role-conditioned only** (§9.4c). |
| **E8** | Import specifiers | `auto.imp:<specifier>` | bool | Whether the file imports a vocabulary specifier. Relative specifiers MUST be normalized to repo-rooted `~/`-prefixed paths with the extension stripped before vocabulary building, so `../core/check.js` and `./check.js` are one token. |
| **E9** | Supertypes | `auto.extends:<type>` | bool | Whether the scope declares a vocabulary supertype/interface (heritage nodes per §6.2). |
| **E10** | Statement subtree shapes | `auto.stshape:<shape>` | bool | Presence of a depth-`shapeDepth` serialization `type(child,child,child)` of one of the scope's first `shapeMaxStatements` statements, children truncated to 3. Mines *idioms*: docstring-first, `with`-block assertion pairs, typed-parameter signatures. |
| **E11** | Local-variable morphology | `auto.varshape` | cat | Modal E1 shape over the scope's declared locals (min 2 locals, sampled to `localVarSampleMax`). |
| **E12** | Module level | `auto.moddirshape`, `auto.modfileshape`, `auto.modsize` | cat | Directory-name shape, modal file-name shape within the directory, and directory size band `3-7\|8-19\|20+`. |

E1–E2, E4–E5, E10–E11 apply to `method`; E1, E6(deco), E9 to `type`; E1(file), E7, E8 to `file`; E12 to `module`. E3/E6(call)/E10 are method-only because they read a body's statements.

### 7.2 Vocabularies — per partition, support-pruned, deterministic
For each partition and each vocabulary-bearing enumerator (E3, E6-call, E6-deco, E8, E9, E10):
1. Count distinct tokens over the partition's scopes of the applicable kind.
2. Drop tokens below `enumerate.support[<enumerator>]`.
3. Keep the top `enumerate.topK[<enumerator>]` by count, ties broken by `token asc` (I2a).
4. Instantiate one boolean surface per surviving token on every applicable scope.

Support floors and top-Ks are the product's only tuning surface for the feature space, and they exist to bound `C` (§9.4a) — not to encode taste. Callee texts longer than 40 characters or containing newlines are dropped (**fixed**) as extraction noise.

### 7.3 Classes, circularity control, and overlap
Every surface is `identity` (what/where the scope is: E1, E2, E7, E12) or `behavior` (how it is written: E3–E6, E8–E11). Role features (§8.1) are drawn from name tokens, supertypes, decorators and package-import segments; the **overlap groups** are therefore `name-tokens` (↔ E1), `supertype` (↔ E9), `decorator` (↔ E6-deco), `import-segments` (↔ E8, and ↔ E7 placement). A (role, surface) candidate whose overlap group is among the role's defining feature groups (§8.8) is skipped as `tautological` — visible in `explain`, never accepted. `_all` candidates are exempt. This is v5 §7.1's mechanism with the group map derived from §8.1 rather than authored per row.

### 7.4 Extraction/enumeration budget
Enumeration is a pure function of already-parsed scopes and the partition vocabulary; it MUST allocate no trees and MUST NOT re-walk source. Measured cost is negligible next to parsing (Appendix H.2).

---

## 8. Role induction

### 8.1 Feature bag F(s) — catalog-free, directory-free
Kinds `method`/`type` only. `F(s)` = the union of:
- `tok:<t>` — own-name tokens (casing-boundary tokenization, tokens of length ≥ 2),
- `sup:<T>` — declared supertype / interface names (E9 raw, not vocabulary-pruned),
- `dec:<D>` — decorator / annotation names (E6 raw),
- `imp:<seg>` — the last segment of up to 5 distinct **package (non-relative)** import specifiers of the containing file (relative imports excluded so directory structure cannot leak in — §7.3).

**Decorators and supertypes in the bag are normative and empirically load-bearing:** a partition clustered with decorator+supertype features showed **39%** role ambiguity versus 56–85% with sparse bags. Ambiguity is silence (I5), so feature richness is directly the product's role-layer yield.

**`_untyped` gate:** a scope with fewer than `roles.minOwnFeatures` (2) **discriminative** own features — name tokens ∪ supertypes ∪ decorators; signature-derived buckets are total functions of every scope and would make the gate inert — is excluded from clustering and from role-conditioned conventions. `_untyped` members still count in `_all`.

### 8.2 Distance
Jaccard on feature sets; all ties broken by `stable_id` lexicographic order.

### 8.3 Clustering & the MDL cut
Average-linkage agglomerative per partition (Lance–Williams update on a materialized distance matrix), over at most `roles.clusterSampleCap` (700) clustering points when the partition is larger. **The sample cap MUST be applied to distinct feature bags, not to scopes (binding).** Eligible scopes are first bucketed by their exact feature bag; each bucket contributes **one weighted representative** carrying `w = |bucket|`, and the deterministic stride sample — when it is still needed — runs over representatives. Weights then propagate through the whole clustering: Lance–Williams uses weighted cluster sizes, the cluster DL of §8.3 counts feature occurrences and `n_c` in member weight, the medoid minimizes the *weight-summed* distance, and `roles.minClusterSize` is a **total member weight**, not a representative count. Two properties follow, both load-bearing: identical twins can never be separated by sampling (they are one point by construction), and effective clustering capacity rises from `clusterSampleCap` scopes to `clusterSampleCap` *distinct* bags — on real repositories a large multiple, because framework code is repetitive by nature. Measured: a stride sample over raw scopes destroyed a role outright by admitting only some of a set of identical classes; pre-bucketing restored it. Cut selection: minimize
`DL(cut) = Σ_clusters Σ_{features PRESENT in the cluster} [ n_c·H(p_f) + 0.5·log2(max(n_c,2)) ] + k·log2(N)`
where `p_f` = the feature's within-cluster frequency and `H` is the binary entropy. The feature sum ranges over features **present in the cluster**, NOT all of F (an all-F sum forces k = 1 and would decide the clustering by accident). The DL is maintained **incrementally**: only the merged cluster's term is recomputed per merge, so the cut search is O(N·F̄·log N) on top of the O(N²) linkage. A naive full re-encode per cut is a defect.
Clusters smaller than `roles.minClusterSize` (3) are dropped and their members fall back to `_all`.

### 8.4 Medoids and the single classifier
Medoid = member minimizing summed distance within the cluster (tie: stable_id). The **final assignment of every scope — and every later classification, in build, `explain`, and hooks — uses the same own-features-only nearest-medoid rule**: one metric, one classifier, computable identically with and without the index, so build and hook can never disagree on the same content. One pass, final by definition. A scope whose best membership is 0 receives no role.

### 8.5 Membership & ambiguity
`m1 = max_k jaccard(F(s), F(medoid_k))`, `m2` = the best membership among medoids that are a **genuinely different role**. Ambiguous iff `m1 − m2 < roleAmbiguityGap ∨ m1 < roleMinMembership`.

**Clone-aware runner-up (binding).** A medoid whose own feature bag has Jaccard ≥ `roles.cloneMedoidJaccard` (0.6) with the winning medoid MUST be skipped when computing `m2`. Rationale: the MDL cut can leave two surviving clusters of the *same* latent role — near-identical medoids differing by an incidental token — and a naive second-best then reports a near-zero gap for every member of that role. That is ambiguity manufactured by the clustering, not by the code: the scope is not torn between two meanings, it matches one meaning twice. Since ambiguity is silence (I5), the artifact silences precisely the best-established roles. The gap test is meaningful only against a rival *reading* of the scope, so the runner-up search MUST range over rival readings only. Measured: six identical classes flipped from all-ambiguous to a stable role assignment on this change alone, with no loosening of `roleAmbiguityGap`. Ambiguous scopes: counted in role cells at weight `w(s,q) · 0.5` (rank-1 only, no rank-2 contribution), **silent in hooks for role conventions**; `_all` still applies. Weight-index table (binding): role-cell counts use `w(s,q)·(ambiguous ? 0.5 : 1)`; `_all` counts use `w(s,q)`; file-role plurality (§8.9b) uses `w_base`; trends use the provenance factor only (§9.5); `agentShare` uses `w_base`.

### 8.6 STICKY ROLES (requirement, not optimization)
**The verdict function MUST resolve a scope's role from the snapshot's `assignments` map when the scope is known (key `relPath#kind#name` plus the §6.4 occurrence ordinal), and MUST classify by features only when it is not.** A scope indexed as ambiguous stays ambiguous (its stored value is the ambiguity marker) and gets no role speech.

Rationale, discovered by the prototype and non-obvious: a deviation that removes a role-defining marker — stripping `@Controller`, dropping `extends CanActivate` — also removes the scope's *membership evidence*. Pure feature-based re-classification lets the deviating scope **escape the role**, silencing exactly the message that should fire. Sticky roles say the true thing: *you were a guard yesterday; today you dropped `CanActivate` — that IS the deviation.* **Measured effect: planted-deviation detection rose from 50 % to 93 % on this change alone** (historical figure, measured on the earlier operator generation before §22.4's harness disciplines; the same change is inside today's 65-detection baseline). Role stickiness is bounded by the index's freshness, which is exactly the right bound: a scope genuinely re-purposed since the last index is re-classified at the next build.

### 8.7 Consequence for silence
Ambiguity remains the per-scope backstop (I5), and it is the dominant silence mechanism in practice. Role-conditioned speech is *thin* on real repositories; `_all` carries most enforceable mass. This is a stated, measured property, not a defect: the product degrades to a strong global-conventions engine when the role layer underperforms.

### 8.8 Role identity — content-derived per build
`role_key = sha256(sorted member stable_ids of the final assignment)[:12]`. No cross-build inheritance (deterministic per I2a). **Defining feature groups** of a role (for §7.3 overlap and §8.9): the top-3-lift feature groups of the cluster, recorded per role in the snapshot. **Label** (display only): the medoid's first 3 `tok:`/`dec:`/`sup:` features joined with `+` (e.g. `guard+CanActivate+Injectable`), else `group`. `report` prints a best-effort old→new continuity note for humans; nothing machine-consumed uses it. Telemetry and the ledger key on (stable_id, surface), never on role_key.

### 8.9 Scope classification (build and hook — one rule)
**(a) method/type:** sticky (§8.6) if known, else own-features-only nearest medoid.
**(b) file:** a file scope's role = plurality role of its `method`/`type` members, at build from the index, at hook time from the same post-edit parse — the same rule in both places; ties broken by ascending lexicographic `role_key`; no members ⇒ no role. File scopes are never role-ambiguous.

### 8.10 Role quality — `role_lift`
Held-out set = behavior surfaces **excluding** those whose overlap group is among the role's defining feature groups (§7.3 — without this exclusion, decorator/supertype surfaces that mirror clustering features inflate the metric).
`role_lift(r) = Σ_q [ DL_partition(q on members(r)) − DL_role(q on members(r)) ] / n_eff(r)` — computed from the same counts as §9.4 in one pass.
`role_lift ≤ 0` ⇒ the role is **decorative**: it contributes no conventions and no shadows; its members fall back to `_all` exactly like `_untyped` members. (Shadowing by a role whose whole premise failed would silence `_all` and leave members with nothing.) This is a model-level, deterministic demotion, distinct from §18.2's local one.

---

## 9. Norm model — v5's statistical core, restated verbatim in substance

### 9.1 Instance weights — per (scope, surface)
Clock `now` = HEAD committer ts. With lifecycle row L (scope-level from §13.3; file-level row as fallback):
```
stable_days = max(0, (now − L.last_modified_ts)/86400);  age_days = max(0, (now − L.first_seen_ts)/86400)
w_surv  = min(1, stable_days/survivalFullDays) × (age_days < freshPenaltyDays ? 0.5 : 1)
w_prov  = L.author_kind=='human' ? 1.0 : agentBase + (1−agentBase)·min(1, stable_days/agentPromoteDays)
w_churn = L.churned_early ? 0.25 : 1.0
base(s) = no lifecycle row ? noLifecycleWeight
        : scope dirty in working tree ? dirtyWeight
        : max(baseFloor, w_surv·w_prov·w_churn)
w(s,q)  = ledgerMarked(s,q) ? min(base(s), hookShapedWeight) : base(s)     // cap applied LAST — degraded modes cannot bypass it
```

### 9.2 Seeds
Weight W contributes W pseudo-instances **only for the listed surfaces**, into rank-1 role cells and `_all`, capped at `seedCapFraction × n_eff_real` per cell (an empty cell stays empty — seeds nudge, they cannot conjure; §17.1). Excluded from displayed fractions, raw-count gates, `agentShare`, and trends. Messages append `(+seeded)`.

### 9.3 Posteriors — alphabets and smoothing
Per (role, surface): **booleans are a closed alphabet** {true,false}, K = 2, no escape. **Categoricals:** the alphabet is the **partition-observed value set V** — carried per surface in the snapshot's `alphabets` block (Appendix D), never inferred from a role cell's counts — plus escape: K = |V| + 1, `⊥ ⇔ observed value ∉ alphabet`. KT smoothing α = ½ throughout: `p̂(x) = (n_x + ½)/(n_eff + K/2)` (n_⊥ = 0; an in-alphabet value absent from the cell has n_v = 0 — numerically like ⊥ but NOT novel). `p̂_all` = the same posterior over the whole partition and kind. Product policy for ⊥: WARN-max + novelty note (§9.7).

### 9.4 Convention acceptance — one baseline, one comparison

**(a) Role-conditioned** (r ∉ {`_all`}), candidate (r, q), weighted role counts n_v (n_eff = Σ):
```
data_term  = Σ_v n_v · log2( p̂_r(v) / p̂_all(v) )        // code length saved ON r's OWN instances
param_cost = 0.5·(K−1)·log2(max(n_eff, 2))
index_cost = log2(C₂)
bits_saved = data_term − param_cost − index_cost
ACCEPT ⇔ bits_saved ≥ acceptMarginBits ∧ n_raw ≥ minInstancesRaw ∧ n_eff ≥ minInstancesEff
```
`n_raw` = real instances in the cell (seeds excluded). **C** = the number of (cell, surface) candidate pairs surviving `appliesKind` ∧ overlap-tautology ∧ `minInstancesRaw`, counted **once, repo-wide, before any scoring, never recomputed within a build**; `C₂` = C rounded up to the next power of two (flicker damping); `log2(C₂) = ⌈log2 C⌉` is recorded in the header as `candidateCountLog2`. **Ranking and the `factCap` cull use `data_term / n_eff`** (bits per instance — n-stable strength); `bits_saved` is accept/reject only.
The **partition posterior `p̂_all` is the baseline** — not leave-role-out (a role that is most of its partition would be graded against a near-empty remainder), and not uniform. Both candidate types are thereby scored on the same footing. Single-role partitions degrade gracefully: p̂_r ≈ p̂_all ⇒ data_term ≈ 0 ⇒ role candidates rejected, `_all` stands. `data_term` can be negative (a plug-in estimate — the difference of two KL terms — which is exactly why `param_cost` is charged explicitly); negative simply rejects.

**(b) Partition-global** (`_all`, q): baseline = uniform over `B = max(|V|, 2)` values — booleans always B = 2 (closed alphabet). The floor matters: with B = |V| literally, an all-true boolean has |V| = 1 and data_term < 0 — the repo's most perfectly-followed conventions would be the only unmineable ones. Escape stays out of the baseline (including ⊥ hands every surface log2(K/B) free bits per instance — verified to accept a 50/50 coin flip at n = 55):
```
data_term = Σ_v n_v · log2( p̂_all(v) · B );   bits_saved = data_term − param_cost − index_cost;   ACCEPT as in (a)
```

**(c) Directionality & hook eligibility.** `expected = argmax_v n_v` (weighted). Hook-eligible iff ALL of:
1. **Fallback buckets are never eligible as `expected`.** The values `other`, `none`, `mixed`, and the unknown-shape marker `?` are unclassified-buckets; a fact whose argmax is one of them is a distributional fact, report-only. (Empirically load-bearing: a real repo yields `file_name_style=other` at share 0.81, which would otherwise instruct an agent to "name files in the *other* style".)
2. **Placement is group-only.** E7 (`auto.dir*`) surfaces are eligible **only** on role cells — never on `_all`, and never on a directory context, where a cell defined by a path predicting that same path is a pure tautology (§9.4i). A partition-level "expected directory" merely encodes the directory size distribution; measured, `dir_top=test` at share 0.84 would instruct moving production files into tests. Role-conditioned placement — "types shaped like *-util live under `utils/`" — is where the value is and is unaffected.
3. **Fire-ability (exact, per convention, no config key):** `(n_expected + ½)/(n_runnerup + ½) ≥ 2^τ_c`, where n_runnerup = the largest non-expected weighted count in the cell. This is the finite-n condition for Δ against the *most common* deviation to reach τ. No eligible convention can be mute against the deviation that actually occurs (rarer values pass a fortiori).
4. **Display honesty:** the **survived raw share** ≥ `eligibilityMinRawShare` (2/3), where the survived raw population = real instances (seeds excluded), `age_days ≥ freshPenaltyDays`, and not unreleased `hook_shaped`. **Degenerate case (binding):** a fact whose survived population holds fewer than `minInstancesRaw` instances is **not hook-eligible** — 0/0 is never evaluated, a young repo is silent until instances survive the fresh window, and with no git history at all every instance counts as unsurvived, so the whole hook surface is ineligible; `status` reports "K conventions withheld: no established instances yet" (the J4 explanation). This population — not the full raw count — is what §11.1 displays, phrased "established {units}". Three consequences, each deliberate: (i) the displayed evidence always supports the instruction; (ii) a burst of fresh deviations cannot mute the *display* gate (gate 3 still sees fresh weight floored at `baseFloor`, so an extreme burst — order 100 fresh deviants against 10 conformers — can mute: bounded, not impossible); (iii) evidence manufactured by roots itself neither appears in the display nor props up eligibility.
Acceptance is memoryless; near-margin flicker is visible in `explain` and damped by C₂ quantization and the weight floor.

**(d) The vacuous filter (P1 made literal — emergent-space requirement).** A boolean `_all` fact whose `expected` is `false` and whose complement value has **zero raw instances in the partition** MUST be rejected. "Methods here never call `X`" is not a convention when nothing in the partition has ever called `X` — the partition never voted; the fact is an artifact of the vocabulary reaching across a partition boundary. **Measured: this filter alone cut a generated-SDK partition's eligible set from 117 to 7.** Per-partition vocabularies (§7.2) remove most of the class; the filter removes the rest.

**(e) Correlation dedup — one latent fact, one message (load-bearing, not cosmetic).** Accepted conventions within the same cell whose **conform sets** have Jaccard ≥ `mdl.dedupJaccard` (0.9) describe one latent fact through different surfaces. Cluster them: iterate accepted conventions in descending bits-per-instance and assign each to the first existing cluster whose lead's conform set it matches, else start a new cluster. The **lead** — highest bits-per-instance, ties by `surface asc` (**fixed**) — becomes the **FACT**; the rest are recorded as `nSurfaces` and shown only in `explain`. Without this, one latent fact spawns 2–93 surface predicates. **Measured compression 3.5–58×; 339 eligible conventions → 42 FACTs on one repo, 486 → 80 on another.** Speech, coverage, debt, campaigns and telemetry all key on FACTs.

**(f) Absence facts get a stricter τ, in two tiers.** A boolean fact with `expected = false` is an **absence fact** — it reads to an agent as a prohibition ("never call X", "do not import Y"). In the emergent space the 0.85–0.92 share band produces weak style negatives that clear τ = 2.5 but make poor speech. Absence facts therefore use a raised τ in **both** the fire-ability gate (§9.4c.3) and the verdict (§9.7), and render with the prohibition phrasing of the verbalizer (§11.2). Presence and categorical facts keep τ = 2.5.

The raised τ is **tiered by what is absent**:
- **Vocabulary absence** — `auto.call:`, `auto.deco:`, `auto.imp:`, `auto.extends:` — uses `thresholds.absenceGapBits` (3.5, boolean boundary share ≈ 0.9188, Appendix E.2). The absent thing is a *token the repository itself supplied*: the vocabulary is support-pruned from this partition's own code (§7.2), so the hypothesis family is small and every member is something the repo demonstrably uses somewhere.
- **Structural absence** — `auto.has:<nodeType>` and `auto.stshape:<shape>` — uses `thresholds.absenceGapBitsStructural` (4.5, boolean boundary share ≈ 0.958). Here the absent thing is a *node type or subtree shape of the grammar*, and the hypothesis family is vastly larger: every statement, expression, declaration and clause type the grammar defines, crossed with every serialized shape, is a candidate prohibition against every cell. The multiple-comparison control of §9.4a prices candidate count but not the *speech quality* of a marginal negative in a family this size, and the measured result at 3.5 was spam: a "methods here never contain an `if_statement`" directory fact at 94.8 % share, carrying **39 standing deviants**, entered the verdict path — an assertion about the absence of a control-flow primitive, which is a description of a sample rather than a convention anyone holds. At 4.5 it is correctly rejected while vocabulary absences of comparable share continue to speak.
Both tiers are pure gate changes: nothing about acceptance, dedup or governance differs, and a structural absence that genuinely reaches 0.958+ still speaks.

**(g) Stability.** `stabilityDays` = days since the start of the earliest consecutive trend window (counting back from the latest) in which `expected` was already the plurality; absent trends ⇒ omitted from messages. Stored in the snapshot.

**(h) Cull.** After (a)–(f), keep the top `mdl.factCap` FACTs per partition by bits-per-instance.

**(i) Directory contexts — a third cell class between the role and `_all` (prototype-led, normative).** Roles are *semantic* sub-communities; a repository also has *spatial* ones. A **directory context** cell `d[<dir>]:<kind>` collects every scope of that kind whose path lies under `<dir>`, for every ancestor directory holding at least `mdl.dirContextMinScopes` (25) scopes of the kind **and strictly fewer than the whole partition** — the second half of the test is what makes it a proper sub-community rather than a rename of `_all`. Directory cells are scored by (a)'s conditional criterion against the same partition posterior `p̂_all` and pass every gate in (c)–(f) unchanged, with two exceptions that follow from what a directory is: **E7 placement surfaces are barred from directory cells as well as from `_all`** (a directory context "predicting" its own path segment is a tautology, not a convention — §9.4c.2 is thereby *directory-and-`_all`*-only, role cells excepted), and directory cells never contribute role features, shadows, or `role_lift`.
**Measured, not projected.** Directory contexts find real spatial sub-communities that the role layer and `_all` both miss: on immich, `server/src/schema/` carries a local `@Table` default that *inverts* the package-wide default; on starlette, the `starlette/` package never uses `@pytest.fixture` — the library/test boundary discovered as a local absence; on flask, `src/` never uses `@app.route` (the framework does not call its own decorator). Each accepted role- or directory-conditioned FACT additionally records `parentExp` — the enclosing partition cell's argmax for the same surface. When `parentExp ≠ expected`, the message appends one locality sentence ("this is the local default of this directory / of this group — the wider package's norm differs here"), which is the whole point of a local context: an agent told *"files here import X"* must be able to tell a package-wide law from a neighbourhood habit. Directory FACTs are labelled `local (<dir>/)`; unshadowed partition FACTs are labelled `repo-wide` only in the `_repo` partition and `package-wide (<partition>)` otherwise.
**Redundant-refinement pruning (binding, applied before §9.4e's dedup).** A directory context earns its place only by saying something the wider context does not, so two classes of directory FACT are dropped at acceptance: (1) `expected == parentExp` **and** an accepted `_all` FACT already states that (kind, surface, expected) — the directory would merely re-say the general rule under a narrower label; (2) a *deeper* directory restating a (kind, surface, expected) already kept for an ancestor directory — shallowest wins, so one neighbourhood speaks per local norm instead of every directory on the path. Both are pure de-duplication of speech: they remove no information, since the surviving wider or shallower FACT still governs the same scopes under §9.10.

### 9.5 Trends — over the whole history
Windows: consecutive windows of `trend.windowDays` days ending at the clock, at most `trend.maxWindows` (24), reported as the last `trend.windowCount` (8). From value events (§13.3 — **introductions and changes**), `value_of(s, t)` = s's value at t, taken as the last event with `ts ≤ t`. Per window W_i: `share_i(v) = Σ_{s existed at end(W_i)} prov_i(s)·[value_of(s,end(W_i)) = v] / Σ prov_i(s)` where `prov_i(s)` = 1.0 for a human-authored value, else `agentBase + (1−agentBase)·min(1, ((end(W_i) − event_ts)/86400)/agentPromoteDays)` — window-relative, so history does not shift as `now` advances. Windows with < `trend.lowSampleMin` instances are excluded from slopes. Slope = OLS over shares, fraction units per quarter. **Attractor** = `argmax share_last(v) + attractorSlopeK·slope(v)` — **REPORT-ONLY**; see Appendix E.5 for why enforcing it is structurally impossible, not merely disabled.

**Cohort trends (new, full-history only).** Per FACT, conformity share grouped by the **birth year of the scope** (`L.first_seen_ts`). This shows convention emergence and wobble across a repository's lifetime in a way that windowed trends cannot — measured example: an `assert_statement` role convention at 92% (2018) → 100% (2020) → 60% (2022) → 100% (2024). Report-only; cohort trends never modulate speech.

### 9.6 Nucleation — stand-down only
A minority value v of an accepted FACT is nucleating when over the last `nucleation.minWindows` non-low-sample windows: slope(v) ≥ `minSlopePerQuarter` ∧ v's instances were authored (introduction or change events) by ≥ `minHumanAuthors` **distinct human** author-hashes ∧ v ≠ expected. Effect: `suppressed_value = v` — the verdict skips deviations whose observed value is v. Report prints "transition in progress". Nucleation never changes `expected`; when v's weighted stock overtakes, argmax flips naturally.

### 9.7 Severity — preference gap
`Δ = log2(p̂(expected)/p̂(observed))`; fire iff `Δ ≥ τ_c` (calibrated per §14, else `preferenceGapBits`, or the absence tier of §9.4f — `absenceGapBits` for vocabulary absence, `absenceGapBitsStructural` for structural absence). Unseen categorical value (priced via ⊥): message carries a novelty note and severity is **capped at WARN** — a never-seen value is never denied (P1 humility; also bounds ⊥-surprisal's log2(2n+1) growth from ever reaching DENY).

### 9.8 (reserved — merged into 9.7)

### 9.9 DENY eligibility
ALL of: calibrated `WilsonLB95 ≥ denyMinPrecision` over ≥ `minEventsDeny` events (§14); `Δ ≥ τ_c + denyExtraBits`; observed value ∈ alphabet (never ⊥); **structural reach** — the surface is cross-file by construction (E7 placement, E8 imports, E9 supertypes) **or** the scope's coupling percentile ≥ `couplingPercentileForDeny`; and the daemon is available (§12.6). Coupling of a scope with no index edges (new/moved file) falls back to its alias predecessor's percentile, else the median percentile of its module; a module absent from `couplingByModule` leaves the gate unmet and the finding stays WARN. Otherwise WARN. **DENY availability is expected to be rare** (the calibration bar is high by design; measured, no fact on any test repo reached it) and `status` states it explicitly; the audited alternative is `seed --arch`, which substitutes maintainer judgment for calibration on the named surfaces.

### 9.10 The verdict function (single source of truth)
```
function evaluate(scope, postEditFileCtx, channel): Message[] {
  role = stickyRole(scope) ?? classify(scope, postEditFileCtx)     // §8.6/§8.9 — STICKY FIRST
  out = []
  for f in candidateFacts(scope, role) in (roleKey asc, surface asc) order:   // deterministic INPUT order;
                                                        // all ordering/truncation of OUTPUT is §11.3's alone
    // candidateFacts: appliesKind(f) == scope.kind; scope ∈ domain(f.surface); SPECIFICITY GOVERNANCE —
    //   at most ONE fact governs a scope per surface: the applicable fact with the smallest evidence class
    //   (fewest survived-raw instances), ties broken role < directory < `_all`. Applicability: role FACTs of
    //   `role` only, and the role contributes NOTHING (no facts, no shadows) when it is ambiguous for this
    //   scope, untyped, or decorative (§8.10); directory FACTs `d[<dir>]` whose <dir> is an ancestor of the
    //   scope's path (§9.4i); `_all` FACTs always. A more specific context therefore SHADOWS the wider one
    //   on that surface, and a scope with no role and no directory context is governed by `_all` alone (I5).
    v = surfaceValue(scope, f.surface, postEditFileCtx)
    closeIntervention(scope, f, v)                       // COMPLIANCE CLOSURE — below; runs BEFORE any skip
    if !f.hookEligible: continue                         // §9.4c ∧ §9.4d ∧ §8.10 ∧ §14 (model-level, in snapshot)
    if locallyDemoted(f): continue                       // §18.2 demotions.json (I2b)
    if v == null or v == f.expected: continue
    if v == f.suppressedValue: continue                  // §9.6 nucleation stand-down
    Δ = log2(p̂_f(f.expected)/p̂_f(v))                    // posteriors from snapshot counts + alphabets (App D)
    if Δ < τ(f): continue                                // τ = calibrated, else §9.4f's tier: structural / vocabulary
                                                         //     absence, else preferenceGapBits
    sev = denyEligible(f, scope, Δ, v) ? DENY : WARN
    sev = channelFilter(channel, sev)                    // table below; null ⇒ skip
    if sev == null: continue
    out.push(render(sev, f, Δ, exemplars(f)))            // §11.1 — the exemplar contrast IS the witness (§10)
  return applyBudgetsAndDedup(out)                       // §11.3
}
```
**Channel table (complete):** `pre` → DENY passes, WARN dropped (never raised pre-tool). `post`, `bash`, `stop`, `generic` → WARN passes; DENY is **downgraded to WARN** with the note "(blocking unavailable on this path)" (I2b: downgrade or silence, never upgrade — this covers Bash-path violations, stale/daemon-less operation, and the campaign oracle, whose `zero findings` acceptance counts downgraded findings as findings).

**Compliance closure (`closeIntervention` — the step that makes §18 real).** Fold the session/telemetry log for an open intervention on `(stable_id, surface)`. If one exists and `v == f.expected`: append `observedAfter: complied` to `telemetry.jsonl` **and** the `{stable_id, surface, date}` mark to `hook-ledger.jsonl` (§18.3). If one exists and `v` still deviates: append `observedAfter: ignored` — **at most once per session per intervention** (the open record carries the session that would close it; a re-view inside the same session is not a fresh ignore). Without this bound, repeated checks of the same unfixed scope in one session — a scan, a sweep, an agent re-reading before editing — inflate the `ignored` denominator and can demote a healthy FACT within minutes (prototype-observed: the mutation harness's own re-checks demoted a 96%-share convention mid-run before the bound existed). Closure emits no message and is exempt from §11.3 budgets. **Without this step no compliance is ever recorded, nothing demotes, and the ledger regulator never engages — it is load-bearing, not instrumentation garnish.** Prototype-verified as a closed loop: deviation → WARN → agent fixes → re-check is silent, one `complied` telemetry line and one ledger mark appear (Appendix H.4).

The runner evaluates changed method scopes, their enclosing types, and the file scope (deduplicated).

### 9.11 Exemplars — non-ambiguous members only (requirement)
Members with observed == expected, **filtered to non-ambiguous role members** (falling back to all conformers only if none is unambiguous), ranked by `w(s,q)·m1·centrality` (in-degree normalized; ties by stable_id), top-3 rendered as `path:line#name`; re-validated at render (reaped scopes never render). The non-ambiguity requirement is normative for two reasons: the exemplar is what the agent is shown *as the pattern to copy*, and an ambiguous member is by definition a poor representative of the group being described.

---

## 10. Witness — the agent is the witness

### 10.1 Agent-as-witness (replaces v5's transform registry)
`roots` does not edit code (I8). The **witness** for a deviation is the exemplar contrast delivered to the consuming agent: the FACT's verbalized phrase, the survived-raw evidence, the deviating value, and up to three real exemplars with `path:line#name`. The agent — which is already writing the code — synthesizes the conforming edit.

*Replaced by better, with the reason stated:* v5 required a hand-registered transform per (surface, expected) pair, and a convention with no transform was permanently mute regardless of how strong its evidence was ("observation tier"). In an emergent feature space that rule is unimplementable — surfaces are generated, so a registry can never cover them — and it was never desirable: the agent generalizes from an exemplar far better than a fixed refactor generalizes across repositories. Consequences, stated honestly:
- **Widened speech.** Every accepted, hook-eligible FACT can speak. v5's `speakable` predicate collapses to `hookEligible`, and §16.2's coverage/debt are computed over hook-eligible FACTs.
- **No safety ladder.** v5 ranked transforms by SYNTACTIC < WITH_TYPES < BEHAVIORAL_RISK and refused to speak above WITH_TYPES. v6 has no mechanical edit to be risky, so the ladder is retired; the equivalent restraint lives in the acceptance and eligibility gates, which decide whether roots has anything true to say.
- **Message quality is now the product's job.** §11.2's verbalizer replaces the transform's `describe()`.

### 10.2 Optional recognizer pack (UX layer, never a gate)
A **recognizer** is a small, optional rule: `{ id, matches(fact) → boolean, namedFix(fact, scope) → string }`. When a recognizer matches, the message appends one imperative sentence naming the canonical fix ("add the `@Injectable()` decorator above the class"). Recognizers MUST NOT affect acceptance, eligibility, severity, coverage, debt, or campaigns — a recognizer that changes a verdict is a defect. Ship none in Phase 1; add them from real message-quality telemetry. Appendix C carries the interface and the seed set.

---

## 11. Messaging

### 11.1 Template (T1; full catalog Appendix A)
```
[roots] {ROLE_LABEL|repo-wide} convention: {VERBALIZED_PHRASE}
{n_conform}/{n_total} established {unit_plural} conform{hook_shaped_note}{seed_note}{stability_note}.
Your {scope_kind} `{scope_name}` {deviation_phrase}{novelty_note}.
See: {p1}:{l1} `{n1}` · {p2}:{l2} `{n2}` · {p3}:{l3} `{n3}`
{named_fix_line?}
```
`{n_conform}/{n_total}` = the **survived raw population** of §9.4c ("established" = in the repo ≥ freshPenaltyDays, not seeded, not unreleased hook_shaped) — by that gate these always support the instruction. `{unit_plural}` from appliesKind: methods/types/files/directories. `{hook_shaped_note}` = " (N hook-shaped excluded from evidence)" when any conformer is ledger-marked — the product tells the agent when part of the stock is its own echo. `{stability_note}` = " (stable for {n} months)" from `stabilityDays`, omitted when absent. `{novelty_note}` = " (a value this repo has not used before)" for ⊥-priced values. `{seed_note}` = " (+seeded)". `{named_fix_line}` appears only when a recognizer matched (§10.2). No transition text renders in hooks (T3 is report-only).

**Real rendered messages (prototype output).** The prototype renders the first three lines of T1 and the label vocabulary; `{unit_plural}`, `{stability_note}`, `{seed_note}` and `{named_fix_line}` are production additions (Appendix F, T1 row), so its second line reads "established conform" and its deviation phrase is the generic "deviates":
```
[roots] guard+CanActivate+Injectable convention: types here extend `CanActivate`
10/10 established conform. Your type `RolesGuard` deviates.
See: integration/.../guards/auth.guard.ts:6 `AuthGuard` · common/guards/roles.guard.ts:5 `RolesGuard`
```
```
[roots] asset+table+Table convention: types here are annotated with `@Table`
```
```
[roots] repo-wide convention: types here have names like `BaseModule`, `ApiModule`, `MaintenanceModule`
```
A directory-context FACT (§9.4i) renders with the `local (<dir>/)` label and appends the locality line verbatim: `This is the local default of this directory — the wider package's norm differs here.` (Measured: the directory-context path — cells, redundant-refinement pruning, governance and this contrast line — is inside the H.4 harness numbers.)

### 11.2 The verbalizer — one generic phrase per enumerator
Because surfaces are generated, phrasing MUST be generated too. `verbalize(fact)` is a total function of (enumerator, token, expected value, unit plural, exemplar names). The complete mapping (binding; Appendix B repeats it per row):

| Surface | expected = true / value | expected = false |
|---|---|---|
| `auto.has:<t>` | `{units} here always contain a \`{t}\`` | `{units} here never contain a \`{t}\`` |
| `auto.call:<c>` | `{units} here call \`{c}\`` | `{units} here never call \`{c}\`` |
| `auto.deco:@{d}` | `{units} here are annotated with \`@{d}\`` | `{units} here are not annotated with \`@{d}\`` |
| `auto.imp:{s}` | `{units} here import \`{s}\`` | `{units} here do not import \`{s}\`` |
| `auto.extends:{T}` | `{units} here extend \`{T}\`` | `{units} here do not extend \`{T}\`` |
| `auto.stshape:{sh}` | `{units} here use the structure \`{sh}\`` (truncated to 60 chars) | `{units} here never use the structure \`{sh}\`` |
| `auto.nameshape` / `auto.filenameshape` | `{units} here have names like \`{e1}\`, \`{e2}\`, \`{e3}\`` — **named by example, never by the raw shape string**, because `(Ua)+` is not human speech | — |
| `auto.first1` | `{units} here start with a \`{value}\`` | — |
| `auto.ret` | `{units} here return a \`{value}\`` | — |
| `auto.arity` | `{units} here take {value} parameter(s)` | — |
| `auto.varshape` | `{units} here name local variables like \`{value}\`` | — |
| `auto.dir{n}` | `{units} here live under \`{value}/\`` | — |
| `auto.mod*` | `directories here: {dimension} = \`{value}\`` | — |
Unknown surface ⇒ `{surface} = {value}` (a lint failure in CI, not a runtime error: every enumerator MUST have a row).
The `{deviation_phrase}` is the negation of the same row ("does not", "deviates", or "is `<observed>`" for categoricals).

### 11.3 Dedup & budgets (the one ordering/truncation authority)
Dedup key `(stable_id, surface, direction)` where direction = the `(expected, observed)` pair — **WARN-tier only, once per session**. **DENY findings are never deduplicated**: a block a retry defeats is not a block; repeated denies are naturally rate-limited because the denied edit never lands. Dedup and budgets read the **post-`channelFilter`** severity: a DENY downgraded to WARN on a non-pre channel is a WARN for both purposes. Per response ≤ `maxMessagesPerResponse` (3), ordered (severity desc, Δ desc, surface asc). Per session ≤ `sessionMaxWarnings` (12) WARNs; then DENY only. Enforced from the session event log; overshoot bounded by concurrently in-flight hook processes (documented).

### 11.4 Session state — append-only
`sessions/<id>.jsonl`, O_APPEND, one event per line; state = fold. Session id: sha256 of payload `session_id` when present; fallback `sha256(ppid ∥ cwd ∥ ppid-start-time)[:12]` (ppid start from `/proc/<pid>/stat` on Linux, `ps -o lstart=` elsewhere; last resort ppid∥cwd∥UTC-day — permissible, session identity is I2b local state; only the model path bans wall clock). Prune at mtime > `sessions.pruneDays`.

---

## 12. Hook runtime — unchanged by emergence; restated in full

Nothing in §12 is affected by the emergent pivot: the hook transports messages, and the messages' provenance is irrelevant to the transport. It is restated here because this document is self-contained.

### 12.1 Entries
`yg roots check --hook <claude-pre|claude-post|claude-bash|claude-stop|generic>`; `yg roots daemon start|stop|status`.

### 12.2 Claude Code protocol
Installed by `init` after showing the exact JSON, into `.claude/settings.local.json` (default) or `settings.json` (`--commit-hooks`); the local-vs-committed asymmetry is stated at install (teammates/CI unhooked until they init — the committed ledger still regulates the model everywhere). The PostToolUse Edit/Write entry installs iff `hooks.claudeCode.postTool`, the Bash entry iff `hooks.claudeCode.bash`. Commands are absolute invocations recorded at init; `doctor` probe-executes every installed hook (a silent ENOENT fail-open is the worst failure mode).
```jsonc
{ "hooks": {
  "PreToolUse":  [{ "matcher": "Edit|Write", "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-pre", "timeout": 5 }] }],   // ONLY when hooks.claudeCode.preTool=true (daemon phase)
  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-post", "timeout": 10 }] },
                  { "matcher": "Bash",       "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-bash", "timeout": 10 }] }],
  "Stop":        [{ "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-stop", "timeout": 10 }] }] } }
```
- `claude-pre` (DENY only): **first** probes the daemon socket; on failure exits 0 immediately (no parsing, no model load — a pre hook that cannot deny must cost nothing). With the daemon: reconstruct post-state (Write: content; Edit: apply old→new honoring `replace_all`, abort to fail-open on absent/non-unique `old_string`); DENY ⇒ `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason": MSG}}`.
- `claude-post`: reads the file from disk. Findings ⇒ `{"decision":"block","reason": MSG}`; else silent.
- `claude-bash`: §12.4. `claude-stop`: honors `stop_hook_active`; completeness (Appendix G.4) once per session; runs the deferred sweep summary (§12.4).
- `generic`: request `{files:[{path,newContent}], sessionId?, channel?}` (channel defaults to `generic`) → response `{verdicts:[{path, scopeKind, scopeName, line, surface, expected, observed, severity, deltaBits, message}]}` — the campaign oracle and the exact-JSON fixture surface (§22.7). **Reconstruction ownership:** the short-lived hook process (which has the stdin payload and the on-disk content) performs all Edit reconstruction and transmits `newContent`; the daemon is a pure evaluator and never reads tool payloads.

### 12.3 Severity → channel
DENY ⇒ pre-tool deny (rare, daemon-backed). WARN ⇒ post-tool feedback (Edit/Write, Bash sweep, Stop summary). Report-only ⇒ never in hooks. The complete mapping, including downgrades, is §9.10's channel table.

### 12.4 Bash coverage — content hashes, seeded first, flood-safe
Session `fileState: {path → contentHash}`. **The first sweep seeds fileState from the paths listed by `git status --porcelain -uall` — never by hashing the whole tree — and emits nothing** (pre-existing dirt is not the session's doing); if the listing exceeds `bashFloodThreshold`, seeding truncates by path order and sets `seedTruncated`, which suppresses messages for unseeded paths for the whole session. Subsequent sweeps: debounce `bashSweepDebounceMs` (a skipped sweep needs no queue — the next sweep's hash diff subsumes it); porcelain listing → hash listed paths → diff against fileState; evaluate ≤ `bashSweepMaxFiles` changed code files, update fileState. > `bashFloodThreshold` changed in one sweep ⇒ skip per-file work and set `floodSkipped`. **The Stop summary runs iff `floodSkipped` was set**, evaluates the session diff against the **first-sweep** fileState once, and reports ≤ `maxMessagesPerResponse` top findings; with fileState unset (Edit-only session) it is a no-op. Bash-path violations are WARN-only — therefore file *moves* (`mv`, `git mv`) are structurally WARN-only; pre-tool blocking of moves would require a Bash command-parsing PreToolUse matcher, out of scope by decision.

### 12.5 Latency budgets (p95; CI gates on ratios vs baseline)
daemon ≤ `daemonBudgetMs` (50) · cold in-process ≤ `hookColdBudgetMs` (700) · bash sweep ≤ 1.5 s · hard deadline `hookHardTimeoutMs` (900) via cooperative checks between stages (parse → enumerate → role → verdict → format); sync work is uninterruptible, so the largest stage bounds overshoot.

### 12.6 Daemon (Phase 3; precondition for DENY)
Socket `.roots-cache/roots.sock` (Windows named pipe); preloads grammars, bindings and `model.json`; serves the generic protocol (with `channel`); idle exit `daemon.idleExitMinutes`; connect probe `daemon.connectTimeoutMs` (25 ms — a 5 ms probe fails intermittently on loaded machines and every probe timeout writes one incident, so a silently disarmed DENY is visible in `doctor`); stale socket unlinked on ECONNREFUSED; version handshake (mismatched rootsVersion/snapshot/bindingHash ⇒ CLI kills daemon, falls back). **The daemon watches HEAD (debounced `daemon.reindexDebounceSeconds`) and reindexes in the background, so DENY stays armed across commits; without a daemon the model goes stale at the first commit and stays stale until `index` runs — a stated limitation of daemon-less operation.** `preTool` flips on only when init detects a running daemon (or `--enable-pretool`). DENY findings while the daemon is unavailable surface post-tool as WARN (§9.10).

### 12.7 Staleness
Compares `(headSha, configHash, seedsHash, rootsVersion, bindingHash)` **only** — `ledgerHash` and `dirtyHash` are header provenance for I2a, NOT staleness inputs (the ledger grows by design mid-session; the tree is dirty by definition during editing; making either a staleness input would disarm DENY the moment the product works). Stale ⇒ hooks run on the stale model, DENY downgrades per I2b, `status` shows stale. Snapshot missing ⇒ silent allow + one incident.

---

## 13. History layer — the ENTIRE git history

### 13.1 The walk (no caps by default — owner directive)
One streaming `git log --reverse --raw --no-abbrev --no-merges -M --format=…` over **every commit in the repository's history**. v5's 24-month window and 4000-commit cap are **superseded**: `history.full` defaults to true and `maxCommits` defaults to 0 (uncapped). Windowing remains available for emergency use and is reported by `status` when active, because a truncated walk silently changes weights, trends and calibration.
Per commit: SHA, committer ts, author-hash (sha256 of name∥email), author kind (`agentIdentities` regexes vs author or Co-Authored-By trailers), fix classification (Appendix G.3), and A/M/D/R records with pre-image and post-image blob SHAs. Merge commits contribute timestamps only. `--follow` is forbidden in roots (rename tracking is `-M` on the walk, replayed in §13.3).

**Cost model (measured, honest).** Blob parsing dominates at **≈ 12 ms/blob**. Measured end-to-end: flask 3 824 commits / 4 118 distinct blobs in **53 s**; starlette 1 617 / 2 422 in **20–33 s**; fastify 4 417 / 6 426 in **43 s**. Extrapolation: a 100 000-commit repository is on the order of tens of minutes — **once**, then incremental via the blob cache (§13.2). `index` MUST print a progress line with an ETA derived from the blob count whenever the projected walk exceeds 60 s, and MUST support resumption (§6.6).

### 13.2 Blob AST cache — every distinct blob parsed exactly ONCE, ever
Blobs are read through a single `git cat-file --batch` child in chunks (400 SHAs per chunk in the prototype). Every **distinct blob SHA** appearing anywhere in history is parsed exactly once and its extracted scope records are stored content-addressed under `.roots-cache/blobs/<2-hex>.json`, keyed `sha256(blobSha ∥ extractorVersion ∥ bindingHash)`. Consequences: a re-index re-parses nothing; an extractor or grammar change invalidates the cache by key rather than by wholesale deletion; and vocabulary changes do **not** invalidate it, because stored records hold raw ingredients (decorators, supertypes, callees, node types, shapes, name) from which any vocabulary's surfaces are derived at join time.
**Language selection for a historical blob MUST come from the historical path's extension** recorded in the walk. Content sniffing is forbidden (the prototype's early sniffing heuristic is a known, corrected defect).
Blobs over `history.blobMaxBytes` are recorded as empty (skipped) rather than parsed.

### 13.3 Per-SCOPE lifecycle and VALUE EVENTS — replay with rename continuity
The walk is replayed in commit order, maintaining `prevState[path] → Map<scopeKey, record>`, where `scopeKey = kind#qualifiedName`. Rename records (`R`) move `prevState[old] → prevState[new]` and append to `aliases.json` before the new content is applied, so a renamed file's scopes keep their timelines.

Per (path, scopeKey) the replay produces a **scope-level lifecycle row**: `{first_seen, last_modified, modifications, churned_early (first modification ≤ churnEarlyDays after first_seen), fix_touches, author_kind (kind of the most recent non-merge touch), last_human_commit_ts}`. File-level rows are also maintained as the fallback for scopes the replay cannot resolve. **Measured scope-level coverage: 94–96 % of current scopes** (flask 1618/1714, starlette 1779/1862); the remainder falls back to file level.

**VALUE EVENTS** are emitted per (path, scopeKey): an **introduction event** at the scope's first appearance (author = that commit's author — without these, values adopted in new code are invisible and nucleation could only see retrofits), and a **change event** whenever the scope's value tuple differs from the previous blob's. The value tuple MUST carry at minimum `{nameshape, first-statement type, return shape, sorted decorator list, sorted supertype list}` and the change signature MUST include all of them (§6.5). Each event records `(commit_ts, value, author_hash, author_kind)`. Events feed trends (§9.5), cohort trends, nucleation (§9.6), and calibration (§14).
Guards: files over `lifecycleFileMaxKb` or with more than `lifecycleMaxAppearances` walk appearances stay file-level (I1 cost guard).

### 13.4 Weights from history
`mkWeightFn` composes §9.1 from the lifecycle rows, resolving a scope's row as `scope-level → file-level → none (noLifecycleWeight)`. The clock is the **HEAD committer timestamp**, full stop (I2a): neither the maximum `last_modified` observed in the replay — which coincides with it only when the newest touched scope happens to sit in the newest commit — nor wall-clock time may stand in for it. Measured consequence: a repeated learn of an unchanged repository is byte-identical (§20.2).
**The weights genuinely reshape the field, in both directions** — measured on a real repo: 15 facts under uniform weights vs 12 under full-history weights, with only 6 in common. Fresh-code conventions are discounted; churn-hidden ones surface. On a high-velocity repository the survived field can be genuinely thin (measured: one repo drops to 2 FACTs) — that is the survived norm being honestly thin there, and `status` says so rather than the product inventing conventions.

### 13.5 Co-change mining (all history)
Over all walked non-merge commits with ≥ 2 and ≤ `history.megaCommitFileCap` (30) changed files — the cap excludes mass refactors and lockfile sweeps that would couple everything to everything — every unordered file pair increments support; `confidence(a→b) = support(a,b)/commits(a)`. Persist pairs with `support ≥ cochange.minSupport` (8) ∧ max-direction confidence ≥ `cochange.minConfidence` (0.75), capped at `cochange.maxPairs` by descending support. `R` records remap old→new before counting. Co-change is repo-global (not per partition) and includes non-code files.
**Measured signal:** `starlette/routing.py ↔ tests/test_routing.py` support 54, confidence 0.75; `datastructures.py ↔ test_datastructures.py` support 41, confidence 0.91.

**Completeness check (Stop, once per session, mode `stop-feedback-once`):** D = files written this session (session log); E = `{b : ∃a∈D, confidence(a→b) ≥ minConfidence ∧ support ≥ minSupport} \ D \ deleted`; if E ≠ ∅ emit T5 listing ≤ `completeness.maxItems` (5) items with `{support}/{commits}` evidence.

---

## 14. Calibration

Purpose: per-FACT τ_c (may only **raise** the default) and the DENY precision gate. Where data is insufficient, defaults stand and DENY stays off (`status` says so). Measured reality check: on repositories of 1 600–4 400 commits, **no** FACT accumulated the ≥ 12 qualifying value events calibration needs — calibration is a mechanism for long-lived, high-churn conventions, and its correct behavior on ordinary repositories is to be *unavailable and say so*.

- **Split:** `c_split` = the first commit with `ts ≤ now − calib.horizonDays` on the first-parent chain from HEAD. History shorter than 2× horizon ⇒ **calibration unavailable** (never silently mis-split); `status` warns. Shallow clone ⇒ unavailable (§21.1).
- **Reference stats:** per current FACT, the posterior over instances existing at `c_split` with their values as of `c_split` (from value events; aliases resolved). FACTs failing acceptance on those past counts are skipped (no look-ahead). Scopes deleted since `c_split` are absent from current roles and thus excluded — a stated survivorship bias, acceptable because calibration only *tightens* thresholds.
- **Events:** value events in `(ts(c_split), now − settleDays]` on the FACT's surface where the new value ≠ expected, excluding `hook_shaped`-marked pairs (no calibrating on our own echo). `Δ_past` from reference stats.
- **Labels:** positive ⇔ a later event (≤ now) restores expected on the same stable_id (aliases followed); scope deleted ⇒ event excluded; else negative. A repair-rate proxy that undercounts precision on unrevisited code — which is exactly why calibration can only raise τ and why WARN does not require it.
- **Selection (Wilson z = 1.96, two-sided — fixed).** Grid = distinct observed Δ_past values ascending. τ_c = the smallest grid value ≥ default such that the **point-estimate** precision over events with Δ_past ≥ τ is ≥ `targetPrecision` **and** ≥ `minEventsConvention` events remain at that τ. **The point estimate — not a lower bound — selects τ:** WilsonLB95 at n = 12 is ≤ 0.758 even for a flawless 12/12, so a lower-bound rule would demote nearly every convention that accumulates evidence — *usage would cause muting*, inverting the section's purpose (Appendix E.7). **Demotion to report-only happens only on evidence of badness:** `WilsonUB95(precision) < targetPrecision` at every grid τ — the upper bound must exclude the target before a FACT is silenced; failure to *prove* goodness never demotes. Events < `minEventsConvention` ⇒ pool over the FACT's correlation cluster and then over the enumerator (same point-estimate rule, ≥ `minEventsFamily`); a pool with no qualifying τ **falls through to the default τ** — pooled evidence is too coarse to condemn a specific FACT. **DENY** alone uses the lower bound: WilsonLB95 ≥ `denyMinPrecision` over ≥ `minEventsDeny` (35 — the arithmetic floor: LB95 of a flawless record reaches 0.9 first at n = 35; one failure pushes the requirement to 53).
Deterministic (pure function of walk + events + current model); cost: one filtered pass over value events.

---

## 15. Feedforward

**`brief --path <p> [--intent "<t>"]`:** ≤ 40 lines — roles nearby, top-5 FACTs each (verbalized phrase, survived-raw fraction, transition note), 2 exemplars per role, active nucleations. `--intent` matching is a fixed token heuristic (intent tokens ∩ path tokens of co-change partners — no NL processing beyond tokenization); its quality is explicitly best-effort. Standalone or via `UserPromptSubmit` `additionalContext` when `hooks.claudeCode.userPromptBrief` is true.
**`scaffold --role <label|path> --name <Name>`:** rank-1 exemplar, bodies elided to `// TODO`; the exemplar's own name and its casing variants renamed to `<Name>` case-matched; conventional members kept. stdout only (I8).

---

## 16. Reporting & campaigns

### 16.1 `report [--json|--md]`
Header (partition, snapshot stamp, agentShare, history stats: commits / blobs / walk seconds) · coverage/debt (§16.2) with module breakdown + series · top-`report.topFacts` **hook-eligible** FACTs by bits/instance with survived-raw fractions, `nSurfaces` (dedup compression), trends sparkline, and exemplars · a separate **distributional facts** section (accepted but ineligible: minority-argmax, fallback-bucket and vacuous cases — empirically these dominate raw bpi rankings and MUST NOT crowd out actionable FACTs) · cohort trends per FACT · stock vs attractor, nucleation flags · role table with labels, sizes, `role_lift`, decorative flags, ambiguity rate · seeds + tensions · calibration summary (events, τ overrides, report-only demotions, DENY availability) · convention health (§18.2) · tautological- and vacuous-candidate counts · co-change top pairs.

### 16.2 Coverage & debt — over hook-eligible FACTs
Cell set: pairs (scope, enumerator) where the scope is a non-ambiguous method/type/file scope (modules excluded) **and** the enumerator produces ≥ 1 surface with `scope.kind ∈ applies ∧ scope ∈ domain` — without the applicability restriction, file-only enumerators counted against every method would deflate coverage by table shape rather than repo behavior. A cell is **governed** iff a hook-eligible FACT governs it under §9.10's specificity rule — via the scope's role, its directory context, or `_all` unshadowed. `coverage_role` = governed cells with role FACTs / all cells; `coverage_all` counts `_all` too. Headline = `coverage_role` — `_all` FACTs saturate `coverage_all` in any repo with one global norm (a chaotic repo shows `coverage_role ≈ 0`). `debt` = Σ Δ over deviant real instances of hook-eligible FACTs; reported total and **per instance** (the comparable number).

### 16.2b `spectrum <file> [--minbits N] [--top N] (solicited exploration — the full lattice, no acceptance cut)`

The acceptance gates protect **unsolicited speech**: a hook message interrupts an agent that asked for nothing, so precision is priced above recall and the margin/fire-ability/survived gates are non-negotiable there. `spectrum` answers the opposite situation — the user or agent *asks* "what is local and what is global in this file?" — and there the recall/precision trade inverts: the asker pays the noise cost knowingly, so the cut becomes a slider they hold, not a censor. For the file's applicable contexts only (its scopes' roles, every ancestor directory, partition `_all`), `spectrum` re-enumerates with a **deep vocabulary** (support floor 2, topK ×4 — recovering surfaces below §7.2's enumeration cut), computes **every** cell's continuous score (same KT/MDL data term against the parent posterior, same param and index costs — no margin, no fire-ability, no survived gate), and prints each row with its bits, share, population, a `NORM`/`obs` marker (whether the exact fact is in the accepted model) and a deviation flag for the file's own scopes, ordered role → deepest directory → … → `_all` so the local-to-global gradient reads top-down. Default filter `bits ≥ 0`, `--minbits`/`--top` widen or narrow at will. Uniform instance weights (exploration runs without the history join); `obs` rows are labeled observations, never conventions — a sub-gate row entering any hook path or export is a defect. **Measured:** flask `src/flask/json/tag.py` — 2 885 cells, 633 rows at bits ≥ 0, vs 17 accepted NORMs in the model; immich `server/src/schema/tables/activity.table.ts` — 4 493 cells, 900 rows at bits ≥ 0, vs 54 NORMs, the top of the spectrum being the table-role's sub-gate micro-ontology (`ForeignKeyColumn`/`CreateDateColumn` call vocabulary, field-definition shapes at share 0.5–0.94). The user's question "do I get only the 25 that passed, or can I get 200 more granular ones?" is answered structurally: the model stores the norms; the spectrum recomputes the whole field on demand.

### 16.2c `where <query>` (inverse query: intent → place + expectations + pattern to copy)

The cold-start question — *"where do command handlers go?"*, *"where do UI components live?"* — is the inverse of the hook's: from an intent to a location, its norms, and an exemplar, before any file is opened. `where` answers it from the model alone, with **no retrieval layer**: query tokens are matched lexically against the model's own vocabulary — role labels and medoid features, fact payloads (`deco:@CommandHandler` → `command`, `handler`), directory names — because feature bags are built from repo-native tokens, so the intent's words and the repo's words usually already meet. Each hit renders a **card**: where the group lives (member-directory histogram with shares), what is expected there (the group's facts, verbalized with evidence), the pattern to copy (exemplars, `path:line`), and what historically co-changes with that place. When no token matches, the fallback is the **compact map** (every group and governed directory, one line each — the whole thing is tens of rows): the asking agent is itself an LLM and closes the semantic gap over a printed map better than an embedding index would, with zero infrastructure. An embedding/RAG layer is explicitly the wrong tool here: the corpus is a small structured distillate, not a large unstructured one, and RAG retrieves *similar text* where this layer must answer *what is normative, with what evidence* — retrieval has no concept of share, deviants, or locality. **Measured:** nest `where guard` → group `guard+CanActivate` (10 members, placement histogram, "types here extend `CanActivate` — 100 % of 10", three `path:line` exemplars); immich `where database table` → directory `server/src/schema/tables/` with exemplars; flask `where view` → view-role groups with real co-change partners (`test_regression.py`, 10×). This is the query core of Phase 3's `brief`/`scaffold`; combined with the architecture graph (a node's declared intent) it gives the agent both voices at the start of a task: what was *decided* and what is *practiced*, without scanning siblings — the model already is their aggregate.

### 16.3 `campaign [--export tasks.jsonl]`
Backlog = deviant real instances of hook-eligible FACTs. Score = `Δ × (test_sibling ? 1.0 : 0.6) / (1 + log2(1 + coupling))` (**fixed** multipliers; v5's transform-safety tier multiplier is retired with the transform registry). Tasks ≤ 10 instances by (FACT, directory), ordered by Σ score. Export: `{taskId, factKey, conventionPhrase, expected, instances:[{path,line,scopeName,deltaBits}], exemplars, acceptance:"yg roots check --hook generic reports zero findings for these scopes"}`. Campaigns MAY target a nucleating value (`transition: true`, both directions costed); hooks remain stock-only.

---

## 17. Seeding & governance

**17.1 CLI:** `seed add <path[:line]|query> --surfaces <list>` (required; surface-scoped by design) `[--weight N (default weights.seedDefaultWeight)] [--arch] [--note]`; `seed list`; `seed rm <id>`. Limitation stated: seeds *bend* existing statistics (cap `seedCapFraction × n_eff_real`); they cannot create a convention where no real instances exist. Because surfaces are generated, `seed add` without `--surfaces` MUST print the scope's currently-mined surfaces with values and ask the maintainer to choose — guessing which surface a maintainer meant is not acceptable.
**17.2 `seeds.jsonl`:** `{seedId: sha256(scopeStableId∥author∥ts)[:16], scopeRef:{path, qualifiedName}, surfaces, weight, arch, note, author, createdAt}`.
**17.3 Resolution & tension:** resolve at build (unresolved ⇒ warning). Tension per **listed surface only**: `fc = P(fix_touches>0 | value=v) / P(fix_touches>0)` over role members; record when `fc ≥ seed_tension.minFc ∧ n ≥ seed_tension.minN`; stored in the snapshot's seed section; printed in report and at `seed add`. Fix-touch counts come from the full-history replay (§13.3), so tension is now computed over a repository's entire lifetime rather than a 24-month window.
**17.4 Audit:** every seed/config change and every `export-aspect` appends to committed `decisions.jsonl`. No graph mutation except §24. Optional mirror: adopter creates a node themselves and sets `decisionLogNode`; roots then also appends prose entries via the log's real API.

---

## 18. Telemetry & loop regulation

**18.1 Intervention log** (local): every message ⇒ `{sessionId, ts, stable_id, surface, factKey, expected, observed, severity, deltaBits}` to `telemetry.jsonl`; subsequent same-session observation of the same (stable_id, surface) ⇒ `{…, observedAfter}` (§9.10 closure). Role-free keys. Retention `telemetryRetentionDays`, compacted at `index`.

**18.2 Convention health & demotion** (I2b): aggregation runs **in the same transaction as every snapshot write** (any build that can change membership or role_keys — including incremental ones) and at `report`/`status`; never in hooks. Output `demotions.json`, stamped with the snapshot content hash — the hook ignores a stale stamp (fail-open toward speech being *possible*; a lost demotion resurrects a FACT, never falsely silences one). Events pooled per `factKey` = `(roleKey|_all, surface)` via current membership, **filtered to events whose recorded (surface, expected) matches the current FACT** (expected-flips must not poison the pool). Resolved = has `observedAfter`; unresolved excluded from the denominator. **Cross-session closure:** the aggregation pass also closes interventions left open by ended sessions — if the current index shows the (stable_id, surface) at `expected`, it records a **complied** sample and appends the §18.3 ledger mark (same dedupe); if the pair still exists and deviates, it records an **ignored** sample; if the scope is gone, the intervention is dropped. Without the ignored branch the dominant real path — agent warned, moves on, session ends — would never enter the denominator, compliance would be biased high, and precisely the conventions agents ignore would never demote. **Demote when WilsonLB95(compliance) < `health.minCompliance` (0.3) with ≥ `health.minSamples` (8) resolved.** Slow accumulation acknowledged: demotion is the safety valve; quality is carried by acceptance + eligibility + calibration.

**18.3 `hook-ledger.jsonl`** (committed; the P5 regulator): on a complied intervention the hook appends `{stable_id, surface, date}`. Committed so regulation binds every machine and CI. Effect: the §9.1 weight cap at `hookShapedWeight` (0.15), applied last; and exclusion from the survived-raw display population (§9.4c) until released, so roots-shaped code neither appears as evidence nor props up eligibility. **Release** (evaluated at build; the line remains for audit): `stable_days ≥ releaseStableDays` **and** ∃ a human-authored non-merge commit touching the file with `ts ≥ markDate + releaseMinDaysAfterMark` — the gap requirement exists because the commit that lands the hook-shaped code is routinely human-authored and must not self-ratify. Marks older than the walk horizon: cap persists (conservative; with a full-history walk this case disappears). Merge semantics: union; dedupe on (stable_id, surface, date); malformed lines skipped (I1); a dirty ledger in git status is expected ("roots records that it shaped this code — commit it with your change"). Marks for reverted edits simply never release.

**18.4 `agentShare`:** Σ base(agent-authored, stable_days < agentPromoteDays) / Σ base over scopes first seen in the trailing 120 days (**fixed**) — composition diagnostic; alarm ≥ `health.agentShareAlarm` prints T7; `status --exit-code` exits 3. Reported as `n/a` when there is no history.

---

## 19. CLI reference

| Command | Effect | Exit |
|---|---|---|
| `init` | detect grammars, write config+gitignore+ledger header, full index (full history) + calibrate, offer hooks (shows JSON; `--yes`, `--commit-hooks`, `--enable-pretool`) | 0/1 |
| `index [--full]` | incremental / full; prints walk progress + ETA when projected > 60 s | 0/1 |
| `status [--exit-code]` | freshness, counts, history stats, agentShare, degraded modes, active I2b modulators, DENY availability, windowing-active warning, and "K conventions withheld: no established instances yet" (the J4 explanation) | 0 (with flag: 2 stale, 3 alarm) |
| `check [--hook …] [--exit-code] [paths…]` | evaluate. Non-hook mode: channel `generic`; scope set = scopes whose `body_hash` differs from HEAD, plus enclosing types and file scopes; `[paths…]` restricts to those files and evaluates **all** scopes in them | 0 (with flag: 4 findings) |
| `explain <path[:line]>` | role (sticky or classified), memberships, all FACTs with values/Δ/margins, deduped sibling surfaces, tautological and vacuous skips | 0 |
| `calibrate [--json]` | recompute `calibration.json` from the current cache (requires fresh index) | 0/1 |
| `report / campaign / seed / brief / scaffold` | as specified | 0/1 |
| `export-aspect <factKey> [--out <dir>] [--yes]` | §24 — generate a ratcheted Yggdrasil aspect from a discovered FACT | 0/1 |
| `daemon start\|stop\|status` | §12.6 lifecycle | 0/1 |
| `reset --cache\|--state\|--all` | wipe named store(s); `--state`/`--all` list what is lost and require confirmation or `--yes` | 0/1 |
| `doctor` | grammars + node-types presence, binding derivation sanity, store integrity, hook probe-execution, socket, double-`--full` determinism, incident review | 0/1 |
All read surfaces exit 0 by default (owner decision); `--json` on read commands; `--cwd`; `--partition`.

---

## 20. Performance & determinism

**20.1 Targets** (reference machine Appendix G.5; CI gates ratio vs a stored baseline, +30 %): **first** full index over complete history — budget stated as a rate, not a total, because histories are unbounded: **≤ 15 ms per distinct historical blob** end-to-end (measured 12 ms), plus ≤ 5 min for extraction + mining at 500k LOC; subsequent full index (warm blob cache) ≤ 5 min at the same size; incremental 10 files ≤ 3 s (non-re-induction); re-induction build ≤ 60 s at N = 6000; daemon 50 ms / cold 700 ms p95; build RSS ≤ 1.5 GB (the blob cache is streamed, never held whole); hook RSS ≤ 200 MB.
**20.2 Determinism:** clock = HEAD committer ts, read once — **never** `max(last_modified)` over the replay and never wall-clock time (the two are indistinguishable on most repositories and diverge on exactly the ones where it matters); no wall-clock field anywhere in the model body (Appendix D). Measured at prototype scale: two consecutive full learns of the same repository produce byte-identical model files (`cmp` clean). Sorted-iteration lint; sha256; snapshot hash excludes header; vocabulary tie-breaks total (§7.2); binding derivation pure and hashed; `doctor` double-build check. Golden fixtures: the roots fixture builder supplies `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (…Z forms), `TZ=UTC`, `-c init.defaultBranch=main` — extending `tests/support/git-fixture.ts` with this determinism block is a named Phase-1 task. Fixtures committed as builder scripts **and** `git bundle`s, with a CI job asserting builder ⇒ bundle equivalence.

---

## 21. Failure policy, exclusions, security

**21.1 Fail-open (I1):** any hook throw ⇒ protocol-appropriate allow + incident (`.roots-state/incidents.jsonl`, FIFO 500 — durable store; wiping the cache must not erase the audit trail). **The fail-open boundary MUST wrap the whole verdict entry point**, not the individual stages inside it — a parse failure, a missing grammar, a corrupt session file or a malformed model row all have to exit through the same catch, returning zero findings plus one incident. **The one exception is the test/mutation harness, which MUST rethrow** (§22.4 runs it hermetically): a harness that fails open silently converts every crash into a "no findings" pass and would report a broken engine as a clean run. One boundary, two modes, selected by the harness flag; store corrupt ⇒ degraded + doctor rebuild; grammar or node-types load failure ⇒ that grammar disabled for the session; a blob that fails to parse is recorded as empty and the walk continues; git unavailable/shallow ⇒ flat weights, no calibration, no trends, completeness off, and every instance counts as unsurvived so the hook surface is ineligible (J4 silence, explained by `status`).
**21.2 Path safety:** hook paths realpath-inside-repo or ignored (one incident/session); no symlink escape.
**21.3 Exclusions:** §6.8's built-in list, merged with config `exclude`.

---

## 22. Testing & acceptance

1. **Unit:** every Appendix B enumerator row (table-driven — the acceptance contract), including its domain and its verbalizer row; **binding derivation per shipped grammar** (assert the derived scope/import/decorator/heritage sets against a committed snapshot per grammar, so a grammar upgrade that moves node types fails loudly); MDL math against Appendix E (E is the fixture source and MUST be regenerated by script — `source/cli/tests/fixtures/derive-e.ts` computes every E number from §9 formulas; the doc is asserted against it); weights (clamps, degraded modes, ledger cap-last); trends/nucleation incl. introduction events; cohort trends; fire-ability/eligibility/vacuous gates and **both absence-τ tiers** (§9.4f); the decoration attribution window (§6.2) incl. a stacked-decorator and a preceding-member case; scope occurrence ordinals across the live and historical key spaces (§6.4); role pre-bucketing and the clone-aware runner-up (§8.3/§8.5); **correlation dedup (cluster formation, lead selection, tie-breaks)**; sticky-role resolution; templating and verbalization; protocol encoders; store canonicalization; ledger merge semantics.
2. **Property:** double-`--full` determinism; incremental ≡ full; fail-open under stage-fault injection; sparse ≡ dense counting; **vocabulary determinism under input permutation**; blob-cache hit ⇒ byte-identical scope records.
3. **Golden repos:** deterministic scripted histories in ≥ 3 grammars (one of which MUST be a language with no decorators — Go — and one with annotations — Java — so binding generality is a gate, not a claim). `expected.json` lists MUST-mine (role pattern, surface, expected, min bits/instance) and MUST-NOT-mine (incl. tautology and vacuity assertions).
4. **Mutation harness (exact verdicts).** Planted deviations generated *from the model*, one per detectable enumerator: strip a required decorator · drop a required supertype · add a forbidden import · rename to an alien name shape · inject a forbidden call · remove a required first-statement shape. Candidates are drawn per partition from the FACTs whose surface has an operator and which carry an exemplar, capped at a **window of 16 per partition** (**fixed**) so a large partition cannot dominate the denominator. Two operators are *offered as candidate sets* rather than as a single edit, because the correct edit is grammar-dependent and the harness knows no languages: **import injection** offers one candidate per import syntax family (JS `import … from '<spec>';` · Python `import <spec>` · Python `from <spec> import …` · C `#include <<spec>>`), and **call injection** offers, besides successive brace-insertion points after the exemplar's name, an **indentation-based insertion after a `:`-terminated header line** within a few lines of the exemplar — the offside-rule case, where there is no brace to land in. In every candidate-set case the harness keeps the first candidate whose planting is confirmed by **re-extraction** (the mutated source is re-parsed and the extractor must show the call inside that scope / the specifier among the file's imports); if no candidate validates, the case is counted `unsupported` rather than scored. Assertions: silence on the unmutated exemplar; detection on the mutation; silence on a novel file with no analog; silence on role conventions for an ambiguous scope; `retry_denied_edit` ⇒ DENY again (dedup must not cover DENY); `comply_after_warning` ⇒ telemetry `complied` + ledger mark (compliance closure). Three harness disciplines are normative, each bought with a prototype defect: **operators target the exemplar's own occurrence** — heritage and call-injection operators anchor the search at the exemplar's recorded line, and the decorator and name-shape operators achieve the same end by rewriting *every* matching occurrence in the file, a superset that necessarily includes the exemplar's (a first-occurrence-only strip mutates someone else's decorator and reports a phantom miss; production SHOULD anchor all six rather than rely on the superset, because a whole-file rewrite makes the "silence elsewhere" half of the assertion unmeasurable); **every injected mutation is validated by re-extraction** — call injection and import injection alike (the ground truth for "the call landed inside that scope" / "the file now imports that specifier" is the extractor, not a brace heuristic or the assumption that a planted `import` line parses in the target grammar; this is also what makes the multi-candidate operators above safe, since a candidate that does not parse as intended simply fails to validate); **the harness runs hermetically and unbudgeted** — no telemetry or session reads/writes, and §11.3's ≤ 3-per-response cap and WARN dedup are bypassed — because its own re-checks otherwise accumulate `ignored` closures and demote the very FACTs under test mid-run, and a truncating budget silently converts a detection into a miss.
**Denominator honesty (binding for the reported figure):** a case whose operator is inapplicable to the FACT (no textual match, a relative import specifier, a callee with non-identifier characters, no candidate injection point that re-extraction confirms) is counted `unsupported` and excluded from detected/missed. The headline is therefore *detection over mutable cases*, and the `unsupported` count MUST be reported alongside it, never suppressed. **Prototype baseline to beat: 65 detected / 0 missed / 0 false fires, 130/130 silence on unmutated exemplars (7 models, TS/JS + Python, two with full history — Appendix H.4).**
5. **Replay harness:** calibration and trends on golden histories reproduce committed expectations byte-identically.
6. **Latency bench**, ratio-gated, including a blob-rate assertion (§20.1).
7. **Hook integration:** recorded stdin fixtures, exact JSON out, `stop_hook_active`, flood/debounce. **7b. Fixture equivalence:** CI rebuilds each golden repo from its builder script and asserts equality with the committed bundle.
8. **Aspect export (§24):** generate from a golden FACT, assert exit 0 on the clean repo and exit 1 with the exact violation listed on a planted deviation; assert grandfathered deviants pass.
9. **Genericity lint (P6):** fails the build if any identifier or string literal in `src/roots/**` outside `EXT2GRAMMAR` names a programming language, framework, or style (allowlist: grammar names inside the map; test fixtures exempt).
10. **DoD:** J1–J5 scripted; golden + mutation gates green; properties green; bench in gate; doctor clean on goldens and on this repo (report-only dogfood); zero `any` exported; dead-config-key lint; docs from §19.

---

## 23. Phase plan (risk-first; final-form components only)

| Phase | Contents | Gate |
|---|---|---|
| **1 — Voice & measurement** | store triad; **binding derivation + grammar node-types packaging**; extraction; all 12 enumerators + vocabularies; roles (§8 complete, **including sticky roles**); MDL acceptance + all gates + **dedup + vacuous filter**; verbalizer; Δ verdicts; PostToolUse Edit/Write + Bash sweep + Stop; telemetry + ledger + demotions; `status/explain/check/index/init/doctor/reset`; maintainer authors graph nodes + architecture types; git-fixture determinism block | mutation harness ≥ prototype baseline; J1 live; compliance telemetry flowing |
| **2 — Memory** | full-history walk + blob AST cache + per-scope lifecycle + value events; trends + cohort trends + nucleation; co-change + completeness; calibration; `calibrate` | replay harness green; walk rate inside §20.1; trends honest on goldens |
| **3 — Judgment & steering** | daemon; PreToolUse DENY (calibration- and reach-gated, coupling fallback); seeds + tensions + decisions; report + campaigns; brief/scaffold; **`export-aspect`** | DENY mutation row green; J2/J3/J5 |
| **4 — Languages** | **nearly free by construction.** Enable the remaining shipped grammars; add golden fixtures and binding snapshots per grammar; verbalizer spot-checks | golden fixtures green per grammar |
| **5 — Speed & polish** | perf to §20.1; Windows pipe; recognizer pack seeded from message-quality telemetry; docs; dogfood hardening | bench gate; J4; DoD |

**Phase 4 is measured, not estimated: adding Java and Go to the prototype cost 0 lines of language-specific code** — two entries in `EXT2GRAMMAR` and the grammar assets that already ship. Both immediately produced correct ontologies (Spring's `@RequestParam`/`@ModelAttribute`/`@Pattern`/`@DateTimeFormat` role conventions; Go's `NewRouter` construction convention). The residual Phase-4 work is fixtures and verbalizer review, not implementation. Enumerators degrade gracefully where a language lacks a surface (Go has no decorators; C's imports are `#include`s).

---

## 24. `export-aspect` — the Yggdrasil bridge (new in v6)

`roots` discovers; `yg` enforces. `export-aspect` is the one-way, user-initiated door between them, and it is what makes a discovered convention *permanent* rather than advisory.

**Command:** `yg roots export-aspect <factKey> [--out .yggdrasil/aspects/<slug>] [--yes]`.
**Preconditions:** the FACT MUST be accepted and hook-eligible; the command MUST print the aspect text, the deviant list, and the exact files it will write, and MUST require confirmation (I8/I10 — this is the only path by which roots touches the graph, and it is never automatic).
**Outputs, both under the chosen directory:**
1. `yg-aspect.yaml` — a generated aspect carrying the verbalized phrase as its description, the evidence (`n_conform/n_total`, bits per instance), and a header stating that it was discovered automatically and converted on request.
2. `check.mjs` — a **standalone deterministic check** with no dependency on the roots model at runtime, implementing the single enumerator's detector for that one surface, plus a **grandfathering ratchet**. **This standalone property is the one part of §24 the prototype does not have**: its generated `check.mjs` re-invokes `roots2.mjs scan-pid` with absolute paths to the prototype and the model baked in (`resolve()`), so the exported aspect is keyless and deterministic but still model-coupled. Production MUST inline the single surface's detector (extraction + one predicate + the frozen allowlist) so the aspect survives a wiped `.roots-cache/` and a roots uninstall — an aspect that dies with its generator is not an enforced rule: the FACT's current deviants are embedded as a frozen allowlist; pre-existing deviations pass, any *new* deviation exits 1 and is listed by name. The ratchet is what makes adoption riskless — a repository never has to fix its history to start enforcing its own convention.
`decisions.jsonl` records the export (§17.4).

**Prototype-verified live** on this repository, twice: the discovered FACT "files here do not import `web-tree-sitter`" (320/342 conform, 22 deviants = exactly the AST layer, which independently matches a hand-authored Yggdrasil aspect) exported to a runnable aspect that exits **0** on the clean tree and exits **1 with the exact offending path** when a file importing `web-tree-sitter` is planted outside the AST layer; and again from the final prototype (`roots2.mjs export-aspect`) on the lock-access boundary FACT (25 grandfathered, same exit semantics). The full loop — emergent discovery → agent-visible suggestion → agent-initiated conversion → deterministic keyless CI enforcement — is demonstrated end to end.

---

## Appendix A — Message template catalog (exact, complete; T4 intentionally absent — numbering kept stable across drafts)

**T1 — WARN (post-tool)** — the §11.1 body verbatim; prefix line exactly `[roots] {ROLE_LABEL|repo-wide} convention: {VERBALIZED_PHRASE}`. No transition text in hooks.

**T2 — DENY (pre-tool reason)**
```
[roots] Blocked: structural convention violation.
{n_conform}/{n_total} established {unit_plural} in this repo {VERBALIZED_PHRASE}; this edit sets {observed} in `{path}`.
This convention has structural reach ({reach_reason}) and calibrated precision {calibPrecision}.
See: {ex1} · {ex2}
If this is an intentional architecture change, record it as a seeded exemplar:
`yg roots seed add {path} --surfaces {surface} --arch --note "..."`.
```

**T3 — transition note (REPORT ONLY — never rendered in hooks)**
```
Transition in progress: stock majority {stock_value} ({stock_share}), rising value {v} ({v_share}, {trend_word}).
Hook messages against {v} are suspended while the transition holds.
```
`{trend_word}` ∈ {rising, stable, declining} from the sign of the §9.5 slope (± `nucleation.minSlopePerQuarter` as the dead band).

**T5 — completeness (Stop)**
```
[roots] Possible incomplete change-set. Edits like this one historically also touch:
{for each: - {path} (co-changed in {support}/{commits} similar commits)}
If intentionally out of scope, ignore this note.
```

**T6 — seed tension**
```
[roots] Seed tension: seeded value {v} for {VERBALIZED_PHRASE} correlates with fix-commits {fc}x above baseline in this repo (n={n}). The seed remains in force; consider reviewing it.
```

**T7 — agentShare alarm**
```
[roots] agentShare = {v} >= {alarm}: {pct}% of recent norm weight comes from unsurvived agent-authored code.
Recent conventions largely reflect unreviewed agent output. Mitigation: human review of recent agent code, or wait for survival weighting to settle.
```

**T8 — aspect export confirmation (new)**
```
[roots] Convert a discovered convention into an enforced rule?
  {VERBALIZED_PHRASE} — {n_conform}/{n_total} established {unit_plural} conform.
  {k} current deviations will be GRANDFATHERED (listed in the generated check); new ones will fail CI.
  Writes: {dir}/yg-aspect.yaml, {dir}/check.mjs, and one line in .yggdrasil/roots/decisions.jsonl.
```

---

## Appendix B — Enumerator catalog (binding; the acceptance contract — one table-driven unit fixture per row)

Columns: `surface | applies | type | class | domain | history | overlap | verbalization`. `history` ∈ blob (blob-local) / path (path-derived) / global (no history — excluded from trends and calibration by declaration). Booleans: closed alphabet, emit `true` only.

| surface | applies | type | class | domain | history | overlap | verbalization |
|---|---|---|---|---|---|---|---|
| `auto.nameshape` | method,type | cat | identity | all named scopes | blob | name-tokens | names like `{ex1}`, `{ex2}`, `{ex3}` |
| `auto.filenameshape` | file | cat | identity | all files | path | name-tokens | file names like `{ex1}`, `{ex2}`, `{ex3}` |
| `auto.arity` | method | cat | identity | methods with a parameter list | blob | signature-shape | take `{v}` parameter(s) |
| `auto.has:<t>` | method | bool | behavior | methods in a grammar whose vocabulary holds `<t>` | blob | — | always/never contain a `{t}` |
| `auto.first1` | method | cat | behavior | methods with ≥ 1 body statement | blob | — | start with a `{v}` |
| `auto.ret` | method | cat | behavior | methods with ≥ 1 return statement | blob | — | return a `{v}` |
| `auto.call:<c>` | method | bool | behavior | methods with ≥ 1 body statement | blob | — | call / never call `{c}` |
| `auto.deco:@<d>` | method,type | bool | behavior | scopes in a grammar with decorator nodes | blob | decorator | are / are not annotated with `@{d}` |
| `auto.dir<n>` | file | cat | identity | all files | path | import-segments | live under `{v}/` — **role cells only (§9.4c.2, §9.4i)** |
| `auto.imp:<s>` | file | bool | behavior | files with ≥ 1 import | blob | import-segments | import / do not import `{s}` |
| `auto.extends:<T>` | type,method | bool | behavior | scopes in a grammar with heritage nodes | blob | supertype | extend / do not extend `{T}` |
| `auto.stshape:<sh>` | method | bool | behavior | methods with ≥ 1 body statement | blob | — | use / never use the structure `{sh}` |
| `auto.varshape` | method | cat | behavior | methods declaring ≥ 2 locals | blob | — | name local variables like `{v}` |
| `auto.moddirshape` | module | cat | identity | directories with ≥ 3 code files | path | — | directories here: name shape = `{v}` |
| `auto.modfileshape` | module | cat | identity | idem | path | name-tokens | directories here: file names = `{v}` |
| `auto.modsize` | module | cat | identity | idem | path | — | directories here hold `{v}` files |

**Fallback buckets (binding, §9.4c.1):** `other`, `none`, `mixed`, `?` — never eligible as `expected` on any row.
**Name-shape alphabet:** `U` = a run of upper-case, `a` = a run of lower-case/digits, `_ - $ .` literal, everything else `?`; runs of period ≤ 3 folded to `(x)+`. Casing is thereby discovered, not classified — and a repository with an idiosyncratic convention (`get_X_Handler`) is described correctly rather than being forced into one of four named cases.

---

## Appendix C — Recognizer pack interface (OPTIONAL UX layer; replaces v5's transform registry)

```ts
export interface Recognizer {
  id: string;                                   // unique; lexicographic tie-break
  matches(fact: Fact): boolean;                 // pure, on the FACT's surface + expected value
  namedFix(fact: Fact, scope: ScopeSummary): string;   // ONE imperative sentence naming concrete symbols
}
```
Binding rules: recognizers MUST be pure and side-effect-free; MUST NOT read the repository; MUST NOT influence acceptance, eligibility, severity, Δ, coverage, debt, campaigns, telemetry or calibration; and MUST be individually disableable. At most one recognizer contributes a line per message (lowest `id` among matches). Ship **none** in Phase 1 — the exemplar contrast is the witness (§10.1) and the pack exists only to sharpen phrasing where telemetry shows the contrast is not enough. Seed candidates, if the data warrants: presence-of-decorator, presence-of-supertype, forbidden-import, name-shape-rename.
*Why this replaces the v5 registry:* the registry was a gate (no transform ⇒ permanent silence) and a per-language authoring burden; the pack is neither. See §10.1 for the full reasoning.

---

## Appendix D — `model.json` snapshot (string keys only; header excluded from content hash; sufficient for the hook path by construction)

```jsonc
{ "header": { "rootsVersion","configHash","seedsHash","ledgerHash","bindingHash","headSha","lastIndexedSha",
              "dirtyHash","clock","candidateCountLog2","rolesStale" },
  "historyStats": { "commits":3824,"events":0,"blobs":4118,"parsed":4118,"mb":0 },   // walk duration is header-class, never body
  "cochange": [{"a":"…","b":"…","sup":54,"conf":0.75}],
  "agentShare": 0.41,
  "partitions": [{ "id": "…",
    "vocab": { "nodeType":["…"],"call":["…"],"import":["…"],"supertype":["…"],"shape":["…"],"decorator":["…"] },
    "alphabets": { "<surface>": ["v1","v2","…"] },              // §9.3 — partition-observed values, sorted, seeds excluded
    "roles": [{ "roleKey":"…","label":"guard+CanActivate+Injectable","size":34,
                "medoidFeatures":["tok:guard","sup:CanActivate","dec:Injectable","…"],
                "definingFeatureGroups":["supertype","decorator"], "roleLift":0.42, "ambiguityRate":0.39 }],
    "assignments": { "src/a/b.ts#type#AuthGuard": "<roleKey>", "src/a/c.ts#method#handle": "-1",
                     "src/a/c.ts#method#handle#1": "<roleKey>" },   // §8.6 STICKY; "-1" = ambiguous; "#k" = §6.4 ordinal (elided at k=0)
    "facts": [{ "factKey":"<roleKey|_all>|<surface>","roleKey":"…|_all","surface":"auto.extends:CanActivate",
                "appliesKind":"type","expected":"true",
                "counts": {"true":"24.2","false":"1.3"},        // weighted n_v (canonical decimals); p̂ via §9.3
                "alphabet":["true","false"],
                "nConformRaw":10,"nTotalRaw":10,                // the SURVIVED raw population of §9.4c (what T1/T2 display)
                "share":1.0,"bitsPerInstance":5.04,"bitsSaved":41.2,
                "nSurfaces":3,                                   // §9.4e dedup compression
                "hookShapedConform":0,
                "tau":2.5,"absence":false,"calib":{"available":false,"reason":"events 0<12"},
                "hookEligible":true,"denyEligible":false,
                "suppressedValue":null,"seeded":false,"stabilityDays":210,
                "trend":{"shares":[{"end":0,"share":0.88,"n":8}],"attractor":"true","nucleating":null},
                "cohorts":{"2018":0.92,"2020":1.0,"2022":0.6,"2024":1.0},
                "exemplars":[{"rel":"…/auth.guard.ts","line":6,"name":"AuthGuard"}],
                "deviantsN":1 }],
    "couplingByFile": {"…": 82}, "couplingByModule": {"src/app": 61}, "moduleOfFile": {"…":"src/app"},
    "seeds": [{"seedId":"…","surfaces":["…"],"tension":null}],
    "coverageRole":0.63,"coverageAll":0.91,"debtBits":812.5,"debtPerInstance":1.9 }] }
```
`historyStats` MUST carry **no wall-clock field** in the snapshot body. Walk duration is a progress/reporting number, not model content: recording it inside the body fails I2a's byte-identity property on the timing field alone, which is exactly what the prototype did until it stopped storing it (`{commits, events, blobs, parsed, mb}` only — and two consecutive learns of the same repository are now byte-identical, `cmp`-clean; Appendix F, I2a row). If a build wants to report the duration, it belongs in the header (hash-excluded) or on stdout.
Local modulators (`demotions.json`, sessions) are NOT in the snapshot — I2b. The hook additionally reads `demotions.json` and its session log; both live in `.roots-state/` and are small.

---

## Appendix E — Worked constants (unchanged from v5.2; the math is untouched by emergence)

Generated by `source/cli/tests/fixtures/derive-e.ts` from §9 formulas — one presentation convention: every row reports `bits_saved` after all costs, compared against the 4.0 margin; the doc is asserted against the script, never hand-edited.

**E.1 Δ reachability (KT; booleans K=2).** Clean convention, deviant observed: Δ = log2(2·n_eff+1) at any alphabet (clean-case K-invariance — numerator and denominator share the same KT denominator): n_eff 3 → 2.807 ✓, 4 → 3.170, 6 → 3.700. Asymptotes: 90/10 → 3.170 ✓ (fires at any n), 85/15 → 2.503 (boundary), 80/20 → 2.000 ✗. Categorical |V|=4 (K=5), clean n_eff=6, rare in-alphabet value: p̂(e)=6.5/8.5=0.7647, p̂(v)=0.5/8.5=0.0588, Δ=3.700 — identical, as predicted.

**E.2 Fire-ability, exactly.** The §9.4c gate `(n_e+½)/(n_runnerup+½) ≥ 2^τ` is the finite-n condition for Δ against the most common deviation to reach τ — exact at every n, for every alphabet. For booleans at τ = 2.5 it converges to share ≥ 5.657/6.657 = **0.8498** as n → ∞ (at n = 30 the gate demands share ≈ 0.861; a fixed 0.85 share gate would have admitted an eligible-but-mute band). At τ = 3.5 (vocabulary-absence facts, §9.4f) the boundary is share ≥ 11.314/12.314 = **0.9188** — the empirical reason absence facts use it. At τ = 4.5 (structural-absence facts — `auto.has:` / `auto.stshape:`, §9.4f) the boundary is share ≥ 22.627/23.627 = **0.9577** ≈ 0.958, which is what rejects the measured 94.8 %-share "never contain an `if_statement`" case while leaving genuine structural absences audible. At share 2/3 the supremum of Δ over all n is exactly 1.0 bit — permanently ineligible, as intended.

**E.3 Role acceptance scenarios (boolean, C₂ = 2^14 ⇒ index 14.0 bits, margin 4).**
- **S1 flagship:** partition 600 (role 30 conforming; rest 30/540 reversed): p̂_all=0.1007, p̂_r=0.9839 → data = 30·3.289 = 98.7; param 2.45 → **bits_saved 82.2 ✓**. Minimum role size at this contrast: **n_r = 7**.
- **S2 `_all` coin flip:** 50/50, any n → data_term = 0 → **rejected** (the B = max(|V|,2) baseline; including ⊥ would hand 0.57 free bits/instance and first accept the coin at n = 42 — verified and excluded).
- **S3 `_all` clean boolean:** accepts at exactly **n_eff = 21** (n=21: +0.11 ✓; n=20: −0.86 ✗).
- **S4 zero-contrast big role:** role 500 all-true in a 505-true partition: data ≈ −0.01 → **rejected** (the partition-posterior baseline removes the leave-role-out pathology).
- **S5 chaotic role:** 18/12 in a 50/50 partition: data 0.87 ≪ costs → **rejected** — correct silence on 60/40.

**E.4 False-convention control.** With index_cost = log2(C₂), the acceptance threshold implies a per-candidate G-test p-value small enough that the expected false-accept count across all C candidates is ≪ 1 (at C₂ = 2^14, margin 4: data_term ≥ 18 bits ⇒ G ≥ 25 ⇒ p ≈ 6e-7 for K = 2; 2^14 × 6e-7 ≈ 0.01). **Empirically confirmed in the emergent space:** a shuffled-label null control produced **0** accepted role-conditioned conventions on every repository and every partition, at C up to 4 663 candidates.

**E.5 Attractor-enforcement impossibility (why P3 is structural).** The survived-raw gate requires share ≥ 2/3 > 1/2, so `expected` is the majority of the survived stock; the fire-ability ratio additionally forces a ≥ 5.66:1 margin over the most common deviation (≥ 11.3:1 for vocabulary absence, ≥ 22.6:1 for structural absence). A minority attractor can never be `expected`. Transitions are report/campaign material and nucleation stand-downs only.

**E.6 Unseen values.** |V| = 4, n_eff = 20: p̂(⊥) = 0.5/22.5 = 0.022, clean p̂(e) = 0.911 → Δ = 5.36 — passes τ but is **capped at WARN with a novelty note** (§9.7); ⊥-surprisal grows like log2(2n+1) and must never reach DENY.

**E.7 Wilson floors (z = 1.96, two-sided — why §14 selects on the point estimate).** WilsonLB95 of a flawless record: 12/12 → 0.758; 15/15 → 0.796; 16/16 → 0.806 — a lower-bound τ-selection rule at `minEventsConvention = 12` is unsatisfiable even at perfect precision, and real repair-rate proxies run 0.2–0.5 (LB95(20/40) = 0.352), so a lower-bound rule demotes everything that accumulates evidence: usage would cause muting. Hence: point estimate selects τ; demotion requires WilsonUB95 < target (evidence of badness); the lower bound gates only DENY, whose floor is **n = 35** flawless and 53 with one failure — the source of `minEventsDeny: 35`.

---

## Appendix F — SYNC MATRIX (spec ↔ prototype `roots2.mjs`; honest verification status)

Prototype: `probe/roots2.mjs`, commands `learn · check · report · status · completeness · mutate-test · export-aspect · scan-pid · spectrum · where` (all in one script; `roots-proto.mjs` is its retired predecessor). Column 4 is **MEASURED** with the number, **SIMPLIFIED** with what production adds, or **SPEC-ONLY**. **Line references are valid for prototype revision `md5 4a41ec1d…` (676 lines; current revision `bc9eec11…`, 790 lines, adds the `spectrum`, `whereCmd` and persistent-blob-cache blocks — line refs before the §16.2b insertion point hold, later ones drift; the function name is the durable pointer) — the function name is the durable pointer; re-stamp the revision when refreshing them.**

| Mechanism | Spec § | Prototype function / lines | Verification |
|---|---|---|---|
| Binding derivation from `node-types.json` | §6.2 | `bindingFor` (35–44) | **MEASURED** — TS/TSX/JS/Python/Java/Go, 0 lines of language code for Java+Go |
| Decorator lexical marker filter (`@`/`[`) | §6.2 | `extractScopes` → `scanDeco` (89) | **MEASURED** — kills the `type_annotation` pseudo-decorator class (nest field 140→91 facts, all removed facts spurious) |
| **Decoration attribution window** (after previous non-decoration sibling, at-or-before body start) | §6.2 | `extractScopes` (84–90: `loRow` / `bodyRow`) | **MEASURED** — replaces the earlier one-sided `endRow ≤ startRow + 1` test, which attributed every preceding class member's decorators to the current scope. The two-sided window also covers decorator **stacks of any height** and **parameter-level annotations** (both lie inside `(loRow, bodyRow]`), neither of which the old rule handled. |
| EXT2GRAMMAR as the only per-language datum | §6.1 | const (29–30) | **MEASURED** — 17 extensions → 13 grammars |
| Built-in exclusion list, two masks | §6.8 | `EXCL` (19) + `MINE_EXCL` (20); mining `walkFiles` (56), history walk (270), co-change (312) | **MEASURED** — the masks are now split exactly as §6.8 specifies: `EXCL` gates all three surfaces, `MINE_EXCL` (`*.test.*` / `*.spec.*`) gates **convention mining only**, so test files stay fully counted in lifecycle, value events and co-change (which is where the `routing.py ↔ test_routing.py` pair comes from). |
| Scope extraction, kind by nesting, no descent into nested scopes | §6.3/§6.7 | `extractScopes` (70–119) | **MEASURED** |
| Scope **occurrence ordinals** on every key | §6.4 | `extractScopes` (113–114 `s.ord`), `skeyR` (120); blob side (288 `o`, 300) | **MEASURED** — `#k` (elided at k = 0) now disambiguates same-named scopes of a kind within a file, and the *same* ordinal is assigned during historical blob extraction, so the live and historical key spaces join. Applied consistently in sticky assignments (451), the verdict scope key (520), telemetry/ledger keys (523–524, 552), the hook-shaped cap key (446) and full-history lifecycle/value-event keys (300–308). This closes the overload / repeated-nested-class collision. **SIMPLIFIED** — the key is `relPath#kind#name#k`, not §6.4's `stable_id` (no partition id, no arity, no hashing); production MUST use `stable_id`, of which this is the prototype-scale analog of the `#k by source order` clause. |
| E1 name morphology (`(x)+` folding) | §7.1 | `nameShape` (58–62) | **MEASURED** — `(Ua)+` etc. discovered on every repo |
| E2 arity · E4 first-statement · E5 return shape · E11 varshape | §7.1 | `extractScopes` preds (101–105) | **MEASURED** |
| E3/E6/E8/E9/E10 vocabulary surfaces | §7.1–7.2 | `applyVocab` (121–127); vocab build in `learn` (431–438) | **MEASURED** — support/topK per enumerator |
| E7 path segments · E12 module level | §7.1 | `extractScopes` (110–111); `learn` module scopes (409–414) | **MEASURED** |
| Per-partition vocabulary | §7.2 | `learn` (431–439, cleared per partition) | **MEASURED** |
| Relative-import normalization | §7.1 (E8) | `resolveImport` (63–66) | **MEASURED** |
| Overlap/tautology skip for role candidates | §7.3 | — | **SPEC-ONLY.** No tautology filter exists; a role defined by `dec:Injectable` can and does accept the candidate `auto.deco:@Injectable`. This also means `C` (below) is counted over a wider candidate set than §9.4a defines. |
| Role feature bag incl. decorators + supertypes | §8.1 | `extractScopes` feats (115–118) | **MEASURED** — ambiguity 39 % vs 56–85 % with sparse bags |
| `_untyped` gate (≥ 2 own features) | §8.1 | `induceRoles` (135), `assignAll` (163) | **MEASURED** |
| Lance-Williams average linkage + incremental-DL MDL cut, **weighted** | §8.3 | `induceRoles` (143–155), `cdl` (146–147) | **MEASURED** — cut selected on 5 languages; linkage sizes, cluster DL and medoid distance sums all carry representative weight (§8.3's pre-bucketing row). **SIMPLIFIED** — an undocumented floor skips clustering entirely below 12 total member weight (142); production either specifies the floor or lets `minClusterSize` carry it. |
| Cluster sample cap 700, applied to **distinct feature bags** | §8.3 | `induceRoles` pre-bucketing (136–141), weighted medoid + `minClusterSize` as total weight (157–159) | **MEASURED** — identical feature bags are collapsed to weighted representatives *before* the cap, so identical twins can no longer be split by sampling and capacity is 700 distinct bags rather than 700 scopes. Measured: a stride sample over raw scopes had destroyed a role outright; pre-bucketing restored it. (Earlier revisions of this matrix listed pre-bucketing as a production addition — it is now in the prototype and measured.) |
| Medoids + single own-features classifier | §8.4 | `induceRoles` (156–159), `assignAll` (162–172) | **MEASURED** |
| Ambiguity gates (gap 0.15 / m1 0.35) | §8.5 | `assignAll` (170) | **MEASURED** |
| **Clone-aware ambiguity runner-up** (skip medoids with bag-Jaccard ≥ 0.6 to the winner) | §8.5 | `assignAll` (167–169) | **MEASURED** — two surviving clusters of one latent role were manufacturing ambiguity for every member, and ambiguity is silence (I5). With the clone filter, six identical classes flipped from all-ambiguous to a stable role, with `roleAmbiguityGap` untouched. |
| **STICKY ROLES** | §8.6 | `checkFileInner` (507–508) reading `part.assignments` | **MEASURED — detection 50 % → 93 %** (historical, earlier operator generation) |
| File-scope derived role (plurality of members) | §8.9b | — | **SPEC-ONLY.** `assignAll` (163) skips `file` scopes, so file FACTs are `_all`- or directory-conditioned only; no file scope ever carries a role. |
| `role_lift` | §8.10 | `roleLift` (251–254) | **SIMPLIFIED** — prototype uses a positive proxy (any accepted role fact ⇒ lift > 0), computed and exported but never read by the verdict. Production adds the real held-out DL difference with overlap-group exclusion and the decorative-role demotion. |
| Instance weights (survival × provenance × churn, floor) | §9.1 | `mkWeightFn` (325–336) | **MEASURED** — field reshaped 15→12 facts, 6 shared. **SIMPLIFIED** — `noLifecycleWeight` 0.3 is implemented (331); `dirtyWeight` is not (the prototype has no working-tree dirty test). |
| Ledger weight cap (0.15, applied last) | §9.1/§18.3 | `learn` (446–447) counting `hookShapedConform` | **SIMPLIFIED** — prototype counts capped conformers per fact instead of capping the per-(scope,surface) weight inside the counts (`CFG.hookShapedW` is declared at 22 and never read). The cap **key** is now ordinal-correct (`skeyR(...)#pid`, 446). Production applies the cap in `w(s,q)` before mining and excludes unreleased marks from the survived-raw population. |
| Seeds: surface-scoped, capped 0.5 × n_eff_real | §9.2/§17 | `mine` (195–201) | **MEASURED** (mechanism runs; no seeded corpus measured). Seeds correctly contribute 0 raw and 0 survived-raw and are excluded from members; the `(+seeded)` message note of §11.1 is not rendered. |
| KT α=½ posteriors, alphabets, ⊥ | §9.3 | `kt` (131), `mine` (209–214), `checkFileInner` (530–533) | **MEASURED** — including the prototype-found JSON-object hazard: counts live in plain objects, so `kt` reads them through `Object.prototype.hasOwnProperty` (131) and cells are `Object.create(null)` (178). Without it a value literally named `constructor` (a real method name in every JS/TS class) reads `Object.prototype.constructor` instead of 0 and its posterior is nonsense. `trendsFor`'s `authorsByVal` is null-prototype for the same reason (347). Production's canonical-JSON stores inherit this hazard wherever a value string can collide with an `Object.prototype` key. |
| MDL acceptance: role-vs-partition-posterior, param cost, index cost log2(C₂) | §9.4a/b | `mine` (202–217) — `idxCost = ⌈log2 C⌉` **is** log2(C₂) | **MEASURED**. **SIMPLIFIED** — `C` is counted **per partition** and without the tautology filter, where §9.4a specifies once, repo-wide, over tautology-filtered candidates; both differences move the index cost by ≲ 1–2 bits and are conservative in opposite directions. |
| Fire-ability gate | §9.4c.3 | `mine` (218–221) | **MEASURED** |
| Survived-raw share gate ≥ 2/3, fresh excluded | §9.4c.4 | `mine` (189, 222–224) | **MEASURED** with history. **SIMPLIFIED and fail-open without it:** when `learn` runs without `--fullhistory`, `ageFn` is null and line 189 marks **every** instance survived, so the §9.4c degenerate case and §21.1's "no git history ⇒ every instance unsurvived ⇒ hook surface ineligible" (the J4 silence) are inverted, not merely unimplemented. Five of H.4's seven models ran this way. Production MUST fail closed here. |
| Fallback buckets never expected | §9.4c.1 | `mine` (227) | **MEASURED** |
| Placement group-only | §9.4c.2 | `mine` (226) | **MEASURED** — barred on `_all` **and** on directory cells; role cells only |
| Vacuous filter | §9.4d | `mine` (225) | **MEASURED — 117 → 7 eligible on a generated-SDK partition** |
| Correlation dedup (conform-set J ≥ 0.9, lead by bpi) | §9.4e | `mine` (246–250) | **MEASURED — 3.5–58×; 339→42, 486→80**. Lead tie-break by `surface asc` is not implemented (sort is by bpi only). |
| **Absence-τ tier split** (vocabulary 3.5 / structural 4.5) | §9.4f | `mine` (220–221), `CFG.tauAbs` / `CFG.tauAbsStruct` (21–25) | **MEASURED** — absence facts on `auto.has:` / `auto.stshape:` take τ = 4.5 (boundary share ≈ 0.958), call/deco/imp/extends absence keeps 3.5. Motivated by measured spam, not taste: at 3.5 a 94.8 %-share directory fact "tests methods never contain an `if_statement`", carrying **39 standing deviants**, reached the verdict path. The structural family (every grammar node type × every serialized shape) is far larger than the repo-supplied vocabulary family, and 4.5 is where it stops manufacturing prohibitions. |
| Stability days | §9.4g | — | **SPEC-ONLY** — never computed; `{stability_note}` never renders. |
| `factCap` cull (top 400 per partition) | §9.4h | — | **SPEC-ONLY** — no cap; every accepted FACT is exported. |
| **Directory contexts `d[<dir>]:<kind>` + `parentExp` locality line** | §9.4i | `mine` (184–188, 193, 226, 228–229; redundant-refinement pruning 234–245); `checkFileInner` labels/contrast (539–544) | **MEASURED** — the ≥ 25-scope/< partition eligibility test, the placement bar, both pruning rules (parent-agreeing and nested-restating) and the locality sentence all ran inside the H.4 harness numbers, with zero false fires attributable to them. Measured local norms: immich `server/src/schema/` → a local `@Table` default **inverting** the package default; starlette `starlette/` never uses `@pytest.fixture` (the library/test boundary); flask `src/` never uses `@app.route`. (An earlier revision of this row read PROTOTYPE-AHEAD — UNMEASURED; the re-measurement it demanded has been done.) |
| Full git history: every commit, `--reverse --raw --no-abbrev`, no caps | §13.1 | `loadFullHistory` (257–273) | **MEASURED — flask 3824 commits/4118 blobs/53 s; starlette 1617/2422/20–33 s; fastify 4417/6426/43 s (~12 ms/blob)**. **SIMPLIFIED** — author identity is a 32-bit FNV hash of `%an <%ae>` (67, 264), not sha256, and `Co-Authored-By` trailers are not read, so §G.2's trailer branch of the agent classifier is unexercised; the fix regex (264) is looser than §G.1 (`revert` unanchored, no `fix:` / "This reverts commit" branch). |
| Every distinct blob parsed once **ever**; persistent content-addressed cache; language from historical path extension | §13.2 | `loadFullHistory` (blob cache block) | **MEASURED — incremental learning live: flask cold 4 118 blobs / 125 s history phase; warm 4 118 cached / 0 parsed / 0 s; a fresh commit costs exactly its new blobs (measured: 1 parsed, 0 s); model byte-identical across cache states** (run diagnostics excluded from the model body). Cache keyed by extractor version (`EXTR_V`), whole-cache invalidation on mismatch. **SIMPLIFIED** — single JSONL file keyed by version, not `.roots-cache/blobs/**` sharded by `blobSha∥extractorVersion∥bindingHash`; walk itself still full (event replay is the cheap part) where production resumes from `lastIndexedSha`. |
| `where` — inverse query (intent → place + norms + exemplar), lexical over repo-native tokens, map fallback | §16.2c | `whereCmd` | **MEASURED — nest `guard` → `guard+CanActivate` card; immich `database table` → `schema/tables/`; flask `view` → view groups with real co-change partners.** |
| Per-scope lifecycle with rename replay | §13.3 | `loadFullHistory` (293–309) | **MEASURED — 94–96 % scope-level coverage**; historical scope keys carry the same occurrence ordinal as live ones (288, 300), so the join is collision-free |
| Value events incl. decorators/supertypes/nameshape in the change signature | §13.3/§6.5 | `loadFullHistory` (289–290, 302–308) | **MEASURED** — this is the prototype-found defect, now fixed in the signature |
| Clock = HEAD committer timestamp | §13.4/§20.2 | `loadFullHistory` (322) | **MEASURED** — `NOW` is the last walked commit's committer timestamp, i.e. HEAD's; the earlier `max(last_modified)` rule that §13.4 forbids is gone, and no wall clock enters the model (`generatedAt: 0` at 429, telemetry `ts: 0` at 552, and `historyStats` no longer stores walk ms, 324). |
| Trends over 90-day windows across the whole history | §9.5 | `trendsFor` (344–364) | **MEASURED**. **SIMPLIFIED** — window low-sample floor is 4 (spec: `lowSampleMin` 8); window shares are unweighted counts, with no `prov_i(s)` provenance factor; cohort trends were computed in the predecessor script. |
| Attractor (report-only) | §9.5 | `trendsFor` (363) | **SIMPLIFIED** — never consumed by the verdict (the load-bearing property, measured), but the value is `last.share ≥ 0.5 ? expected : top-minority`, not §9.5's `argmax(share_last + attractorSlopeK·slope)`; `trend.attractorSlopeK` is unused. |
| Nucleation stand-down (rising minority, ≥ 2 human authors) | §9.6 | `trendsFor` (354–363); `checkFileInner` (528) | **MEASURED** (mechanism runs; 0 nucleations on the test corpus). Adds an unspecified `(1 − last.share) > 0.05` minimum-foothold term (362). |
| Cohort trends by scope birth year | §9.5 | predecessor `roots-proto.mjs` | **MEASURED — 92 %/100 %/60 %/100 % across 2018–2024** (not present in `roots2.mjs`) |
| Co-change, mega-commit cap 30, cap **by descending support** | §13.5 | `loadFullHistory` (310–321); persistence cap `learn` (465) | **MEASURED — routing.py↔test_routing.py 54× conf 0.75**; the persisted set is now sorted by support before the 5000-pair cut, so a truncating cap can no longer drop the strongest pair (the earlier first-500-by-insertion-order behavior is gone). Test files are counted here by design (`MINE_EXCL` gates mining only, §6.8). |
| Completeness check | §13.5 | `completeness` (564–568) | **MEASURED** |
| Calibration: temporal split, repair-rate labels, point-estimate τ_c, Wilson LB for DENY | §14 | `calibrate` (366–380) | **MEASURED** — correctly reports *unavailable* (`events 0<12`) on every test repo; the DENY gate therefore never armed. **SIMPLIFIED** — τ_c is a two-point rule (`p ≥ targetPrecision ? τ : τ + 1.5`), not §14's ascending-Δ grid search; production adds the grid, the family/cluster pool and the UB-demotion branch. |
| Verdict function incl. τ, Δ, novelty | §9.10 | `checkFileInner` (478–554) | **MEASURED** |
| DENY gate (calibration + `denyExtraBits` + structural reach + daemon) | §9.9 | `checkFileInner` (536) | **SIMPLIFIED** — severity is `denyEligible && value-in-alphabet`; the `Δ ≥ τ_c + denyExtraBits` margin, the coupling/cross-file reach test and the daemon precondition are absent. Unexercised in practice: calibration never armed on any repo, so no DENY was ever emitted. |
| **Specificity governance** (one governing fact per surface: role < directory < `_all`) | §9.4i/§9.10 | `checkFileInner` `gov`/`ctxRank` (502–516) | **MEASURED** — the predecessor `rolePids` role-over-`_all` shadow, whose absence let a repo-wide absence FACT (95 % share) false-fire on every member of a role whose own FACT expects presence (100 % share), is generalized to *smallest survived-raw evidence class wins, ties role < dir < `_all`*. The three-context generalization is now inside the H.4 harness numbers (0 false fires with directory cells live). |
| **Compliance closure** (open intervention → complied/ignored → ledger mark) | §9.10/§18 | `checkFileInner` (521–526) | **MEASURED — closed loop re-verified at the final revision on flask's `JSONTag` role**: strip the supertype ⇒ one role-labeled WARN carrying the locality-contrast line; restore ⇒ silence, one `after:"complied"` telemetry line and exactly one ledger mark |
| Ignored-closure bounded once per session | §9.10 | `checkFileInner` (525, `open.session !== session`) | **MEASURED** — before the bound, harness re-checks demoted a 96 %-share FACT mid-run |
| Health demotion (Wilson LB < 0.3 over ≥ 8 resolved) | §18.2 | `checkFileInner` (496–500); telemetry line (552) | **MEASURED** (mechanism runs). The telemetry line now carries `expected`, `observed` and `delta`, so §18.2's expected-flip filter ("keep only events whose recorded (surface, expected) matches the current FACT") is applicable rather than merely specified. **SIMPLIFIED** — the aggregation itself still pools by `factKey` without applying that filter, and there is no cross-session closure pass, so sessions that end with an open intervention never enter the denominator. |
| Session dedup (WARN only) + budgets (3/response, 12/session) | §11.3 | `checkFileInner` (492–494, 537–538, 550–553) | **MEASURED**. **SIMPLIFIED** — session state is a rewritten JSON file; production uses the append-only event log of §11.4 for crash- and concurrency-safety. Output order is (severity, Δ) with no `surface asc` tie-break. |
| agentShare (120-day cohort, base weights) | §18.4 | `learn` (448–449, 464) | **MEASURED** — 0 on a human-authored corpus, `n/a` without history |
| Verbalizer (one row per enumerator) | §11.2 | `verbalize` (383–399) | **MEASURED** — the §11.1 samples are its real output |
| T1 message body | §11.1 | `checkFileInner` (545–548) | **SIMPLIFIED** — renders label, phrase, survived-raw fraction, hook-shaped note, deviation, novelty note, locality line and exemplars; `{unit_plural}` (the fraction reads "established conform"), `{stability_note}`, `{seed_note}` and `{named_fix_line}` are production additions, and `{deviation_phrase}` is the generic "deviates" rather than the per-row negation. |
| Exemplars: non-ambiguous members only | §9.11 | `learn` (452–453) | **MEASURED** for the non-ambiguity filter and the top-3 cut. **SIMPLIFIED** — selection is index order, not §9.11's `w(s,q)·m1·centrality` ranking, and there is no render-time re-validation. |
| Mutation harness (anchored operators, candidate sets, placement validation, hermetic state) | §22.4 | `mutate` (569–595) / `mutateTest` (596–615) | **MEASURED — 65 detected / 0 missed / 0 false fires / 130 of 130 silent on unmutated exemplars, across nest (23), immich (15), typeorm (11), fastify (2), Yggdrasil (3), starlette-full (5, Python), flask-full (6, Python)**, over *mutable* cases (`unsupported` excluded, §22.4). Candidate window is 16 FACTs per partition (598). Line anchoring is implemented for the heritage (575) and call-injection (583) operators; the decorator (570–572) and name-shape (581) operators rewrite every matching occurrence in the file instead. Import injection offers one candidate per syntax family (580: JS `import … from`, Python `import`, Python `from … import`, C `#include`) and call injection adds indentation-based insertion after a `:`-terminated header line for offside-rule languages (589–593); every candidate set is resolved by re-extraction (604–610), and a set with no validating candidate is counted `unsupported` (610). The name-shape assertion is weakened by design (612: any scope's `auto.nameshape` message counts, because the mutated scope no longer has the exemplar's name) — the one place detection is not tied to the mutated scope. Five of the seven models had no git history (see the survived-raw row). |
| `export-aspect` with grandfathering ratchet | §24 | `exportAspect` (617–651), `scanPid` (652–656) | **MEASURED — re-verified at the final revision on this repo's dogfood model: lock-boundary FACT exported, exit 0 on the clean tree with 25 grandfathered, exit 1 listing the exact planted violation.** **SIMPLIFIED** — the generated `check.mjs` shells out to `roots2.mjs scan-pid` with absolute paths to the prototype and the model (644–645); §24's "standalone, no runtime dependency on the roots model" is therefore **not** demonstrated. |
| Report / status surfaces | §16.1/§19 | `report` (557–563), `status` (657–662) | **MEASURED** (subset of the specified fields) |
| `spectrum` — full lattice on demand, deep vocabulary, no acceptance cut | §16.2b | `spectrum` (620–674) | **MEASURED — flask tag.py: 2 885 cells / 633 rows at bits ≥ 0 vs 17 NORMs; immich activity.table.ts: 4 493 / 900 vs 54.** |
| Partitioning (package roots, 300-scope floor, `_repo` merge) | §6.8 | `learn` (415–423) | **MEASURED** — package-root detection covers `package.json`/`pyproject.toml`/`go.mod`/`pom.xml`/`Cargo.toml`; §6.8's `*.csproj`/`*.sln`/`setup.cfg` are unimplemented. |
| Seed tension (`fc` vs fix-touch baseline) | §17.3 | — | **SPEC-ONLY** — `fix_touches` are accumulated in the replay (306) and never read. |
| I1 fail-open in the verdict path | §3.3/§21.1 | `checkFile` wrapper (474–477); `learn` (405–407) | **MEASURED** — the verdict entry point is wrapped: any throw from `checkFileInner` (parse failure, missing grammar, corrupt session JSON, malformed model row) returns zero findings plus one stderr incident line, so the hook path fails open as I1 demands. The harness mode **rethrows** (476) so §22.4 cannot silently score a crash as "no findings". **SIMPLIFIED** — the incident is a stderr line, not §21.1's durable FIFO-500 `incidents.jsonl`. |
| Determinism I2a/I2b (sorted iteration, hashing, double-build) | §20.2 | `NOW` (322), `generatedAt: 0` (429), telemetry `ts: 0` (552), `stats` without ms (324) | **MEASURED at prototype scale** — two consecutive learns of the same repository produce byte-identical model files (`cmp` clean). The former wall-clock leak (`historyStats.ms` in the model body) is removed and the clock is HEAD's committer timestamp. **SIMPLIFIED** — no standing determinism harness, no content hashing, no sorted-iteration lint; production adds all three plus the `doctor` double-build check. |
| Daemon, PreToolUse DENY, socket, staleness | §12.6–12.7 | — | **SPEC-ONLY: production hardening.** The prototype has no long-lived process; every check is cold. |
| Incremental index, `lastIndexedSha` resume, build lock | §6.6/§4.4 | — | **SPEC-ONLY: production hardening.** The prototype always does a full learn. |
| Three stores, canonical JSON, sharding, reaping, aliases file | §4.4/§5 | single `model.json` + `<model>.state/` | **SIMPLIFIED** — production adds the store triad, atomic writes, sharding, schema versions and reaping. Rename aliases are tracked in-memory during the replay (297) and never persisted. |
| Claude Code hook wiring, channels, bash sweep | §12.2–12.4 | `check` CLI entry (666–669) | **SPEC-ONLY: production hardening.** The prototype exposes the verdict as a CLI command; the channel table and protocol encoders are not implemented. |
| Coverage / debt / campaigns / brief / scaffold | §15–16 | — | **SPEC-ONLY** — computable from the model as specified; not implemented in the prototype. |
| Recognizer pack | §10.2/App C | — | **SPEC-ONLY** — none shipped, by design (Phase 1 ships none). |

---

## Appendix G — Restated normative material

**G.1 Fix classifier (per commit):** message matches `/^(fix|hotfix|bugfix)\b|(^|\s)revert(s|ed)?\b/i` OR conventional-commit type `fix:` OR contains `This reverts commit`.

**G.2 Agent-author classifier:** the commit's author or a `Co-Authored-By` trailer matches any `history.agentIdentities` regex, case-insensitively. A scope's `author_kind` is the kind of its most recent non-merge touch — a file touched by both humans and agents is classified by its latest author, which drives `w_prov` for the whole model.

**G.3 Layer/coupling inputs.** Coupling percentile per file = the file's rank in the distribution of distinct co-change partners with confidence ≥ `cochange.minConfidence`; per module = the median of its files. `moduleOfFile` is derived from the path per §6.3 and stored as a cache, not a source of truth.

**G.4 Co-change & completeness** — the full algorithm is in §13.5; it is normative there and is not duplicated.

**G.5 Reference machine:** Apple M-series, 8 performance cores, NVMe. CI gates use ratios vs a stored baseline, never absolute ms.

---

## Appendix H — Empirical annex (all figures measured, not projected)

**H.1 Corpus.** Ten repositories, five languages, mined with the same zero-configuration pipeline: immich (TS/NestJS app), nest (TS framework monorepo), typeorm (mature TS lib), fastify (JS framework), express (small JS lib), Yggdrasil (this repo, dogfood), flask (Python), starlette (Python), spring-petclinic (Java), chi (Go).

**H.2 Mining yield and cost.**

| Repo | Scopes | Eligible → FACTs | Dedup | Roles | Runtime (mine) |
|---|---|---|---|---|---|
| immich | 4 695 | 339 → 42 | 3.5–14× | — | 3.2 s |
| nest | 5 161 | 486 → 80 | 5–7× | — | 2.5 s |
| Yggdrasil | 3 026 | 231 → 24 | 6–10× | — | 2.5 s |
| starlette (full history) | — | — → 30 | — | 60 | 33 s incl. walk |
| spring-petclinic (Java) | — | — → 12 | — | 15 | < 5 s |
| chi (Go) | — | — → 3 | — | 21 | < 5 s |

**H.3 Discovered ontologies (nothing about these frameworks is in the product).**
- **nest:** guards → `extend CanActivate` (share 1.0) · interceptors → `extend NestInterceptor` (1.0) · pipes → `extend PipeTransform` (1.0) · resolvers → `@Resolver` (1.0) · controllers → `@Controller` (1.0) · services → `@Injectable` (1.0) · `canActivate` methods → return a true-literal (0.9).
- **immich:** dto role → `extend createZodDto` (0.97, with a real deviant) · repository role → `@InjectKysely` (0.81) · schema role → `@Table` (0.94) · sync handlers → always `await` (0.94) · generated SDK: 93 correlated surfaces → **1** FACT.
- **spring-petclinic (Java, zero language code):** `@Pattern` on a validation role (0.92, 12 established) · `@RequestParam` on a request-handling role (0.91, 11) · `@DateTimeFormat` (0.86, 7) · `@ModelAttribute` (0.83, 18) · type names `(Ua)+` (0.71, 56).
- **chi (Go, zero language code, no decorators in the grammar):** a router-construction role calling `NewRouter` (0.90, 20 established); `_all` structural facts on statement/expression lists.
- **flask / starlette (Python):** `@bp.route` view methods · `@app.before_request` / `@app.teardown_request` hook roles · `View` / `MethodView` class roles · `@pytest.fixture` · `WebSocketEndpoint` roles (0.875, 8 — at the final revision 7 conforming / 2 deviants, which puts it just below the fire-ability gate: H.7e) · `@staticmethod` (1.0, 11) · docstring-first as the raw shape `expression_statement(string(...))` (share 1.0) · **type-hints-in-signatures discovered as a statement shape** (0.88–1.0) · snake_case locals via E11 (87–88 %).
- **Yggdrasil (dogfood):** `files here do not import web-tree-sitter` (0.94/320-of-342) and `do not import chalk` (0.97) — **both correspond to aspects the maintainer wrote by hand**; type-name morphology `(Ua)+` with real deviants; the graph-access boundary as an import fact.

**H.4 Verdict-path behavior.** Final mutation harness, run at the final prototype revision across seven models — nest (23), immich (15), typeorm (11), fastify (2), Yggdrasil (3), starlette-full (5, Python, full-history model), flask-full (6, Python, full-history model): **65 detected / 0 missed / 0 false fires**, **130/130 silence on unmutated conforming exemplars**. Two qualifiers, stated because the headline is otherwise read too generously: (i) the denominator is *mutable* cases — operator-inapplicable cases are counted `unsupported` and excluded (§22.4); (ii) five of the seven models carried no git history, and with no history the prototype treats every instance as survived, so the §9.4c degenerate-case silence (J4) is exercised by neither those models nor these numbers. The third qualifier carried by earlier drafts — that the run predated §9.4i — is **retired**: the directory-context cells, the redundant-refinement and nested pruning, the three-context specificity governance and the locality-contrast messaging were all live for these numbers, and contributed zero false fires. An earlier operator generation scored 40/43 with 1 false fire; closing the gap required no detection change — only anchoring mutation operators at the exemplar's recorded line, validating injected placement by re-extraction, and running the harness hermetically (§22.4) — plus two genuine verdict-layer fixes it flushed out: the decorator lexical marker filter (§6.2) and role-over-`_all` specificity shadowing (§9.10).

**Compliance loop, re-verified at the final revision on flask's `JSONTag` role:** stripping the role's supertype produced exactly one role-labeled WARN carrying the locality-contrast line; restoring it produced silence, one telemetry line with `after:"complied"`, and exactly one ledger mark. (The equivalent loop was first observed on starlette against an earlier revision; the flask run is the current demonstration.)

**H.5 Aspect export.** Two live runs on this repository. Predecessor prototype: FACT "files here do not import `web-tree-sitter`" (320/342, 0.66 bits/instance) → generated `yg-aspect.yaml` + `check.mjs` with 22 grandfathered deviants (exactly the AST layer). Final prototype (`roots2.mjs export-aspect`, re-verified at the final revision): FACT "files here do not import `~/source/cli/src/model/lock`" (share 0.927) → ratchet checker with 25 grandfathered deviants. Both: clean tree ⇒ **exit 0**; planted violating file ⇒ **exit 1** with the exact offending path listed. Both generated checkers delegate the scan to the prototype (`scan-pid`) rather than inlining the detector — the ratchet, the grandfathered set and the exit semantics are measured; the "no runtime dependency on the model" clause of §24 is not.

**H.6 Null control.** Shuffled-label null (each surface's values permuted across scopes, deterministic seed): **0 accepted role-conditioned conventions** on every repository and partition, at C up to 4 663 — Appendix E.4 confirmed in vivo, in the emergent feature space.

**H.7 Honest negatives.** (a) Calibration was **unavailable on every repository tested** — no FACT reached 12 qualifying value events — so DENY never armed; this is the designed behavior, not a bug, and it means the DENY path's real-world exercise remains ahead. (b) On a high-velocity repository the full-history survived field thins to 2 FACTs; survival weighting genuinely discounts most of that stock. (c) Role-conditioned speech is thin everywhere; `_all` carries most enforceable mass, so the role layer must be understood as an enhancement rather than the load-bearing tier. (d) An earlier operator generation was TS-shaped and Python detection scored 4/9; the final anchored, placement-validated operators (§22.4) closed this completely — starlette-full 5/5 and flask-full 6/6 with zero false fires — so the caveat is retired, and it stands as the measured case for why §22.4's harness disciplines are normative rather than advisory. (e) On starlette at the final revision, the `extends WebSocketEndpoint` role convention — 7 conforming against 2 surviving deviants — sits just **below** the fire-ability gate: its measured expected-to-runner-up ratio is **5.34** against the **5.66** the gate demands at τ = 2.5 (Appendix E.2), so the convention is accepted and reported but never spoken. This is the gate working exactly as designed on a borderline case, and it is recorded here because a threshold whose measured cases all fall on one side is untested: §9.4c.3 has real cases on both sides.

---
*End of specification v6. Anything not specified (helper naming, file decomposition, test layout beyond §22) is implementer's discretion within I1–I10 and P6.*
