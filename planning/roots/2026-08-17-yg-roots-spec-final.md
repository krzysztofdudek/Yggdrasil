# `yg roots` — Normative Field Engine

> SUPERSEDED by 2026-08-17-yg-roots-v6-spec.md (emergent architecture, prototype-synced).

## Consolidated Specification v5.2 (complete, self-contained)

**Status:** DESIGN-COMPLETE after four adversarial verification rounds, a final-gate audit, and an **empirical probe on seven real repositories** (validation report accompanies this spec); supersedes v1, the v2 resolutions, and the v3/v4 drafts **entirely**. Nothing is incorporated by reference: every surviving rule from earlier drafts is restated here in full (Appendices A, B, G carry the material previous drafts pointed at). An implementing agent needs no other design artifact.
**Audience:** an implementing agent (or engineer) with full access to the Yggdrasil repository but no access to the design conversation.
**Language of code and identifiers:** English. **Target runtime:** Node.js ≥ 22, TypeScript ≥ 5.5 (the host package's existing pins).
**Normative keywords:** MUST / MUST NOT / SHOULD / MAY per RFC 2119. Every numeric constant either carries a config key (§4.5) or is marked **fixed** here.

**Owner decisions (binding):** `roots` ships inside `@chrisdudek/yg` as the complete product — no experiment gate, no separate package. `roots` NEVER gates CI: every read surface exits 0 by default (§19); nonzero signaling is opt-in via `--exit-code`. Phases (§23) are risk-first; every phase lands components in final form.

---

## 0. One-paragraph summary

`roots` learns the unwritten conventions of a repository from its code and git history — no rules are written or approved — and enforces them at agent edit time through coding-agent hooks (Claude Code first). When an agent's edit deviates from how *this* repository does things, the hook returns a contrastive, example-backed explanation. When an edit is genuinely novel, `roots` stays silent, because silence falls out of repo-dependent conditions: no accepted convention covers the choice, or the scope's role is ambiguous. A reporting surface tracks consistency as a (coverage, debt) pair and generates normalization campaigns. Maintainers can seed the field with weighted, predicate-scoped golden exemplars — an audited, authored prior over an otherwise authorless statistical layer. The product instruments its own effectiveness: every intervention is logged, per-convention compliance is measured, and conventions agents ignore are automatically demoted.

---

## 1. Glossary (binding)

| Term | Definition |
|---|---|
| **Scope** | A code unit at granularity `method`, `type`, `file`, `module`. Scopes nest (§6.2). |
| **Predicate** | A named, typed, deterministic feature of a scope. Boolean (closed alphabet) or categorical (open alphabet with escape `⊥`). Carries a **family** (§7.5) and class `identity`/`behavior` (§7.1). |
| **Convention** | A (role, predicate) or (`_all`, predicate) pair accepted by the MDL criterion §9.4. Discovered, never declared. |
| **Role** | A cluster of `method`/`type` scopes induced from catalog-free, directory-free features (§8.1). `file` scopes take a derived role (§8.8b). |
| **`_all`** | The pseudo-role of every non-excluded scope of a partition; hosts partition-global conventions (§9.4b). Shadowed by role conventions for role members (§9.9). |
| **Preference gap Δ** | `log2(p̂(expected)/p̂(observed))` bits — the severity currency (§9.7). |
| **Witness** | A registered transform whose `servesPids` covers the deviating pid, producing the expected value at safety ≤ SAFE_WITH_TYPES (§10). No witness ⇒ **observation** (report-only). |
| **Speakable** | A convention that can actually produce hook messages: accepted ∧ hook-eligible ∧ `witnessLookup(pid, expected) ≠ null` (Appendix C; §16.2 counts coverage over speakable conventions only). |
| **Seed** | Maintainer-authored exemplar with extra weight for explicitly listed predicates; committed, audited (§17). |
| **Field partition** | Unit of role/convention computation: nearest package root (§6.7). |
| **`hook_shaped`** | Committed provenance mark: this (scope, predicate) reached its value because roots asked (§18.3). Weight-capped until independently ratified. |
| **`agentShare`** | Unsurvived-agent fraction of recent norm weight — a cohort composition diagnostic (§18.4), not a loop gain. |
| **Coverage / debt** | §16.2. Read as a pair; computed over speakable conventions so the numbers describe what the product can actually say. |

---

## 2. Principles, operationalized

**P1 — Convention = broken symmetry; novelty = the repo has not voted.** The space of enforceable choices is enumerable per language (Appendix B). Silence on novelty is produced by: no accepted convention covers the (role, predicate); or the scope's role is ambiguous (§8.5). The witness engine answers a narrower question — is there a safe mechanical way to conform (§10)? No safe witness ⇒ report-only. A **never-before-seen categorical value** is treated as semi-novel: it can be warned about (once, with a novelty note) but never denied (§9.7).

**P2 — The currency is the bit, spent twice.** A convention exists iff conditional coding beats the partition-level code on the convention's own instances, after paying parameter cost and the model-index cost `log2(C)` — the multiple-comparison control lives inside the formalism (§9.4). Severity is the preference gap Δ — a property of the contrast, not of sample size: no ceiling, no saturation.

**P3 — The norm is the survived stock; the attractor is advisory.** Hooks enforce only what is overwhelmingly established in the survived stock (`expected` = weighted argmax, guarded by a raw-count gate so displayed evidence always agrees — §9.4c). Trends serve reporting/campaigns and **standing down** (nucleation suppression, §9.6). Hooks never enforce a minority value; transition enforcement is structurally impossible, not merely disabled (Appendix E.5).

**P4 — Severity escalates with architectural reach.** DENY requires `arch_class`, calibrated precision (§14), high coupling (§9.8), and the daemon (§12.6). Everything else is at most WARN.

**P5 — The loop is regulated with shared state.** The committed `hook-ledger.jsonl` (§18.3) caps the weight of code that conforms *because roots asked*, on every machine and in CI, until survival plus genuinely independent human touch ratifies it. `agentShare` (§18.4) is the composition diagnostic; compliance telemetry (§18.1–18.2) demotes conventions agents ignore.

---

## 3. Product definition

### 3.1 Goals
G1 hook-time contrastive feedback (latency §20); G2 self-emerging conventions + authored seed priors (yg rules = written constitution; roots = read constitution; seeds = written priors over it); G3 reporting & campaigns (§16); G4 feedforward brief/scaffold (§15); G5 completeness checking (§13.4, Appendix G.4); G6 self-measurement with automatic demotion (§18).

### 3.2 Non-goals & honest scope
- No embeddings, no cross-repo field (reserved interfaces live as doc-commented TypeScript in `src/roots/ext/`; no plumbing), no NL artifacts, no network, no auto-refactors.
- **Hook-speech domain:** speech is **per-(pid, expected value)**: a convention can produce hook messages iff `witnessLookup(pid, expected) ≠ null` (Appendix C). Families are organizational; a speakable family can contain observation-tier pids (`guard_structure` speaks for `guard_clause_first` but not `try_wraps_all`), and a speakable pid can be mute for a particular expected value (`split_export_default_to_named` produces `named` only — an `expected = default` convention is observation-tier in that direction). Mined pids: `mined.name_suffix` is a single categorical pid served exactly by the rename transforms; `mined.imports.*` is a genuine pid-prefix pattern served by add/remove-import. Families with no witness-bearing pid at all: `error_style`, `test_framework`, `loc_band`, `misc_mined`, `co_change`, `nullability`, `data_shape` (and `async_shape` is effectively observation-tier under the default TS/JS language set — its only witness-bearing pid is `cs.async_suffix`). The report surface covers all predicates.

### 3.3 Invariants (binding)
- **I1 Fail-open:** any hook error ⇒ allow silently + incident record (§21.1). A broken roots MUST NOT block an edit.
- **I2a Model determinism:** given identical (HEAD SHA, dirty-file content hashes, merged-config hash, `seeds.jsonl` hash, `hook-ledger.jsonl` content hash, roots version), a full build (`index --full`) produces byte-identical model artifacts. Sorted iteration everywhere in model code (lint-enforced); clock = HEAD committer timestamp (§20.2); no surrogate ids in any hashed/exported artifact. The ledger hash is computed over the working-tree file content; `.yggdrasil/roots/**` files are excluded from `dirtyHash` (they are separately hashed inputs).
- **I2b Local modulation, declared:** hook *speech* is additionally modulated by machine-local state. Modulators MAY downgrade severity or silence; they MUST NOT upgrade. The complete modulator table: (1) session dedup + budgets (§11.2); (2) telemetry demotion (§18.2, via `demotions.json`); (3) staleness ⇒ DENY findings delivered as post-tool WARN with a staleness note (§12.7); (4) daemon-absent ⇒ same downgrade (§12.6); (5) bash-sweep `seedTruncated`/`floodSkipped` suppression (§12.4). `status` lists every active modulator.
- **I3 No network. I4 No exfiltration** — instrumentation is local files under the repo; nothing is transmitted.
- **I5 Silence on ambiguity:** role-ambiguous scopes get no role-conditioned messages; `_all` conventions still apply.
- **I6 Budgeted interruption** (§11.2).
- **I7 Three stores, three lifecycles** (§4.4): committed inputs; rebuildable cache (safe to wipe); durable local state (survives `index --full`; only `roots reset --state` clears it).
- **I8 Read-only toward source.** `init` writes only: `.yggdrasil/roots/config.json`, gitignore entries, `.claude/settings.local.json` (or `settings.json` with `--commit-hooks`), and the ledger file header — each enumerated in the confirmation prompt. Hooks append only to `.roots-state/` and `hook-ledger.jsonl`.
- **I9 Language-agnostic core:** everything outside `src/roots/adapters/**` language-independent; core transforms live in `predicates/` (§10.1).
- **I10 Yggdrasil-optional:** no graph, no problem. roots MUST NOT create or modify graph nodes, `yg-architecture.yaml`, or lock files.

### 3.4 User journeys (acceptance-level)
- **J1:** `npx yg roots init` on a mature TS repo → index within budget → hooks installed on confirmation → a session violating a mined speakable convention receives ≥ 1 correct contrastive warning; a session writing conforming or novel code receives zero messages (first Bash sweep seeds silently, §12.4). Verified by the mutation harness (§22.4) and live dogfood.
- **J2:** `yg roots report` → coverage/debt, top conventions, transitions, campaigns, convention health.
- **J3:** `yg roots seed add src/handlers/refund-handler.ts --pids ts.di_style,ts.logs_on_entry --weight 8 --note "target handler shape"` → posteriors shift for exactly those pids (seeds *nudge*: the pseudo-count cap means a seed cannot conjure a convention out of an empty cell — stated limitation, §17.1), decision entry written, tension surfaced if present.
- **J4:** repo with < 300 scopes or no git history → init succeeds, hooks install, system silent, `status` explains why.

---

## 4. Architecture & repository integration

### 4.1 Placement (verified against the real repo)
All code at **`source/cli/src/roots/**`** (a sibling of `source/cli` would silently escape the repo's typecheck/lint/coverage globs). Tests: `source/cli/tests/roots/**`, `tests/e2e/roots-*`, fixtures `tests/fixtures/golden/roots-*`.

Module map: `extract/ adapters/ predicates/ roles/ history/ norm/ witness/ calibrate/ verdict/ hook/ report/ seed/ store/ telemetry/ cli/ shared/` with responsibilities as named throughout this spec. CLI commands register in `src/bin.ts` like the existing ~22 commands; handlers load roots via dynamic `import()` — with `tsup` `splitting: false` this defers execution, not bundle parse; flipping `splitting` is a separate maintainer decision this spec does not require.

**Reuse contract.** MUST use: existing web-tree-sitter ^0.26 + `dist/grammars/` assets (TS/TSX/JS/C#/Python already ship), `ParseCache` + WASM tree lifecycle discipline, sha256 utils from `src/io/hash.ts`, `tests/support/git-fixture.ts` for git-touching tests. **New code (verified not reusable):** scope-granular extraction (relations extractors are file-level, single-line facts — reference only), the repo-wide `--name-status` walk + `cat-file --batch` client (`src/utils/git.ts` has two per-file helpers only, one using the forbidden `--follow`), the daemon (no socket precedent; `det-worker-pool` contributes the warm-up idea only).

**Host-repo obligation (budgeted in Phase 1):** the maintainer authors `yg-architecture.yaml` node types and the `model/cli/roots/**` node subtree during the Phase-1 design-lock step — never created programmatically (I10). The Phase-1 task list also includes extending `tests/support/git-fixture.ts` with a determinism block (§20.2) — a ~10-line helper change benefiting existing suites.

### 4.2 Data flow
1. `index`: extract → predicates → roles → history join → norm → calibrate → snapshot. Pure per I2a.
2. Hook: post-edit content → predicates for changed scopes (+ enclosing type + file) → role lookup → verdict §9.9 → protocol response. Hooks never mutate the model.
3. `report`/`campaign`/`seed`/`brief` read the same model.

### 4.3 Dependencies
`web-tree-sitter` ^0.26 (present), `zod` ^3 (new, pure JS). No storage dependency (JSON stores), no git library, no native modules, no ML/network/telemetry packages — MUST NOT add any.

### 4.4 The three stores (I7)

```
.yggdrasil/roots/                     # COMMITTED
  config.json  seeds.jsonl  decisions.jsonl  hook-ledger.jsonl

.yggdrasil/.roots-cache/              # GITIGNORED, rebuildable, safe to wipe
  model.json                          # string-keyed snapshot (Appendix D) — the model file the hook loads
                                      # (the hook additionally reads demotions.json and its session log from .roots-state/)
  scopes/<2-hex>.json  blobs/<2-hex>.json
  lifecycle.json  aliases.json  cochange.json  calibration.json
  roots.sock                          # daemon socket (runtime, not data)

.yggdrasil/.roots-state/              # GITIGNORED, durable; survives index --full
  telemetry.jsonl                     # retention: telemetryRetentionDays, compacted at index
  demotions.json                      # materialized §18.2 output; the hook reads this, never telemetry.jsonl
  debt.series.jsonl  incidents.jsonl  sessions/<id>.jsonl
```
Gitignore entries are added to the hardcoded list in `init-scaffold.ts` and propagate via `init --upgrade`. `model.json` header: `{rootsVersion, configHash, seedsHash, ledgerHash, headSha, lastIndexedSha, dirtyHash, clock, candidateCountLog2, rolesStale}` — **excluded from the snapshot content hash**.

**Writer concurrency (binding):** all cache writers (`index`, `init`, `calibrate`, the daemon's background reindex) take a single exclusive `.roots-cache/.build.lock` (O_EXCL, pid inside, stale after 15 min). The daemon **skips** its debounced reindex when the lock is held (retry on next debounce); CLI builds wait briefly, then fail with a what/why/next message naming the holder. Readers (hooks, `report`, `status`) never take the lock — `model.json`'s atomic rename gives them a consistent view; §18.2's demotions aggregation runs inside the lock with the snapshot write.

### 4.5 Configuration (complete; unknown keys ⇒ hard error; `configHash` = sha256 of merged canonical JSON)

```jsonc
{
  "version": 1,
  "languages": ["typescript", "javascript"],
  "include": ["**/*"], "exclude": [],
  "partition": { "mode": "auto" },
  "history": {
    "windowMonths": 24,               // effective walk horizon = max(windowMonths, 2*calib.horizonDays/30 + 2) months
    "maxCommits": 4000,               // applied AFTER the --since filter; if the cap truncates before c_split,
                                      // calibration is unavailable and status warns (§14)
    "megaCommitFileCap": 30,
    "churnEarlyDays": 14,
    "lifecycleFileMaxKb": 300, "lifecycleMaxAppearances": 200,
    "agentIdentities": ["claude","copilot","cursor","codex","devin","\\bbot\\b","gpt","gemini"]
  },
  "weights": {
    "survivalFullDays": 120, "freshPenaltyDays": 14,
    "agentBase": 0.15, "agentPromoteDays": 180,
    "baseFloor": 0.05,
    "hookShapedWeight": 0.15,         // cap applied LAST, after degraded modes (§9.1)
    "noLifecycleWeight": 0.3, "dirtyWeight": 0.3,
    "seedDefaultWeight": 8, "seedCapFraction": 0.5
  },
  "mdl": { "acceptMarginBits": 4.0, "minInstancesRaw": 5, "minInstancesEff": 3, "minedCap": 400 },
  "thresholds": {
    "preferenceGapBits": 2.5,         // τΔ default; calibration may only raise it (§14)
    "eligibilityMinRawShare": 0.6666666666666666,   // display-honesty gate on the SURVIVED raw share (§9.4c);
                                                    // fire-ability is the exact per-convention runner-up test, no key
    "denyExtraBits": 1.5, "denyMinPrecision": 0.9,
    "roleAmbiguityGap": 0.15, "roleMinMembership": 0.35,
    "couplingPercentileForDeny": 75
  },
  "calib": { "horizonDays": 365, "settleDays": 30,
             "minEventsConvention": 12, "minEventsFamily": 30, "minEventsDeny": 35,   // 35 = Wilson floor for LB95 ≥ 0.9 (Appendix E.7)
             "targetPrecision": 0.8 },
  "trend": { "windowDays": 90, "windowCount": 8, "attractorSlopeK": 2.0, "lowSampleMin": 8,
             "nucleation": { "minSlopePerQuarter": 0.02, "minWindows": 3, "minHumanAuthors": 2 } },
  "ledger": { "releaseStableDays": 90, "releaseMinDaysAfterMark": 14 },
  "budgets": { "maxMessagesPerResponse": 3, "sessionMaxWarnings": 12,
               "hookHardTimeoutMs": 900, "hookColdBudgetMs": 700, "daemonBudgetMs": 50,
               "bashSweepDebounceMs": 5000, "bashSweepMaxFiles": 5, "bashFloodThreshold": 20 },
  "health": { "minCompliance": 0.3, "minSamples": 8, "telemetryRetentionDays": 180, "agentShareAlarm": 0.85 },
  "completeness": { "mode": "stop-feedback-once", "minSupport": 8, "minConfidence": 0.75 },
  "seed_tension": { "minFc": 1.5, "minN": 10 },
  "report": { "topConventions": 20 },
  "hooks": { "claudeCode": { "postTool": true, "preTool": false,   // preTool default OFF until the daemon phase (§12.6)
                             "bash": true, "userPromptBrief": false, "stopCompleteness": true } },
  "roles": { "reinduceTouchedFraction": 0.05, "reinduceTouchedMin": 200 },
  "sessions": { "pruneDays": 7 },
  "daemon": { "idleExitMinutes": 30, "connectTimeoutMs": 25, "reindexDebounceSeconds": 30 }
}
```
Constants stated in prose as **fixed** (oversize limits §6.1, module rule §6.2, 300-scope partition floor §6.7, top-5 import segments and the 2-feature `_untyped` gate §8.1, N>6000 pre-bucket §8.3, top-3 labels/exemplars §8.6/§9.10, KT α = ½ §9.3, campaign tier multipliers and task size §16.3, agentShare's 120-day cohort window §18.4, incident FIFO 500 §21.1, T5's ≤ 5 items, hook `timeout` seconds §12.2, Wilson z = 1.96 two-sided §14, build-lock staleness 15 min §4.4) are deliberate non-config. `completeness.*` and `hooks.claudeCode.stopCompleteness` are read from Phase 3 on; `calib.*` from Phase 2 on (`init` runs calibration once it exists) — keys ship inert before their phase, and the §22.8 dead-key lint whitelists them until then.

---

## 5. Storage — three-store JSON layer

Canonical JSON (sorted keys, `\n`, UTF-8, shortest-round-trip number formatting), atomic writes (tmp + rename), 2-hex sharding by sha256 of the record key, `schemaVersion` per store with forward-only migrations. Every array sorted by natural string key. No surrogate ids.

**Sparse booleans.** Boolean predicates are stored only when `true`, with a per-predicate **applicability domain** declared by the extractor as a rule computable *without* evaluating the predicate. Example: `ts.has_abort_signal_param` — domain = "all `method` scopes in cleanly-parsed TS files"; `ts.logs_on_entry` — domain = "all `method` scopes with a body of ≥ 1 statement". Counting: `n_false(q, r) = |domain(q) ∩ members(r)| − n_true(q, r)`. A scope outside the domain contributes nothing (undecidable ≠ false). A property test asserts sparse counting ≡ dense counting on small fixtures.

**Reaping.** Every build enumerates current files and deletes store rows for missing paths. Renames from the walk write `aliases.json` (`old → new`, chains compressed); lifecycle, ledger, and calibration lookups follow aliases.

---

## 6. Extraction layer

### 6.1 Parsing
Existing web-tree-sitter + `ParseCache`, trees explicitly released. Oversize (> 1.5 MB / > 40k lines) ⇒ excluded. Parse errors ⇒ error-free subtrees only; root error ⇒ file granularity. Never abort (I1).

### 6.2 Scope model
`method`, `type`, `file`, `module`; one `file` scope per file; `module` = nearest of partition root or first directory with ≥ 3 code files; nesting method→type|file, type→file, file→module.

### 6.3 Stable identity
`stable_id = sha256hex(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ arity)[:16]` — full path including filename. Rename continuity via `aliases.json`, not identity weakening. Overloads beyond arity: `#k` by source order. Anonymous: `<anon>` + ordinal.

### 6.4 Normalization & hashing
`body_hash`: sha256 of the scope's token stream, comments stripped, literals kind-marked (`STR`/`NUM`), whitespace collapsed, identifiers kept. `signature_hash`: same over the signature region. `blob_hash`: sha256 of newline-normalized bytes. Repo hash utils throughout.

### 6.5 Incremental protocol
1. Enumerate (`git ls-files` ∪ untracked-not-ignored, filtered).
2. Unchanged (path, blob_hash) ⇒ skip; else reparse, diff scopes by stable_id, upsert/delete; reap missing files.
3. **History increment:** the walk resumes from the snapshot's `lastIndexedSha` (`git log lastIndexedSha..HEAD --name-status -M …`), appending commits, lifecycle updates, and value events; a full walk runs only on `--full` or when `lastIndexedSha` is unreachable (rebase). A HEAD change re-derives every partition's norm/trends/calibration (the clock enters the weights) but re-extracts nothing for unchanged files.
4. Predicates for touched scopes. Roles: re-induce the partition only when touched-since-last-induction > `max(reinduceTouchedMin, reinduceTouchedFraction × N)`; otherwise nearest-medoid assign touched scopes and set `rolesStale: true`.
5. A build whose full input tuple (HEAD, dirty hashes, config, seeds, ledger) is unchanged performs zero writes to `.roots-cache/` — a correctness statement (I2a), not an optimization.

**Budgets:** the ≤ 3 s incremental target (§20.1) applies to non-re-induction builds; a build that re-induces roles has its own budget (≤ 60 s at N = 6000). **I2a property test:** two `--full` builds byte-identical; an incremental build equals the full build after forcing `index --full` (differences before that are confined to `rolesStale`-flagged role artifacts).

### 6.6 Language adapter interface

```ts
export interface ScopeInfo { kind: 'method'|'type'|'file'; name: string; qualifiedName: string;
  startLine: number; endLine: number; signatureRange: [number, number]; node: Node }
export interface PredicateValue { pid: string; value: string }   // 'true' | category token
export interface PredicateDomain { pid: string; member(scope: ScopeInfo, fileCtx: FileContext): boolean }
export interface TransformCandidate {
  id: string;                          // unique; lexicographic tie-break key
  family: PredicateFamily;             // organizational grouping (§7.5)
  servesPids: string[];                // exact pids or pid-prefix patterns ('mined.imports.*') this transform can fix —
                                       // the witness join key (§10); family alone is NOT sufficient (a rename-to-case
                                       // transform cannot serve a suffix-role pid in the same family)
  resultingValue: string | '<expected>';
  safety: 'SAFE_SYNTACTIC' | 'SAFE_WITH_TYPES' | 'BEHAVIORAL_RISK';   // ordering: SYNTACTIC < WITH_TYPES < BEHAVIORAL_RISK
  describe(scope: ScopeSummary, expected: string): string }
export interface LanguageAdapter {
  id: 'typescript'|'javascript'|'csharp'|'python';
  extensions: string[];
  collectScopes(tree: Tree, filePath: string): ScopeInfo[];
  extractPredicates(scope: ScopeInfo, fileCtx: FileContext): PredicateValue[];   // MUST cover Appendix B
  predicateDomains(): PredicateDomain[];
  collectEdges(tree: Tree, scopes: ScopeInfo[], resolver: SymbolResolver): Edge[];
  transforms(): TransformCandidate[] }                            // language-specific transforms (Appendix C)
```
Core (language-independent) transforms — `move_file_to_dir`, `remove_upward_import`, `rename_file_to_case`, `rename_file_to_suffix` (ids verbatim from Appendix C) — are provided by `predicates/coreTransforms()`; `witnessLookup` unions core + adapter registries (I9). `SymbolResolver`: same-partition, name-based, ambiguous ⇒ no edge.

### 6.7 Field partitions (restated in full)
`auto`: a partition root is any directory containing a non-empty `package.json`, `*.csproj`/`*.sln`, or `pyproject.toml`/`setup.cfg`; nested roots win (closest ancestor). Files under no root ⇒ `_repo`. A partition ending with < 300 scopes merges into `_repo`. `single` forces one partition; manual mode lists glob roots. Roles/conventions/trends/calibration per partition; co-change repo-global.

---

## 7. Predicate system

### 7.1 Classes and circularity control
Every predicate is `identity` (what/where the scope is) or `behavior` (how it is written) — Appendix B column `class`. Role features (§8.1) use **no catalog predicate and no directory information**, so placement predicates are mineable per role without circularity. Residual semantic overlaps are handled by the **overlap table** (Appendix B column `overlap`): a (role, pid) candidate is skipped as `tautological` (visible in `explain`, never accepted) when the role's defining feature groups (§8.6) include the pid's overlap group. Overlap groups: `name-tokens` (↔ `mined.name_suffix`), `signature-shape` (↔ `ts.async_returns_promise`, `cs.async_suffix`, `py.async_def`), `import-segments` (↔ `mined.imports.*`, and ↔ `placement`/`layering` pids — import segments are restricted to **package (non-relative) specifiers** precisely so directory structure does not leak in through relative imports, and the overlap entry is kept as defense in depth). **Appendix B's `overlap` column is the authoritative membership map.** `_all` candidates are exempt (a partition-wide convention is not a role tautology).

### 7.2 Core vocabulary — full table in **Appendix B.1** (restated in this document, not referenced out). **`placement` pids (`core.dir_top`, `core.dir_layer`) are role-conditioned candidates ONLY — never `_all`**: a partition-level "expected directory" merely encodes the directory size distribution (verified empirically: on real repos `dir_top=test` at share 0.84 would instruct moving production files into tests). Placement speech is per-role by construction ("types shaped like handlers live under application/"). Deltas vs the v1 lineage: `core.module_fan_in_band` removed; `core.test_sibling` is family `co_change`, report-only by declaration (repo-global input, no history, no witness); **`core.dir_layer` and `core.dir_top` apply to `type` and `file` scopes** — value = the containing file's (or own) layer/top segment — so placement conventions can live on real type roles (the v3 file-only definition made them unhostable, since roles exist for `method`/`type`). `core.imports_layer_up` applies to `file`, `arch_class=1`, join-computed in history (§13.2). `arch_class=1`: `core.dir_layer`, `core.imports_layer_up`.

### 7.3 Mined predicates — generator restated in **Appendix G.2**: identifier suffix/prefix tokens, import-set tokens (package specifiers only), and the fixed structural label set emitted by adapters. All mined candidates pass §9.4; cap `minedCap` kept by descending bits-per-instance; `pidVocabHash` covers the mined vocabulary only (§13.2).

### 7.4 Extraction contract
Pure functions of (tree, fileCtx); no I/O; ≤ 3 ms per 1k LOC; booleans emit only `true` + domains.

### 7.5 Families (complete list — 22)
`naming_case, name_suffix, error_style, logging, di, async_shape, cancellation, member_order, export_style, import_style, imports_set, doc_comment, guard_structure, test_framework, placement, layering, file_naming, loc_band, misc_mined, co_change, nullability, data_shape`. **Speech is decided per pid** by Appendix C's witness table (§3.2, §10) — families group predicates and transforms for navigation, nothing more. Every pid belongs to exactly one family (Appendix B column `family` is the authoritative map).
---

## 8. Role induction

### 8.1 Feature bag F(s) — catalog-free, directory-free
Kinds `method`/`type` only:
- own-name suffix/prefix tokens (casing-boundary tokenization),
- declared supertype / interface names,
- signature-shape buckets: paramCount band (0|1|2|3+), returnsVoidLike, isAsync,
- top-5 **package-specifier** import segments of the containing file (relative imports excluded — §7.1),
- graph-context tokens: suffix tokens of direct callees and callers (one pass; caller tokens flagged as such — §8.8).

**`_untyped` gate:** a scope with fewer than 2 **discriminative** own features — name tokens ∪ supertypes only; signature buckets are total functions of every scope and would make the gate inert (`handle()` ⇒ `_untyped`; `formatDate(d)` with tokens {format, date} ⇒ typed) — goes to `_untyped_<kind>`. The gate exists to keep junk scopes from distorting medoids during clustering; §8.5 ambiguity is the per-scope backstop, not a substitute. **No `_untyped_*` role hosts role-conditioned conventions**; `_untyped` members still count in `_all`.

### 8.2 Distance
Jaccard on feature sets; all ties broken by `stable_id` lexicographic order.

### 8.3 Clustering & the MDL cut — honest complexity
Average-linkage agglomerative per partition per kind (N > 6000 ⇒ pre-bucket by dominant suffix token). Cut selection: minimize `DL(cut) = Σ_clusters Σ_{features PRESENT in the cluster} [optimal Bernoulli code + 0.5·log2(n_c) per parameter] + k·log2(N)` — the feature sum ranges over features present in the cluster, NOT all F (an all-F sum forces k = 1 and would decide the clustering by accident). Complexity, stated honestly: linkage is O(N²) (distance matrix + Lance–Williams; ~36 M Jaccard evals at N = 6000, inside the re-induction budget of §6.5, not the 3 s incremental budget); the cut search maintains per-cluster sparse count vectors, merge-smaller-into-larger ⇒ **O(N·F̄·log N)** total DL maintenance. A naive full-matrix re-encode per cut is a defect.

### 8.4 Medoids and the single classifier
Clustering and medoid selection use **full** feature bags (caller context helps discover clusters). Medoid = member minimizing summed distance (tie: stable_id). The **final reassignment of every scope — and every later classification, in build, `explain`, and hooks — uses own-features-only distance** (`F_own` = everything except caller tokens): one metric, one classifier, computable identically with and without the index, so build and hook can never disagree on the same content. One pass, final by definition. Empty clusters (possible only for duplicate feature bags) are dropped in medoid stable_id order; the drop is assignment-invariant. `medoidFeatures.callers` exists for reporting only. (The MDL cut selects k and the medoid set on dendrogram memberships; reassignment perturbs memberships — accepted; §8.7 measures whether the final roles earn their keep.)

### 8.5 Membership & ambiguity
`m1 = 1 − d(s, medoid1)`, `m2` second-nearest. Ambiguous iff `m1 − m2 < roleAmbiguityGap ∨ m1 < roleMinMembership`. Ambiguous scopes: counted in role cells weighted by `w(s,q) · m1` (rank-1 only; no rank-2 contribution), silent in hooks for role conventions; `_all` still applies. Weight-index table (binding): role-cell counts use `w(s,q)·m1` (plurality-assigned file scopes: `m1 = 1`); `_all` counts use `w(s,q)`; file-role plurality (§8.8b) uses `w_base`; trends use the provenance factor only (§9.5); `agentShare` uses `w_base`. Note the role/`_all` cells thus mix two weightings inside §9.4a's log-ratio — a declared plug-in estimate whose bias is absorbed by `param_cost`; do not "fix" it.

### 8.6 Role identity — content-derived per build
`role_key = sha256(sorted member stable_ids of the final assignment)[:12]`. No cross-build inheritance (deterministic per I2a). Defining feature groups of a role (for §7.1 overlap and §8.7): the top-3-lift feature groups of the cluster, recorded per role in the snapshot. Labels (display only): top-3 lift features. `report` prints a best-effort old→new continuity note for humans; nothing machine-consumed uses it. Cross-build continuity is unnecessary: trends and calibration are recomputed from history onto current roles each build; telemetry and the ledger key on (stable_id, pid).

### 8.7 Role quality — `role_lift`
Held-out set = behavior predicates **excluding** pids whose overlap group is among the role's defining feature groups (the overlap machinery of §7.1 — without this exclusion, import/async predicates that mirror clustering features would inflate the metric). `role_lift(r) = Σ_q [DL_partition(q on members(r)) − DL_role(q on members(r))] / n_eff(r)` — computed from the same counts as §9.4 in one pass. `role_lift ≤ 0` ⇒ the role is decorative: it contributes **no conventions and no shadows** — its members fall back to `_all` exactly like `_untyped_*` members (a model-level, deterministic demotion — distinct from §18.2's local one; shadowing by a role whose whole premise failed would silence `_all` and leave members with nothing).

### 8.8 Scope classification (build and hook — one rule)
**(a) method/type:** own-features-only nearest medoid (§8.4). Callee tokens are taken **syntactically** (suffix tokens of called identifiers in the file) on both sides and live in `medoidFeatures.own`; caller tokens are excluded from classification everywhere. At hook time features come from the post-edit parse; at build time from the index — identical inputs by construction.
**(b) file:** a file scope's role = plurality role of its `method`/`type` members, **at build from the index, at hook time from the same post-edit parse** (each member assigned per (a)) — the same rule in both places; ties broken by ascending lexicographic `role_key` over the tied roles; no members ⇒ `_untyped_file`. File scopes are never role-ambiguous (the plurality rule always resolves). `placement`/`file_naming`/`export_style`/`import_style`/`layering` conventions are therefore evaluable at hook time on file scopes, and `placement` additionally on `type` scopes (§7.2).

---

## 9. Norm model

### 9.1 Instance weights — per (scope, predicate)
Clock `now` = HEAD committer ts. With lifecycle row L (file-level Phase 1, scope-level Phase 2+):
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
Weight W contributes W pseudo-instances only for the listed pids, into rank-1 role cells and `_all`, capped at `seedCapFraction × n_eff_real` per cell (an empty cell stays empty — seeds nudge, they cannot conjure; stated in §17.1). Excluded from displayed fractions, raw-count gates, `agentShare`, trends. Messages append `(+seeded)`.

### 9.3 Posteriors — alphabets and smoothing
Per (role, predicate): **booleans are a closed alphabet** {true,false}, K = 2, no escape. **Categoricals:** the alphabet is the **partition-observed value set V** — carried per pid in the snapshot's `alphabets` block (Appendix D), never inferred from a role cell's counts (a role routinely observes fewer values than its partition; deriving K or ⊥-membership from cell counts gives wrong p̂ and false novelty claims) — plus escape: K = |V| + 1, `⊥ ⇔ observed value ∉ alphabets[pid]`. KT smoothing α = ½ throughout: `p̂(x) = (n_x + ½)/(n_eff + K/2)` (n_⊥ = 0; an in-alphabet value absent from the cell has n_v = 0 — numerically like ⊥ but NOT novel). `p̂_all` = the same posterior over the whole partition. Product policy for ⊥: WARN-max + novelty note (§9.7).

### 9.4 Convention acceptance — one baseline, one comparison
**(a) Role-conditioned** (r ∉ {`_all`, `_untyped_*`}), candidate (r, q), weighted role counts n_v (n_eff = Σ):
```
data_term  = Σ_v n_v · log2( p̂_r(v) / p̂_all(v) )        // code length saved ON r's OWN instances vs the partition-level model
param_cost = 0.5·(K−1)·log2(max(n_eff, 2))
index_cost = log2(C₂)
bits_saved = data_term − param_cost − index_cost
ACCEPT ⇔ bits_saved ≥ acceptMarginBits ∧ n_raw ≥ minInstancesRaw ∧ n_eff ≥ minInstancesEff
```
`n_raw` = real instances in the cell (seeds excluded). **C** = the number of (cell, pid) candidate pairs surviving `appliesKind` ∧ overlap-tautology ∧ `minInstancesRaw`, counted **once, repo-wide, before any scoring, never recomputed within a build**; `C₂` = C rounded up to the next power of two (flicker damping — an unrelated mined predicate cannot move a convention's threshold by more than the next doubling); `log2(C₂)` is recorded in the header as `candidateCountLog2`. **Ranking and the `minedCap` cull use `data_term / n_eff`** (mean per-instance log-ratio — n-stable strength); `bits_saved` is used for accept/reject only (it amortizes the fixed index cost and would otherwise let size impersonate strength and preferentially cull small-but-sharp mined conventions).
The **partition posterior `p̂_all` is the baseline** — not leave-role-out (a role that is most of its partition then scores ≈ 0 against itself instead of being graded against a near-empty remainder), and not uniform. Both candidate types are thereby scored on the same footing and the comparison of §9.4b-v3 vintage disappears: there is nothing to arbitrate, because a role convention is by construction the statement "conditioning on r beats the partition model *on r's instances*". Single-role partitions degrade gracefully: p̂_r ≈ p̂_all ⇒ data_term ≈ 0 ⇒ role candidates rejected, `_all` stands. `data_term` can be negative (it is a plug-in estimate — the difference of two KL terms — which is exactly why `param_cost` is charged explicitly); negative simply rejects.

**(b) Partition-global** (`_all`, q): baseline = uniform over `B = max(|V|, 2)` values — booleans always B = 2 (closed alphabet, §9.3), categoricals B = max(|V|, 2). The floor matters: with B = |V| literally, an all-true boolean or an all-kebab-case partition has |V| = 1 and data_term < 0 — the repo's most perfectly-followed conventions would be the only unmineable ones, and an agent breaking one would get silence. Escape stays out of the baseline (including ⊥ hands every predicate log2(K/B) free bits per instance — verified to accept a 50/50 coin flip at n = 55):
```
data_term = Σ_v n_v · log2( p̂_all(v) · B );   bits_saved = data_term − param_cost − index_cost;   ACCEPT as in (a)
```
Verified: 50/50 boolean → data_term = 0 ⇒ rejected at any n; clean boolean accepts at exactly n_eff = 21 (Appendix E.3-S3); the single-value cases accept and price deviations via ⊥ or the zero-count in-alphabet value.

**(c) Directionality & hook eligibility.** `expected = argmax_v n_v` (weighted). **Fallback-bucket values are never eligible as `expected`:** Appendix B marks per pid the values that mean "unclassified" (`other`, `none`, `mixed`); a convention whose argmax is a fallback bucket is a distributional fact, report-only (empirically load-bearing: real repos yield `file_name_style=other` at share 0.81, which would otherwise instruct an agent to "name files in the *other* style"). Hook-eligible iff BOTH:
1. **Fire-ability (exact, per convention, no config key):** `(n_expected + ½)/(n_runnerup + ½) ≥ 2^τ_c`, where n_runnerup = the largest non-expected weighted count in the cell. This is the finite-n condition for Δ against the *most common* deviation to reach τ — for booleans it converges to the ~0.85-share threshold of Appendix E.2; for categoricals it is strictly tighter than any fixed share gate. No eligible convention can be mute against the deviation that actually occurs (rarer values pass a fortiori).
2. **Display honesty:** the **survived raw share** ≥ `eligibilityMinRawShare` (2/3), where the survived raw population = real instances (seeds excluded), `age_days ≥ freshPenaltyDays`, and not unreleased `hook_shaped`. **Degenerate case (binding):** a convention whose survived population holds fewer than `minInstancesRaw` instances is **not hook-eligible** — 0/0 is never evaluated, a young repo or partition is silent until instances survive the fresh window, and with no git history at all (§21.1) every instance counts as unsurvived, so the whole hook surface is ineligible; `status` reports "K conventions withheld: no established instances yet" (this is how J4's promised explanation is delivered). This population — not the full raw count — is also what §11.1 displays, phrased "established {units}". Three consequences, each deliberate: (i) the displayed evidence always supports the instruction; (ii) a burst of fresh deviations cannot mute the **display gate** (fresh instances are outside the survived population — during a contested period the hook keeps defending the survived norm; gate (1) still sees fresh weight floored at `baseFloor`, so an extreme burst — on the order of 100 fresh deviants against 10 conformers — can mute: bounded, not impossible); (iii) evidence manufactured by roots itself (unreleased hook_shaped code) neither appears in the display nor props up eligibility — the ledger regulates raw counts, not only weights.
Acceptance is memoryless; near-margin flicker is visible in `explain` (margin distance printed) and damped by C₂ quantization and the weight floor.

**(d) Stability.** `stabilityDays` = days since the start of the earliest consecutive trend window (counting back from the latest) in which `expected` was already the plurality; absent trends ⇒ omitted from messages. Stored in the snapshot.

### 9.5 Trends
Windows: `trend.windowCount` consecutive windows of `trend.windowDays` days, ending at the clock. From value events (§13.2 — **introductions and changes**), `value_of(s, t)` = s's value at t. Per window W_i: `share_i(v) = Σ_{s existed at end(W_i)} prov_i(s) · [value_of(s, end(W_i)) = v] / Σ prov_i(s)` where `prov_i(s)` = 1.0 for a human-authored value, else `agentBase + (1−agentBase)·min(1, ((end(W_i) − event_ts)/86400)/agentPromoteDays)` — window-relative, so history does not shift as `now` advances. Windows with < `lowSampleMin` instances are excluded from slopes. Slope = OLS over shares, fraction units per quarter. Attractor = `argmax share_last(v) + attractorSlopeK·slope(v)` — **report-only**.

### 9.6 Nucleation — stand-down only
Minority value v of an accepted convention is nucleating when over the last `minWindows` non-low-sample windows: slope(v) ≥ minSlopePerQuarter ∧ v's instances were authored (introduction or change events) by ≥ minHumanAuthors distinct human author-hashes ∧ v ≠ expected. Effect: `suppressed_value = v` — the verdict skips deviations whose observed value is v. Report prints "transition in progress". Nucleation never changes `expected`; when v's weighted stock overtakes, argmax flips naturally.

### 9.7 Severity — preference gap
`Δ = log2(p̂(c.expected)/p̂(v))`; fire iff Δ ≥ τ_c (calibrated, else `preferenceGapBits`). Unseen categorical value (priced via ⊥): message carries a novelty note and severity is capped at WARN — a never-seen value is never denied (P1 humility; also bounds the log2(2n+1) growth of ⊥-surprisal from ever reaching DENY). Properties (Appendix E): Δ is invariant to K for the clean case (Δ_clean = log2(2·n_eff+1) at any alphabet), has no sample ceiling (90/10 → 3.17 bits at any n), and no dead band under the aligned eligibility gates.

### 9.8 DENY eligibility
ALL of: `arch_class` (or seed `--arch` on that pid); calibrated `WilsonLB95 ≥ denyMinPrecision` over ≥ minEventsDeny events (§14); Δ ≥ τ_c + denyExtraBits; observed value ∈ alphabet (never ⊥); coupling percentile ≥ couplingPercentileForDeny — coupling of a scope with no index edges (new/moved file) falls back to its alias predecessor's percentile, else the **median percentile of its module** — the module is derived from the path per §6.2 (`moduleOfFile` is a cache, not the source) and looked up in `couplingByModule`; a module absent from that map leaves the coupling gate unmet and the finding stays WARN; daemon available (§12.6). Otherwise WARN. **DENY availability is expected to be rare** (the calibration bar is high by design) and `status` states it explicitly; the audited alternative is `seed --arch`, which substitutes maintainer judgment for calibration on the named pids.

### 9.9 The verdict function (single source of truth)
```
function evaluate(scope, postEditFileCtx, channel): Message[] {
  role = assignRole(scope, postEditFileCtx)                  // §8.8a/b
  out = []
  for c in candidateConventions(scope, role) in (roleKey asc, pid asc) order:   // deterministic INPUT order;
                                                             // all ordering/truncation of OUTPUT is §11.2's alone
    // candidateConventions: appliesKind(c) == scope.kind; the scope ∈ domain(c.pid);
    //   role conventions of `role` — the role contributes NOTHING (no conventions, no shadows) when it is
    //   ambiguous for this scope, `_untyped_*`, or decorative (§8.7);
    //   plus `_all` conventions for pids not shadowed. Shadow set = pids of the contributing role's
    //   conventions; when the role contributes nothing, the shadow set is empty and all `_all` apply (I5).
    v = predicateValue(scope, c.pid, postEditFileCtx)
    closeIntervention(scope, c, v)                           // COMPLIANCE CLOSURE — see below; runs before any skip
    if !c.hookEligible: continue                             // §9.4c ∧ §8.7 ∧ §14 (model-level, in snapshot)
    if locallyDemoted(c): continue                           // §18.2 demotions.json (I2b)
    if v == null or v == c.expected: continue
    if v == c.suppressed_value: continue                     // §9.6
    Δ = log2(p̂_c(c.expected)/p̂_c(v))                        // posteriors from snapshot counts + alphabets (App D)
    if Δ < τ(c): continue
    W = witnessLookup(c.pid, c.expected); if W == null: continue   // §10 — keyed on (pid, expected); none ⇒ OBSERVATION → report only
    sev = denyEligible(c, scope, Δ, v) ? DENY : WARN
    sev = channelFilter(channel, sev)                        // table below; null ⇒ skip
    if sev == null: continue
    out.push(render(sev, c, Δ, W, exemplars(c)))
  return applyBudgetsAndDedup(out)                           // §11.2
}
```
**Channel table (complete):** `pre` → DENY passes, WARN dropped (never raised pre-tool). `post`, `bash`, `stop`, `generic` → WARN passes; DENY is **downgraded to WARN** with the note "(blocking unavailable on this path)" (I2b: downgrade or silence, never upgrade — this covers Bash-path arch violations, stale/daemon-less operation, and the campaign oracle, whose `zero findings` acceptance counts downgraded findings as findings).
**Compliance closure (`closeIntervention` — the step that makes §18 real):** fold the session log for an open intervention on `(stable_id, pid)`. If one exists and `v == c.expected`: append `observedAfter` to `telemetry.jsonl` **and** the `{stable_id, pid, date}` mark to `hook-ledger.jsonl` (§18.3). If one exists and `v` still deviates: append `observedAfter` with the unchanged value (an *ignored* sample). Closure emits no message and is exempt from §11.2 budgets. Without this step no compliance is ever recorded, nothing demotes, and the ledger regulator never engages — it is load-bearing, not instrumentation garnish.
The runner evaluates changed method scopes, their enclosing types, and the file scope (deduplicated).

### 9.10 Exemplars
Members with observed == expected ranked by `w(s,q)·m1·centrality` (in-degree normalized; ties by stable_id), top-3 as `path:line#name`; re-validated at render (reaped scopes never render).

---

## 10. Witness engine
**Lookup (pid-keyed):** core ∪ adapter transforms with `c.pid ∈ servesPids (patterns expanded) ∧ (resultingValue ∈ {c.expected, '<expected>'}) ∧ safety ≤ SAFE_WITH_TYPES` — family alone is NOT a join key (a family can hold pids its transforms cannot serve: `rename_file_to_case` cannot fix a suffix-role deviation, `add_entry_log_call` cannot inject a logger member). No universal fallback. Pids no transform serves are observation-tier; Appendix C's per-pid table is binding. Ranking: (safety asc — SYNTACTIC < WITH_TYPES —, id lexicographic); top candidate rendered; no cap needed (per-pid candidate sets hold 1–3 entries).

---

## 11. Messaging

### 11.1 Template (T1; full catalog Appendix A)
```
[roots] {ROLE_LABEL|repo-wide} convention: {HUMAN_PREDICATE_PHRASE}
In this repo, {n_conform}/{n_total} established {unit_plural} {expected_phrase}{seed_note}
(stable for {stability_period}).
Your {scope_kind} `{scope_name}` {observed_phrase}{novelty_note}.
Suggested fix: {witness_description}
Exemplars: {p1}:{l1} `{n1}`, {p2}:{l2} `{n2}`
```
`{n_conform}/{n_total}` = the **survived raw population** of §9.4c ("established" = in the repo ≥ freshPenaltyDays, not seeded, not unreleased hook_shaped) — by the §9.4c gate these always support the instruction. `{unit_plural}` from appliesKind: methods/types/files. `{expected_phrase}`/`{observed_phrase}` compose as `{Appendix B phrase} = {value}` unless the row supplies a nicer form. `{stability_period}` from `stabilityDays` ("{n} months"), omitted when absent. `{novelty_note}` = " (a value this repo has not used before)" for ⊥-priced values. `{seed_note}` = " (+seeded)" when §9.2 applies, else empty. No transition text renders in hooks (T3 is report-only).

### 11.2 Dedup & budgets (the one ordering/truncation authority)
Dedup key `(stable_id, pid, direction)` where direction = the `(expected, observed)` pair — **WARN-tier only, once per session**. **DENY findings are never deduplicated**: a block a retry defeats is not a block; repeated denies are naturally rate-limited because the denied edit never lands. Dedup and budgets read the **post-`channelFilter`** severity: a DENY downgraded to WARN on a non-pre channel is a WARN for both purposes. Per response ≤ `maxMessagesPerResponse`, ordered (severity desc, Δ desc, pid asc). Per session ≤ `sessionMaxWarnings` WARNs; then DENY only. Enforced from the session event log; overshoot bounded by concurrently in-flight hook processes (documented).

### 11.3 Session state — append-only
`sessions/<id>.jsonl`, O_APPEND, one event per line; state = fold. Session id: sha256 of payload `session_id` when present; fallback `sha256(ppid ∥ cwd ∥ ppid-start-time)[:12]` (ppid start from `/proc/<pid>/stat` on Linux, `ps -o lstart=` elsewhere; last resort ppid∥cwd∥UTC-day — permissible, session identity is I2b local state, only the model path bans wall clock). Prune at mtime > `sessions.pruneDays`.

---

## 12. Hook runtime

### 12.1 Entries
`yg roots check --hook <claude-pre|claude-post|claude-bash|claude-stop|generic>`; `yg roots daemon start|stop|status`.

### 12.2 Claude Code protocol
Installed by `init` after showing the exact JSON, into `.claude/settings.local.json` (default) or `settings.json` (`--commit-hooks`); the local-vs-committed asymmetry is stated at install (teammates/CI unhooked until they init — the committed ledger still regulates the model everywhere). The PostToolUse Edit/Write entry installs iff `hooks.claudeCode.postTool`, the Bash entry iff `hooks.claudeCode.bash`. Commands are absolute invocations recorded at init; `doctor` probe-executes every installed hook (a silent ENOENT fail-open is the worst failure mode).
```jsonc
{ "hooks": {
  "PreToolUse":  [{ "matcher": "Edit|Write", "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-pre", "timeout": 5 }] }],   // installed ONLY when hooks.claudeCode.preTool=true (daemon phase)
  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-post", "timeout": 10 }] },
                  { "matcher": "Bash",       "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-bash", "timeout": 10 }] }],
  "Stop":        [{ "hooks": [{ "type":"command", "command":"<abs> roots check --hook claude-stop", "timeout": 10 }] }] } }
```
- `claude-pre` (DENY only): **first** probes the daemon socket; on failure exits 0 immediately (no parsing, no model load — a pre hook that cannot deny must cost nothing). With the daemon: reconstruct post-state (Write: content; Edit: apply old→new honoring `replace_all`, abort to fail-open on absent/non-unique `old_string`); DENY ⇒ `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason": MSG}}`.
- `claude-post`: reads the file from disk. Findings ⇒ `{"decision":"block","reason": MSG}`; else silent.
- `claude-bash`: §12.4. `claude-stop`: honors `stop_hook_active`; completeness (Appendix G.4) once per session; runs the deferred sweep summary (§12.4).
- `generic`: request `{files:[{path,newContent}], sessionId?, channel?}` (channel defaults to `generic`) → response `{verdicts:[{path, scopeKind, scopeName, line, pid, expected, observed, severity, deltaBits, message}]}` — the campaign oracle and the exact-JSON fixture surface (§22.7). **Reconstruction ownership:** the short-lived hook process (which has the stdin payload and the on-disk content) performs all Edit reconstruction and transmits `newContent`; the daemon is a pure evaluator and never reads tool payloads.

### 12.3 Severity → channel
DENY ⇒ pre-tool deny (rare, arch-class, daemon-backed). WARN ⇒ post-tool feedback (Edit/Write, Bash sweep, Stop summary). OBSERVATION ⇒ report only. The complete mapping, including downgrades, is §9.9's channel table.

### 12.4 Bash coverage — content hashes, seeded first, flood-safe
Session `fileState: {path → contentHash}`. **The first sweep seeds fileState from the paths listed by `git status --porcelain -uall` — never by hashing the whole tree — and emits nothing** (pre-existing dirt is not the session's doing); if the listing exceeds `bashFloodThreshold`, seeding truncates by path order and sets `seedTruncated`, which suppresses messages for unseeded paths for the whole session. Subsequent sweeps: debounce `bashSweepDebounceMs` (a skipped sweep needs no queue — the next sweep's hash diff subsumes it); porcelain listing → hash listed paths → diff against fileState; evaluate ≤ `bashSweepMaxFiles` changed code files, update fileState. > `bashFloodThreshold` changed in one sweep ⇒ skip per-file work and set `floodSkipped`. **The Stop summary runs iff `floodSkipped` was set**, evaluates the session diff against the **first-sweep** fileState once, and reports ≤ `maxMessagesPerResponse` top findings; with fileState unset (Edit-only session) it is a no-op. Bash-path violations are WARN-only (§9.9 channel table) — and therefore file *moves* (`mv`, `git mv`) are structurally WARN-only: pre-tool blocking of moves would require a Bash command-parsing PreToolUse matcher, which is out of scope by decision.

### 12.5 Latency budgets (p95; CI gates on ratios vs baseline)
daemon ≤ `daemonBudgetMs` (50) · cold in-process ≤ `hookColdBudgetMs` (700) · bash sweep ≤ 1.5 s · hard deadline `hookHardTimeoutMs` (900) via cooperative checks between stages (parse → predicates → role → verdict → format); sync work is uninterruptible, so the largest stage bounds overshoot.

### 12.6 Daemon (Phase 3; precondition for DENY)
Socket `.roots-cache/roots.sock` (Windows named pipe); preloads grammars + model.json; serves the generic protocol (with `channel`); idle exit `daemon.idleExitMinutes`; connect probe `daemon.connectTimeoutMs` (25 ms — a 5 ms probe fails intermittently on loaded machines and every probe timeout writes one incident, so a silently disarmed DENY is visible in `doctor`); stale socket unlinked on ECONNREFUSED; version handshake (mismatched rootsVersion/snapshot ⇒ CLI kills daemon, falls back). **The daemon watches HEAD (debounced `daemon.reindexDebounceSeconds`) and reindexes in the background, so DENY stays armed across commits; without a daemon the model goes stale at the first commit and stays stale until `index` runs — a stated limitation of daemon-less operation.** `preTool` flips on only when init detects a running daemon (or `--enable-pretool`). DENY findings while the daemon is unavailable surface post-tool as WARN (§9.9).

### 12.7 Staleness
Compares `(headSha, configHash, seedsHash, rootsVersion)` **only** — `ledgerHash` and `dirtyHash` are header provenance for I2a, NOT staleness inputs (the ledger grows by design mid-session; the tree is dirty by definition during editing; making either a staleness input would disarm DENY the moment the product works). Stale ⇒ hooks run on the stale model, DENY downgrades per I2b, `status` shows stale. Snapshot missing ⇒ silent allow + one incident.

---

## 13. History layer

### 13.1 Commit walk
One `git log --format=… --name-status -M -n {maxCommits} --since={effective horizon}` (first-parent order recorded; rename detection explicit via `-M`), streaming. Per commit: SHA, committer ts, author-hash (sha256 of name∥email), author kind (agentIdentities regexes vs author or Co-Authored-By trailers), fix classification (Appendix G.3), A/M/D/R records. Merge commits: timestamps only. `--follow` is forbidden in roots. Blob reads via one `cat-file --batch` child.

### 13.2 Blob predicate cache & value events
Key: `sha256(blob) ∥ extractorVersion` for core+adapter pids; mined-pid results stored in a parallel record keyed `sha256(blob) ∥ extractorVersion ∥ pidVocabHash` — a mined-vocabulary change re-extracts **only** mined predicates, preserving "each blob parsed at most once, ever" for the expensive part. Records: `[{localKey: kind∥qualifiedName∥arity∥ordinal, body_hash, predicates}]`; stable_id derived at join time from the historical path. Predicate history classes: blob-local (most), path-derived (`placement`, `file_naming` — joined from historical paths), join-computed (`core.imports_layer_up` — blob import list + historical target paths, best-effort), repo-global (`co_change` — no history, excluded from trends/calibration by declaration).
**Value events** per (stable_id, pid): **introduction events** (first blob containing the scope; author = that commit's author — without these, values adopted in new code are invisible and nucleation could only see retrofits) and **change events** (consecutive-blob diffs). Each: `(commit_ts, value | old→new, author_hash, author_kind)`. Events feed trends, nucleation, calibration, scope lifecycle.

### 13.3 Lifecycle
Phase 1 file-level from the walk alone: `{first_seen, last_modified, modifications, author_kind, last_human_commit_ts, churned_early ≤ churnEarlyDays, fix_touches}`; scopes inherit. `author_kind` = the kind of the **most recent non-merge touch** (a file touched by both humans and agents is classified by its latest author — stated because this choice drives `w_prov` for the whole model). `last_human_commit_ts` = the newest human-authored non-merge commit touching the file (consumed by §18.3's release rule). Phase 2 refines per scope from value events + body-hash changes (file row remains the fallback). Guards: files > `lifecycleFileMaxKb` or > `lifecycleMaxAppearances` walk appearances stay file-level. Phase 1→2 is a refinement; release notes state borderline conventions may shift.

### 13.4 Co-change & completeness — full algorithm restated in **Appendix G.4**.

---

## 14. Calibration
Purpose: per-convention τ_c (may only **raise** the default) and the DENY precision gate. Where data is insufficient, defaults stand and DENY stays off (`status` says so).
- **Split:** first-parent chain from HEAD; `c_split` = first commit with ts ≤ now − horizonDays. History < 2×horizon, or the `maxCommits` cap truncating the walk before `c_split` ⇒ **calibration unavailable** (never silently mis-split); `status` warns. Shallow clone ⇒ unavailable (§21.1).
- **Reference stats:** per current convention, the posterior over instances existing at `c_split` with their values as of `c_split` (from value events; aliases resolved for renames). Conventions failing acceptance on those past counts are skipped (no look-ahead). Scopes deleted since `c_split` are absent from current roles and thus excluded — a stated survivorship bias, acceptable because calibration only *tightens* thresholds.
- **Events:** value events in `(ts(c_split), now − settleDays]` on convention pids where new value ≠ expected, excluding `hook_shaped`-marked pairs (no calibrating on our own echo). `Δ_past` from reference stats.
- **Labels:** positive ⇔ a later event (≤ now) restores expected on the same stable_id (aliases followed); scope deleted ⇒ event excluded; else negative. A repair-rate proxy that undercounts precision on unrevisited code — which is exactly why calibration can only raise τ and why WARN does not require it.
- **Selection (Wilson z = 1.96, two-sided — fixed).** Grid = distinct observed Δ_past values ascending. τ_c = smallest grid value ≥ default such that the **point-estimate** precision over events with Δ_past ≥ τ is ≥ targetPrecision **and** ≥ `minEventsConvention` events remain at that τ. The point estimate — not a lower bound — selects τ: WilsonLB95 at n = 12 is ≤ 0.758 even for a flawless 12/12, so a lower-bound rule would demote nearly every convention that accumulates evidence — *usage would cause muting*, inverting the section's purpose (Appendix E.7). **Demotion to report-only happens only on evidence of badness:** `WilsonUB95(precision) < targetPrecision` at every grid τ — the upper bound must exclude the target before a convention is silenced; failure to *prove* goodness never demotes. Events < minEventsConvention ⇒ family pool (same point-estimate rule, ≥ minEventsFamily); a family pool with no qualifying τ **falls through to the default τ** — family-level evidence is too coarse to condemn a specific convention. **DENY** alone uses the lower bound: WilsonLB95 ≥ denyMinPrecision over ≥ minEventsDeny (35 — the arithmetic floor: LB95 of a flawless record reaches 0.9 first at n = 35; one failure pushes the requirement to 53).
Deterministic (pure function of walk + events + current model); cost: one filtered pass over value events.
---

## 15. Feedforward
**`brief --path <p> [--intent "<t>"]`:** ≤ 40 lines — roles nearby, top-5 speakable conventions each (phrase, survived-raw fraction, transition note), 2 exemplars per role, active nucleations. `--intent` matching is a fixed token heuristic (intent tokens ∩ path tokens of co-change partners — no NL processing beyond tokenization); its quality is explicitly best-effort and further refinement is implementer's discretion. Standalone or via `UserPromptSubmit` `additionalContext` when `hooks.claudeCode.userPromptBrief` is true.
**`scaffold --role <label|path> --name <Name>`:** rank-1 exemplar, bodies elided to `// TODO`; the exemplar's **own name and its casing variants** are renamed to `<Name>` case-matched (derived locals are implementer's discretion); conventional members kept. stdout only (I8).

## 16. Reporting & campaigns

### 16.1 `report [--json|--md]`
Header (partition, snapshot stamp, agentShare) · coverage/debt (§16.2) with module breakdown + series · top-`report.topConventions` **hook-eligible** conventions by bits/instance (`data_term/n_eff`) with survived-raw fractions + exemplars, followed by a separate **distributional facts** section (accepted but ineligible: minority-argmax and fallback-bucket cases — empirically these dominate raw bpi rankings, e.g. suffix distributions at share 0.07–0.28, and must not crowd out actionable conventions) · per-dimension modes with sparklines, stock vs attractor, nucleation flags · observation-tier top-10 · role_lift table with decorative flags · seeds + tensions · calibration summary (events, τ overrides, report-only demotions, DENY availability) · convention health (§18.2) · tautological-candidate count.

### 16.2 Coverage & debt — over speakable conventions
Cell set: pairs (scope, family) where the scope is a non-ambiguous method/type/file scope (modules excluded) **and** the family contains ≥ 1 pid with `scope.kind ∈ applies(pid) ∧ scope ∈ domain(pid)` — without the applicability restriction, file-only families counted against every method would deflate coverage by table shape rather than repo behavior. A cell is **governed** iff a speakable convention (accepted ∧ hook-eligible ∧ `witnessLookup(pid, expected) ≠ null` — the §9.4c fire-ability gate guarantees Δ reaches τ against the runner-up deviation, and rarer values a fortiori) applies via the scope's role, or via `_all` unshadowed. `coverage_role` = governed cells with role conventions / all cells; `coverage_all` counts `_all` too. Headline = `coverage_role` — `_all` conventions saturate `coverage_all` in any repo with one global norm, so it is reported but never the headline (a chaotic repo shows `coverage_role ≈ 0`). `debt` = Σ Δ over deviant real instances of speakable conventions; reported total and **per instance** (the comparable number).

### 16.3 `campaign [--export tasks.jsonl]`
Backlog = deviant real instances of speakable conventions (`witnessLookup(pid, expected) ≠ null` — the export's `transformId` is that lookup's result, so no task can carry an undefined transform). Score = `Δ × tierMult(1.0 SYNTACTIC / 0.7 WITH_TYPES) × (test_sibling ? 1.0 : 0.6) / (1 + log2(1 + coupling))`. Tasks ≤ 10 instances by (convention, directory), ordered by Σ score. Export: `{taskId, conventionPhrase, expected, transformId, transformDescription, instances:[{path,line,scopeName,deltaBits}], exemplars, acceptance:"yg roots check --hook generic reports zero findings for these scopes"}`. Campaigns MAY target a nucleating value (`transition: true`, both directions costed); hooks remain stock-only.

## 17. Seeding & governance
**17.1 CLI:** `seed add <path[:line]|query> --pids <list>` (required; pid-scoped by design) `[--weight N (default weights.seedDefaultWeight)] [--arch] [--note]`; `seed list`; `seed rm <id>`. Limitation stated: seeds *bend* existing statistics (cap `seedCapFraction × n_eff_real`); they cannot create a convention where no real instances exist.
**17.2 `seeds.jsonl`:** `{seedId: sha256(scopeStableId∥author∥ts)[:16], scopeRef:{path, qualifiedName}, pids, weight, arch, note, author, createdAt}`.
**17.3 Resolution & tension:** resolve at build (unresolved ⇒ warning). Tension per **listed pid only**: `fc = P(fix_touches>0 | value=v) / P(fix_touches>0)` over role members; record when `fc ≥ seed_tension.minFc ∧ n ≥ seed_tension.minN`; stored in the snapshot's seed section; printed in report and at `seed add`.
**17.4 Audit:** every seed/config change appends to committed `decisions.jsonl`. No graph mutation ever (I10). Optional mirror: adopter creates a node themselves and sets `decisionLogNode`; roots then also appends prose entries via the log's real API.

## 18. Telemetry & loop regulation
**18.1 Intervention log** (local): every message ⇒ `{sessionId, ts, stable_id, pid, expected, observed, severity, deltaBits}` to `telemetry.jsonl`; subsequent same-session observation of the same (stable_id, pid) ⇒ `{…, observedAfter}`. Role-free keys. Retention `telemetryRetentionDays`, compacted at `index`.
**18.2 Convention health & demotion** (I2b): aggregation runs **in the same transaction as every snapshot write** (any build that can change membership or role_keys — including incremental ones) and at `report`/`status`; never in hooks. Output `demotions.json`, stamped with the snapshot content hash — the hook ignores a stale stamp (fail-open toward speech being *possible*; a lost demotion resurrects a convention, never falsely silences one). Events pooled per (role_key, pid) via current membership, **filtered to events whose recorded (pid, expected) matches the current convention** (expected-flips must not poison the pool). Resolved = has observedAfter (complied/ignored); unresolved excluded from the denominator. **Cross-session closure:** the aggregation pass also closes interventions left open by ended sessions — if the current index shows the (stable_id, pid) at `expected`, it records a **complied** sample and appends the §18.3 ledger mark (same dedupe); if the pair still exists and deviates, it records an **ignored** sample; if the scope is gone, the intervention is dropped. Without the ignored branch the dominant real path — agent warned, moves on, session ends — would never enter the denominator, compliance would be biased high, and precisely the conventions agents ignore would never demote. Demote when WilsonLB95(compliance) < minCompliance with ≥ minSamples resolved. Slow accumulation acknowledged: demotion is the safety valve; quality is carried by acceptance + eligibility + calibration.
**18.3 `hook-ledger.jsonl`** (committed; the P5 regulator): on a complied intervention the hook appends `{stable_id, pid, date}`. Committed so regulation binds every machine and CI. Effect: weight cap (§9.1). **Release** (evaluated at build; the line remains for audit): `stable_days ≥ releaseStableDays` **and** ∃ a human-authored non-merge commit touching the file with `ts ≥ markDate + releaseMinDaysAfterMark` — the gap requirement exists because the commit that lands the hook-shaped code is routinely human-authored and must not self-ratify. Marks older than the walk horizon: cap persists (conservative). Merge semantics: union; dedupe on (stable_id, pid, date); malformed lines skipped (I1); a dirty ledger in git status is expected ("roots records that it shaped this code — commit it with your change"). Marks for reverted edits simply never release (harmless: the value they capped is gone).
**18.4 `agentShare`:** Σ base(agent-authored, stable_days < agentPromoteDays)/Σ base over scopes first seen in trailing 120 days (fixed) — composition diagnostic; alarm ≥ `health.agentShareAlarm` prints T7; `status --exit-code` exits 3.

## 19. CLI reference
| Command | Effect | Exit |
|---|---|---|
| `init` | detect, write config+gitignore+ledger header, full index+calibrate, offer hooks (shows JSON; `--yes`, `--commit-hooks`, `--enable-pretool`) | 0/1 |
| `index [--full]` | incremental / full | 0/1 |
| `status [--exit-code]` | freshness, counts, agentShare, degraded modes, active I2b modulators, DENY availability, and "K conventions withheld: no established instances yet" (§9.4c degenerate case — the J4 explanation) | 0 (with flag: 2 stale, 3 alarm) |
| `check [--hook …] [--exit-code] [paths…]` | evaluate. Non-hook mode: channel `generic`; scope set = scopes whose `body_hash` differs from HEAD, plus enclosing types and file scopes; `[paths…]` restricts to those files and, when given, evaluates **all** scopes in them | 0 (with flag: 4 findings) |
| `explain <path[:line]>` | role, memberships, all conventions with values/Δ/margins, tautological skips | 0 |
| `calibrate [--json]` | recompute `calibration.json` from the current cache (requires fresh index, else exit 1 with the message to run `index`) | 0/1 |
| `report / campaign / seed / brief / scaffold` | as specified | 0/1 |
| `daemon start\|stop\|status` | §12.6 lifecycle | 0/1 |
| `reset --cache\|--state\|--all` | wipe named store(s); `--state` and `--all` list what is lost (telemetry, demotions, debt series, sessions) and require confirmation or `--yes` | 0/1 |
| `doctor` | grammars, store integrity, hook probe-execution, socket, double-`--full` determinism, incident review | 0/1 |
All read surfaces exit 0 by default (owner decision); `--json` on read commands; `--cwd`; `--partition`.

## 20. Performance & determinism
**20.1 Targets** (reference machine Appendix G.5; CI gates ratio vs baseline +30%): full index+history+calibrate 500k LOC / 2k commits ≤ 20 min (of which walk+blobs+extraction ≤ 15); incremental 10 files ≤ 3 s (non-re-induction); re-induction build ≤ 60 s at N=6000; daemon 50 ms / cold 700 ms p95; build RSS ≤ 1.5 GB; hook RSS ≤ 200 MB. (`maxCommits` default 4000; the stated budget scenario is 2k.)
**20.2 Determinism:** clock = HEAD committer ts, read once; sorted-iteration lint; sha256; snapshot hash excludes header; `doctor` double-build check. Golden fixtures: **the roots fixture builder supplies** `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (…Z forms), `TZ=UTC`, `-c init.defaultBranch=main` — `tests/support/git-fixture.ts` today provides identity+isolation only; extending it with a determinism block is a named Phase-1 task (§4.1). Fixtures committed as builder scripts **and** `git bundle`s, with a CI job asserting builder ⇒ bundle equivalence.

## 21. Failure policy, exclusions, security
**21.1 Fail-open (I1):** any hook throw ⇒ protocol-appropriate allow + incident (`.roots-state/incidents.jsonl`, FIFO 500 — durable store: doctor audits it; wiping the cache must not erase the audit trail); store corrupt ⇒ degraded + doctor rebuild; grammar load failure ⇒ language disabled for session; git unavailable/shallow ⇒ flat weights, no calibration, completeness off.
**21.2 Path safety:** hook paths realpath-inside-repo or ignored (one incident/session); no symlink escape.
**21.3 Built-in exclusions (full, binding):** `**/node_modules/**, **/bin/**, **/obj/**, **/dist/**, **/build/**, **/out/**, **/.git/**, **/vendor/**, **/*.min.*, **/*.g.cs, **/*.designer.cs, **/*generated*/**, **/__pycache__/**, **/migrations/**` — migrations excluded from conventions, still counted in co-change. Merged with config `exclude`.

## 22. Testing & acceptance (items are cross-referenced as §22.N)
1. **Unit:** every Appendix B row (table-driven — the adapter acceptance contract); domains; MDL math against Appendix E (E is the fixture source and MUST be regenerated by script, not by hand — `source/cli/tests/fixtures/derive-e.ts` computes every E number from §9 formulas with one presentation convention and the doc is asserted against it); weights (clamps, degraded modes, ledger cap-last); trends/nucleation incl. introduction events; fire-ability/eligibility gates; pid-keyed witness lookup incl. servesPids patterns; templating; protocol encoders; store canonicalization; ledger merge semantics.
2. **Property:** double-`--full` determinism; incremental ≡ full per §6.5; fail-open under stage-fault injection; sparse ≡ dense counting.
3. **Golden repos:** `roots-{ts-handlers,csharp-cqrs,python-services}` with deterministic scripted histories (§20.2); `expected.json` lists MUST-mine (role pattern, pid, expected, min bits/instance) and MUST-NOT-mine (incl. tautology assertions).
4. **Mutation harness** (exact verdicts): `remove_entry_log`⇒WARN · `rename_break_suffix`⇒WARN · `swap_error_style`⇒OBSERVATION · `create_file_in_wrong_layer`⇒DENY **with an injected `calibration.json` fixture** (a `Write` — genuinely pre-tool-deniable; file *moves* are structurally WARN-only per §12.4, and the real calibration path is tested by the replay harness) · `retry_denied_edit`⇒DENY again (dedup must not cover DENY) · `direct_new_instead_of_di`⇒WARN · `drop_cancellation_param`⇒WARN · `novel_scope_no_analog`⇒silence · `ambiguous_role_edit`⇒silence on role conventions · `already_dirty_bash_edit`⇒caught by sweep (content-hash regression) · `first_bash_sweep`⇒silence (seeding) · `comply_after_warning`⇒telemetry `observedAfter` + ledger mark appended (compliance closure).
5. **Replay harness:** calibration on golden histories reproduces `expected.calibration.json` byte-identically.
6. **Latency bench** ratio-gated. 7. **Hook integration:** recorded stdin fixtures, exact JSON out, `stop_hook_active`, flood/debounce. 7b. **Fixture equivalence:** a CI job rebuilds each golden repo from its builder script and asserts the result equals the committed `git bundle` (§20.2).
8. **DoD:** J1–J4 scripted; golden+mutation 100%; properties green; bench in gate; doctor clean on goldens and this repo (report-only dogfood); zero `any` exported; dead-config-key lint (all §4.5 keys read — completeness keys are read by Appendix G.4 code); docs from §19.

## 23. Phase plan (risk-first; final-form components only)
| Phase | Contents | Gate |
|---|---|---|
| **1 — Voice & measurement** | store triad; extraction + TS/JS adapters + domains; core+mined predicates; roles (§8 complete); single-pass walk + file-level lifecycle; **MDL acceptance + Δ verdicts**; **witness registries — core + all TS SYNTACTIC and WITH_TYPES transforms** (without them the verdict function cannot emit and the phase gate is unmeasurable); PostToolUse Edit/Write + Bash sweep + Stop; telemetry + ledger + demotions; `status/explain/check/index/init/doctor/reset`; maintainer authors graph nodes + architecture types; git-fixture determinism block | mutation-harness WARN rows green; J1 live; compliance telemetry flowing |
| **2 — Memory** | blob cache + value events; scope-level lifecycle; trends + nucleation; calibration; `calibrate` | replay harness green; trends honest on goldens |
| **3 — Judgment & steering** | daemon; PreToolUse DENY (arch, calibration-gated, coupling fallback); seeds + tensions + decisions; report + campaigns; brief/scaffold; completeness | DENY mutation row green; J2/J3 |
| **4 — Languages** | C# + Python adapters, Appendix B parity + fixtures | golden csharp/python green |
| **5 — Speed & polish** | perf to §20.1; Windows pipe; docs; dogfood hardening | bench gate; J4; DoD |
Cross-phase: Phase 1→2 weight refinement may shift borderline conventions (release-noted); telemetry/ledger keys survive unchanged.
---

## Appendix A — Message template catalog (exact, complete; T4 intentionally absent — a retired brief template; numbering kept stable across drafts)

**T1 — WARN (post-tool)** — the §11.1 body verbatim; prefix line exactly `[roots] {ROLE_LABEL|repo-wide} convention: {HUMAN_PREDICATE_PHRASE}`. No transition text in hooks.

**T2 — DENY (pre-tool reason)**
```
[roots] Blocked: architectural convention violation.
{n_conform}/{n_total} established {unit_plural} in this repo keep {HUMAN_PREDICATE_PHRASE} = {expected}; this edit sets {observed} in `{path}`.
This convention is architecture-class (dependency/layering), calibrated precision {calibPrecision}.
Fix: {witness_description}
Exemplars: {ex1}, {ex2}
If this is an intentional architecture change, record it as a seeded exemplar:
`yg roots seed add {path} --pids {pid} --arch --note "..."`.
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
[roots] Seed tension: seeded value {v} for {HUMAN_PREDICATE_PHRASE} correlates with fix-commits {fc}x above baseline in this repo (n={n}). The seed remains in force; consider reviewing it.
```

**T7 — agentShare alarm**
```
[roots] agentShare = {v} >= {alarm}: {pct}% of recent norm weight comes from unsurvived agent-authored code.
Recent conventions largely reflect unreviewed agent output. Mitigation: human review of recent agent code, or wait for survival weighting to settle.
```

---

## Appendix B — Predicate catalog (binding; the adapter acceptance contract — one table-driven unit fixture per row)

Columns: `pid | applies | type | class | family | overlap | domain | history | phrase | rule`. `history` ∈ blob (blob-local) / path (path-derived) / join (join-computed) / global (no history). Booleans: closed alphabet, emit `true` only.

### B.1 Core (language-independent)
| pid | applies | type | class | family | overlap | domain | history | phrase | rule |
|---|---|---|---|---|---|---|---|---|---|
| core.dir_top | type,file | cat | identity | placement | import-segments | all | path | directory placement | first path segment under partition root (containing file's for types) |
| core.dir_layer | type,file | cat | identity | placement | import-segments | all | path | layer placement | matched layer token from path segments ∈ {api,application,domain,infrastructure,ui,web,core,shared,common,services,handlers,controllers,models,utils,tests,test,spec} else `other`; **arch_class=1** |
| core.file_name_style | file | cat | identity | file_naming | name-tokens | all files | path | file naming | basename casing: PascalCase\|camelCase\|kebab-case\|snake_case\|other |
| core.file_suffix_role | file | cat | identity | file_naming | name-tokens | all files | path | file suffix role | trailing basename token if in mined suffix set, else `none` |
| core.test_sibling | file | bool | behavior | co_change | — | all files | global | has a test sibling | co-change confidence ≥ 0.5 to a test-pattern path OR conventional sibling exists (`*.test.*`, `*Tests.*`, `test_*.py`) |
| core.imports_layer_up | file | bool | behavior | layering | import-segments | files with ≥ 1 resolved import | join | imports from a higher layer | any import edge lower→higher per layer order [domain < application < api\|ui\|web], layers from core.dir_layer; **arch_class=1** |
| core.scope_loc_band | method | cat | behavior | loc_band | — | all methods | blob | method length | lines band 1-10\|11-30\|31-80\|81+ |

### B.2 TypeScript (`ts.*`; JavaScript uses the same set minus type-annotation-dependent detections — noted per row)
| pid | applies | type | class | family | overlap | domain | history | phrase | rule |
|---|---|---|---|---|---|---|---|---|---|
| ts.class_name_case | type | cat | identity | naming_case | — | all types | blob | class naming | casing classifier on identifier |
| ts.method_name_case | method | cat | identity | naming_case | — | all methods | blob | method naming | idem |
| ts.private_field_style | type | cat | behavior | naming_case | — | types with ≥ 1 private field | blob | private field style | `#x` vs `private x` (TS-only) vs `_x`, majority within type |
| ts.export_style | file | cat | behavior | export_style | — | files with ≥ 1 export | blob | export style | default \| named \| mixed |
| ts.import_relative_depth | file | cat | behavior | import_style | import-segments | files with ≥ 1 import | blob | import path style | alias (non-.) \| relative-shallow (≤ ../) \| relative-deep |
| ts.error_style | method | cat | behavior | error_style | — | methods with body ≥ 1 stmt | blob | error handling | throws \| result_type (returns /Result\|Either\|Option/ import) \| error_return \| mixed |
| ts.has_logger_member | type | bool | behavior | logging | — | all types | blob | keeps an injected logger | field/param typed-or-named /logger/i assigned from ctor param (name-only in JS) |
| ts.logs_on_entry | method | bool | behavior | logging | — | methods with body ≥ 1 stmt | blob | logs at method entry | first 3 statements contain call on member matching /log(ger)?\.(info\|debug\|trace)/ |
| ts.di_style | type | cat | behavior | di | — | types with a ctor or ≥ 1 method | blob | dependency construction | ctor_injection \| direct_new (non-DTO `new X(` in methods) \| locator (container.get) |
| ts.async_returns_promise | method | bool | behavior | async_shape | signature-shape | all methods | blob | async signature style | `async` keyword or Promise<> return type (TS-only for the type half) |
| ts.has_abort_signal_param | method | bool | behavior | cancellation | — | all methods | blob | accepts AbortSignal | param typed/named AbortSignal/signal |
| ts.guard_clause_first | method | bool | behavior | guard_structure | — | methods ≥ 2 stmts | blob | starts with guard clauses | first statement is `if (...) return/throw` |
| ts.try_wraps_all | method | bool | behavior | guard_structure | — | methods ≥ 2 stmts | blob | wraps body in try | single top-level try covering ≥ 90% of lines |
| ts.member_order_canonical | type | bool | behavior | member_order | — | types ≥ 3 members | blob | canonical member order | fields < ctor < public methods < private methods (source order) |
| ts.test_framework | file | cat | behavior | test_framework | import-segments | test-pattern files | blob | test framework | imports vitest\|jest\|mocha, else none |
| ts.public_api_doc | method | bool | behavior | doc_comment | — | exported members | blob | documents public API | JSDoc block precedes the exported member |

### B.3 C# (`cs.*`)
| pid | applies | type | class | family | overlap | domain | history | phrase | rule |
|---|---|---|---|---|---|---|---|---|---|
| cs.type_name_case | type | cat | identity | naming_case | — | all types | blob | type naming | casing classifier |
| cs.method_name_case | method | cat | identity | naming_case | — | all methods | blob | method naming | casing classifier (expected PascalCase in idiomatic repos — mined, not assumed) |
| cs.private_field_style | type | cat | behavior | naming_case | — | types with ≥ 1 private field | blob | private field style | `_camel` \| `camel` \| `m_` majority within type |
| cs.error_style | method | cat | behavior | error_style | — | methods with body ≥ 1 stmt | blob | error handling | exceptions \| result_type (returns /Result\|ErrorOr\|OneOf/) \| mixed |
| cs.has_logger_member | type | bool | behavior | logging | — | all types | blob | keeps an injected logger | ILogger<T> ctor-injected field |
| cs.logs_on_entry | method | bool | behavior | logging | — | methods with body ≥ 1 stmt | blob | logs at method entry | first 3 statements call _logger.Log*/LogInformation-family |
| cs.di_style | type | cat | behavior | di | — | types with a ctor or ≥ 1 method | blob | dependency construction | ctor_injection \| direct_new \| service_locator |
| cs.async_suffix | method | bool | behavior | async_shape | signature-shape | methods returning Task/ValueTask or named *Async | blob | async naming | name ends `Async` iff returns Task/ValueTask |
| cs.has_cancellation_param | method | bool | behavior | cancellation | — | all methods | blob | accepts CancellationToken | param of type CancellationToken |
| cs.guard_clause_first | method | bool | behavior | guard_structure | — | methods ≥ 2 stmts | blob | starts with guard clauses | first statement is guard `if (...) return/throw` |
| cs.member_order_canonical | type | bool | behavior | member_order | — | types ≥ 3 members | blob | canonical member order | fields < ctor < public < private |
| cs.nullable_annotations | file | cat | behavior | nullability | — | all files | blob | nullable annotation use | `#nullable` present \| `?` annotation density band \| none |
| cs.public_api_doc | method | bool | behavior | doc_comment | — | public members | blob | documents public API | `/// <summary>` precedes |
| cs.test_framework | file | cat | behavior | test_framework | import-segments | test-pattern files | blob | test framework | xunit \| nunit \| mstest \| none |
| cs.record_vs_class_dto | type | cat | behavior | data_shape | — | types with only auto-properties | blob | DTO shape | record \| class |

### B.4 Python (`py.*`)
| pid | applies | type | class | family | overlap | domain | history | phrase | rule |
|---|---|---|---|---|---|---|---|---|---|
| py.func_name_case | method | cat | identity | naming_case | — | all functions | blob | function naming | casing classifier |
| py.class_name_case | type | cat | identity | naming_case | — | all classes | blob | class naming | casing classifier |
| py.error_style | method | cat | behavior | error_style | — | functions with body ≥ 1 stmt | blob | error handling | exceptions \| result (returns tuple/Optional-error pattern) \| mixed |
| py.has_logger_member | file | bool | behavior | logging | — | all files | blob | module logger | module-level `logging.getLogger(...)` |
| py.logs_on_entry | method | bool | behavior | logging | — | functions with body ≥ 1 stmt | blob | logs at entry | first 3 statements call logger.info/debug |
| py.di_style | type | cat | behavior | di | — | classes with `__init__` | blob | dependency construction | ctor_injection \| module_singleton \| direct_new |
| py.type_hints | method | cat | behavior | nullability | — | public functions | blob | type-hint coverage | full \| partial \| none over public params |
| py.docstring_public | method | bool | behavior | doc_comment | — | public functions | blob | docstrings on public API | docstring present |
| py.async_def | method | bool | behavior | async_shape | signature-shape | all functions | blob | async style | `async def` |
| py.dataclass_vs_plain | type | cat | behavior | data_shape | — | classes with only field assignments | blob | data class shape | @dataclass \| plain |
| py.test_framework | file | cat | behavior | test_framework | import-segments | test-pattern files | blob | test framework | pytest \| unittest \| none |
| py.import_grouping | file | bool | behavior | import_style | import-segments | files with ≥ 3 imports | blob | import grouping | stdlib/third-party/local separated by blank lines |

Extraction rules are given at tree-sitter level per grammar `node-types.json`; each row's table-driven fixture is the acceptance contract (§22.1). Mined pids (Appendix G.2) carry family `name_suffix` (name tokens), `imports_set` (import tokens), or `misc_mined` (structural labels). **Fallback buckets (binding, §9.4c):** the values `other` (dir_layer, file_name_style, casing classifiers), `none` (file_suffix_role, test_framework), and `mixed` (export_style, error_style) are marked fallback in every row that carries them — never eligible as `expected`.

---

## Appendix C — Transform registry & per-pid hook-speech table (binding)

**No universal fallback.** Transforms with their `servesPids`:

| transform | safety | servesPids |
|---|---|---|
| **core** `move_file_to_dir` | WITH_TYPES | core.dir_layer, core.dir_top |
| **core** `remove_upward_import` | WITH_TYPES | core.imports_layer_up |
| **core** `rename_file_to_case` | WITH_TYPES | core.file_name_style |
| **core** `rename_file_to_suffix` | WITH_TYPES | core.file_suffix_role |
| `rename_symbol_to_case_in_file` | SYNTACTIC | ts/cs/py `*_name_case` pids (unexported/private symbols) |
| `rename_symbol_to_case_cross_file` | WITH_TYPES | ts/cs/py `*_name_case` pids (exported symbols) |
| `rename_symbol_to_suffix_in_file` | SYNTACTIC | mined.name_suffix, cs.async_suffix (unexported) |
| `rename_symbol_to_suffix_cross_file` | WITH_TYPES | mined.name_suffix, cs.async_suffix (exported) |
| `convert_private_field_soft` | SYNTACTIC | ts.private_field_style (result `private x` or `_x` only), cs.private_field_style |
| `convert_private_field_hard` | BEHAVIORAL_RISK — never a witness | ts.private_field_style (any conversion to/from `#x` — hard-private slots change `in`/serialization/subclass semantics) |
| `inject_logger_ctor` | WITH_TYPES | ts.has_logger_member, cs.has_logger_member, py.has_logger_member |
| `add_entry_log_call` | SYNTACTIC | ts.logs_on_entry, cs.logs_on_entry, py.logs_on_entry |
| `convert_new_to_ctor_injection` | WITH_TYPES | ts.di_style, cs.di_style, py.di_style (result `ctor_injection` only) |
| `add_guard_clauses` | SYNTACTIC | ts.guard_clause_first, cs.guard_clause_first |
| `add_cancellation_param_and_forward` | WITH_TYPES | cs.has_cancellation_param |
| `add_abort_signal_param` | WITH_TYPES | ts.has_abort_signal_param |
| `reorder_members_canonical` | SYNTACTIC | ts.member_order_canonical, cs.member_order_canonical |
| `split_export_default_to_named` | SYNTACTIC | ts.export_style (result `named` only) |
| `add_doc_comment` | SYNTACTIC | ts.public_api_doc, cs.public_api_doc, py.docstring_public |
| `rewrite_import_paths` | SYNTACTIC | ts.import_relative_depth |
| `regroup_imports` | SYNTACTIC | py.import_grouping |
| `add_import` / `remove_import` | SYNTACTIC | mined.imports.* |
| `wrap_throws_into_result` | BEHAVIORAL_RISK — never a witness | (ts/cs/py).error_style |

**Observation-tier pids (no serving witness — exhaustive):** all `error_style`; ts.try_wraps_all; ts.async_returns_promise; py.async_def (converting a sync signature to async is behavior-changing by definition); ts/cs/py.test_framework; core.scope_loc_band; core.test_sibling; cs.nullable_annotations; py.type_hints; cs.record_vs_class_dto; py.dataclass_vs_plain; mined structural labels (`misc_mined`). Everything else in Appendix B is speakable. §3.2's family-level summary derives from this table; **this table wins on any disagreement.** Every `describe()` names concrete symbols and the expected value, one imperative sentence.

---

## Appendix D — `model.json` snapshot (string keys only; header excluded from content hash; sufficient for the hook path by construction — every §9.9 input is present; JSON keys are camelCase, prose uses snake_case: `coverageRole` ↔ coverage_role)

```jsonc
{ "header": { "rootsVersion","configHash","seedsHash","ledgerHash","headSha","lastIndexedSha","dirtyHash","clock","candidateCountLog2","rolesStale" },
  "partitions": [{ "id": "…",
    "alphabets": { "<pid>": ["v1","v2","…"] },                           // §9.3 — partition-observed values, sorted, seeds excluded;
                                                                         // K = |alphabet|+1 (cat) / 2 (bool); ⊥ ⇔ value ∉ alphabet
    "roles": [{ "roleKey":"…","label":"…","size":34,"medoid":"<stable_id>","medoidRef":"path#Scope",
                "medoidFeatures": {"own":["…"],"callers":["…"]},        // §8.8a — callers stored separately, excluded symmetrically at hook time
                "definingFeatureGroups":["name-tokens","…"],            // §7.1 overlap, §8.7
                "roleLift": 0.42 }],
    "conventions": [{ "roleKey":"…|_all","pid":"ts.logs_on_entry","family":"logging","appliesKind":"method","archClass":false,
                      "expected":"true",
                      "counts": {"true":"24.2","false":"1.3"},           // weighted n_v (canonical decimals); p̂ via §9.3 with K from `alphabets`
                      "nConformRaw":29,"nTotalRaw":31,                   // the SURVIVED raw population of §9.4c (what T1/T2 display)
                      "bitsPerInstance":1.32,                            // = data_term / n_eff (§9.4a ranking key)
                      "bitsSaved":28.1,
                      "tau":2.5,"calibPrecision":null,
                      "hookEligible":true,                               // = §9.4c share gates ∧ §8.7 role_lift ∧ §14 not-demoted (all model-level)
                      "suppressedValue":null,"seeded":false,"stabilityDays":210,
                      "exemplars":["src/app/foo-handler.ts:12#handle","…"] }],
    "couplingByFile": {"src/app/foo-handler.ts": 82},                    // percentile, max over the file's scopes
    "couplingByModule": {"src/app": 61}, "moduleOfFile": {"src/app/foo-handler.ts": "src/app"},   // §9.8 fallback chain
    "seeds": [{"seedId":"…","pids":["…"],"tension":null}],
    "trends": {"<roleKey>|<pid>": [{"end":0,"shares":{"true":0.7},"lowSample":false}]},
    "agentShare":0.41,"coverageRole":0.63,"coverageAll":0.91,"debtBits":812.5,"debtPerInstance":1.9 }] }
```
Local modulators (`demotions.json`, sessions) are NOT in the snapshot — I2b. The hook additionally reads `demotions.json` and its session log; both live in `.roots-state/` and are small.

---

## Appendix E — Worked constants (generated by `source/cli/tests/fixtures/derive-e.ts` from §9 formulas — one presentation convention: every row reports `bits_saved` after all costs, compared against the 4.0 margin; the doc is asserted against the script, never hand-edited)

**E.1 Δ reachability (KT; booleans K=2).** Clean convention, deviant observed: Δ = log2(2·n_eff+1) at any alphabet (clean-case K-invariance — numerator and denominator share the same KT denominator): n_eff 3 → 2.807 ✓, 4 → 3.170, 6 → 3.700. Asymptotes: 90/10 → 3.170 ✓ (the flagship fires at any n), 85/15 → 2.503 (boundary), 80/20 → 2.000 ✗. Categorical |V|=4 (K=5), clean n_eff=6, rare in-alphabet value: p̂(e)=6.5/8.5=0.7647, p̂(v)=0.5/8.5=0.0588, Δ=3.700 — identical, as predicted.

**E.2 Fire-ability, exactly.** The §9.4c gate `(n_e+½)/(n_runnerup+½) ≥ 2^τ` is the finite-n condition for Δ against the most common deviation to reach τ — exact at every n, for every alphabet. For booleans it converges to share ≥ 5.657/6.657 = **0.8498** as n → ∞ (at n = 30 the gate demands share ≈ 0.861; a fixed 0.85 share gate would have admitted an eligible-but-mute band [0.850, 0.861] — which is why the gate is the ratio test, not a share constant). At share 2/3 the supremum of Δ over all n is exactly 1.0 bit — permanently ineligible, as intended.

**E.3 Role acceptance scenarios (boolean, C₂ = 2^14 ⇒ index 14.0 bits, margin 4).**
- **S1 flagship:** partition 600 (role 30× `result_type`; rest 30/540 reversed): p̂_all(rt)=0.1007, p̂_r(rt)=0.9839 → data = 30·3.289 = 98.7; param 2.45 → **bits_saved 82.2 ✓**. Minimum role size at this contrast: **n_r = 7**, computed with p̂_all held at the n_r=30 scenario value while p̂_r tracks n_r (`derive-e.ts` states this basis).
- **S2 `_all` coin flip:** 50/50, any n → data_term = 0 → **rejected** (the B = max(|V|,2) baseline; including ⊥ in it would hand 0.57 free bits/instance and first accept the coin at n = 42 — verified and excluded).
- **S3 `_all` clean boolean:** accepts at exactly **n_eff = 21** (n=21: bits_saved = +0.11 ✓; n=20: −0.86 ✗).
- **S4 zero-contrast big role:** role 500 all-true in a 505-true partition: data ≈ −0.01 → **rejected** (the partition-posterior baseline removes the leave-role-out pathology where a dominant role was graded against a 5-instance remainder).
- **S5 chaotic role:** 18/12 in a 50/50 partition: data 0.87 ≪ costs → **rejected** — correct silence on 60/40.

**E.4 False-convention control.** With index_cost = log2(C₂), the acceptance threshold implies a per-candidate G-test p-value small enough that the expected false-accept count across all C candidates is ≪ 1 (at C₂=2^14, margin 4: data_term ≥ 18 bits ⇒ G ≥ 25 ⇒ p ~ 6e-7 for K=2; 2^14 × 6e-7 ≈ 0.01).

**E.5 Attractor-enforcement impossibility (why P3 is structural).** The survived-raw gate requires share ≥ 2/3 > 1/2, so `expected` is the majority of the survived stock; the fire-ability ratio additionally forces a ≥ 5.66:1 margin over the most common deviation. A minority attractor can never be `expected`. Transitions are report/campaign material and nucleation stand-downs only.

**E.6 Unseen values.** |V|=4, n_eff=20: p̂(⊥)=0.5/22.5=0.022, clean p̂(e)=0.911 → Δ=5.36 — passes τ but is **capped at WARN with a novelty note** (§9.7); ⊥-surprisal grows like log2(2n+1) and must never reach DENY.

**E.7 Wilson floors (z = 1.96, two-sided — why §14 selects on the point estimate).** WilsonLB95 of a flawless record: 12/12 → 0.758; 15/15 → 0.796; 16/16 → 0.806 — a lower-bound τ-selection rule at `minEventsConvention = 12` is unsatisfiable even at perfect precision, and real repair-rate proxies run 0.2–0.5 (LB95(20/40) = 0.352), so a lower-bound rule demotes everything that accumulates evidence: usage would cause muting. Hence: point estimate selects τ; demotion requires WilsonUB95 < target (evidence of badness); the lower bound gates only DENY, whose floor is **n = 35** flawless (LB95 first reaches 0.9) and 53 with one failure — the source of `minEventsDeny: 35`.

---

## Appendix F — Findings traceability (navigational index, not a completeness proof)

Round-1 review → v4: MDL/KL & estimator §9.4+E; τ/gates joint derivation §9.7+E.1–E.2; MAD gate deleted; witness fallback deleted §10; calibration §14; determinism §20.2/I2a; role identity/classifier §8.4–8.6; trends §9.5/§13.2; attractor §9.5/E.5; stable_id §6.3; debt §16.2; agentShare §18.4; circularity §7.1/§8.1; nucleation storability §13.2; seeds §9.2/§17; platform §4.1/§4.3/§5; hooks protocol §12.
Round-2 verification → v4: R2×R13 → E.5; R11 collateral → §7.1/§7.2 (dir_layer on type scopes)/§8.8b; I2 breaks → §8.6 (content keys), §12.7 (staleness excludes ledger/dirty), §18.2 (demotions local-only), I2a/I2b; Phase-1 silence → §23 (witnesses in Phase 1) + §13.3 (file-level lifecycle); estimator outer weight → §9.4a; multiple comparisons → index_cost; ranking → bits/instance + §11.2; calibration operability → §14 (grid/support/WilsonLB/report-only demotion, availability rules); role_lift → §8.7 (overlap-filtered); trend windows → §9.5; blob key split → §13.2; w(s,q) table → §8.5; oscillation → floor + hookShapedWeight 0.15 cap-last; telemetry denominator/retention/materialization → §18.1–18.2/§4.4; Bash seeding/hashes/floods → §12.4; settings.local disclosure → §12.2; mined speech honesty → §3.2/§7.5/App C; decision log → §17.4; stores → §4.4; session id/races → §11.3; sparse booleans + reaping → §5; dendrogram complexity + reinduce budgets → §8.3/§6.5; K alphabet → §9.3 (closed booleans, ⊥ for categoricals); debt/K → §16.2 per-instance; superseded text → Appendices A/B/G restated.
Round-6 (empirical probe on 7 real repos) → v5.2: `_all`-placement nonsense → §7.2 (placement role-only); fallback-bucket expected → §9.4c; report split directional/distributional → §16.1; empirical notes recorded in the validation report (ambiguity 47–83% with probe-grade features — role-speech thinness; weight-shift at Phase 1→2 confirmed on fastify; walk 752 commits = 46 ms; null control 0 false role conventions across all repos).
Round-5 (v5 final gate) → v5.1: empty survived population + J4 status line → §9.4c/§19; mined.name_suffix single-pid resolution → §3.2/§6.6/App C/G.2; ignored-branch in cross-session closure → §18.2; build lock → §4.4; per-(pid,expected) speech in glossary/coverage/campaign → §3.2/§16.2/§16.3; core transform ids verbatim → §6.6; lastIndexedSha in header → §4.4; post-filter severity for budgets → §11.2; module fallback from path → §9.8; private-field transform split + rename in/cross-file split → App C; burst-mute bound honesty → §9.4c; T2 unit_plural → App A; bitsPerInstance gloss → App D/§16.1; E.5 premise rewrite, E.7 16/16=0.806, S2 n=42, S1 basis, S3 presentation → App E; modulator table row 5 → I2b; fixed-constant list completed → §4.5; report/postTool/bash keys named at use → §16.1/§12.2; trend_word/seed_note defined → App A/§11.1.
Round-4 (v4 verification) → v5: Wilson floor / calibration muting → §14 (point-estimate selection, UB-demotion, minEventsDeny 35) + E.7; `_all` baseline |V| floor → §9.4b (B = max(|V|,2)); DENY dedup escape → §11.2 (WARN-only dedup) + §22.4 retry row; witness pid-keying → §6.6 servesPids + §10 + App C per-pid table; snapshot alphabets → §9.3 + App D; compliance closure → §9.9 closeIntervention; two-classifier regression → §8.4/§8.8 (own-features-only classification everywhere); raw-gate mute/echo/display → §9.4c (survived raw population, hook_shaped excluded); decorative-role shadow → §8.7; channel table 5 channels → §9.9/§12.3; incremental walk + daemon reindex → §6.5/§12.6; G.2 double-count → G.2(3); ranking by data_term/n_eff → §9.4a; coverage cell set → §16.2; T1 placeholders → §11.1; couplingByModule → App D; check semantics → §19; lifecycle last_human_commit_ts + author_kind rule → §13.3; cross-session closure + demotion staleness stamp → §18.2; bash seeding/stop rules → §12.4; connect timeout + probe incident → §12.6; C₂ definition → §9.4a; E.3-S3 = 21, E.2 exact fire-ability, E.7 → App E; unkeyed constants → §4.5 note; dead keys named at use → §9.5/§15/§17.1/§18.4.
Round-3 (v3 verification) → v4: `_all` baseline junk-acceptance → §9.4b (uniform over observed values, E.3-S2); role-vs-`_all` arbitration → §9.4a (single p̂_all baseline, same-instances) + shadowing in §9.9; leave-role-out pathology → E.3-S4; self-containment → Appendices A/B/G; Phase-1 mute → §23 witnesses; dir_layer applies_kind → §7.2/B.1 (type,file) + §8.8b file roles; ledger staleness → §12.7; Appendix D sufficiency → App D (counts, medoidFeatures, coupling, `_all`); weighted-vs-raw display → §9.4c raw conjunct; git-fixture over-claim → §20.2/§4.1 (builder supplies determinism; helper extension is a named task); eligible-but-mute boolean band → E.2 alignment; unseen-value escalation → §9.7 WARN cap; introduction events → §13.2; coupling fallback → §9.8; demotions materialization → §18.2; blob key split → §13.2; stability_period → §9.4d; session id → §11.3; exit codes → §19; maxCommits/horizon → §4.5/§14; ladder "else" → §14; preTool default → §4.5/§12.6; coreTransforms → §6.6/App C; DENY fixture → §22.4; test_sibling/file_suffix_role families → §7.5/B.1; E-appendix regeneration → derive-e.ts; C₂ quantization → §9.4a; §9.9 channel filter/shadowing/appliesKind → §9.9; ordering authority → §11.2; m1 weighting → §8.5; empty-cluster ordering → §8.4; import-feature leak → §7.1/§8.1; telemetry expected-filter → §18.2; ledger release gap → §18.3; degraded-weights cap-last → §9.1; `_untyped` gates → §8.1/§9.9; incidents durability → §21.1; socket path → §12.6; config-key completeness → §4.5 (all keys read; fixed constants marked).

---

## Appendix G — Restated normative material (formerly incorporated by reference)

**G.1 Layer order (for core.dir_layer / imports_layer_up):** `domain < application < api|ui|web`; tokens and bands as the B.1 rows state. (The full core vocabulary lives in B.1 — this spec has no other source.)

**G.2 Mined-predicate generator.** Per partition, three families: (1) **identifier suffix/prefix tokens** — tokenize scope names at casing boundaries; tokens with count ≥ `minInstancesRaw` become `mined.name_suffix=<token>` categorical values on method|type and feed `core.file_suffix_role`'s suffix set; (2) **import-set tokens** — per file, each imported **package specifier's** last segment with count ≥ minInstancesRaw ⇒ `mined.imports.<segment>` bool (domain: files of the language); (3) **structural labels** — adapters emit `{early_return, switch_on_enum, await_in_loop, throws_in_ctor}` as `misc_mined` pids (`guard_clause_first` and `try_wraps_all` are NOT in this set — they exist as catalog pids in Appendix B's `guard_structure` family and must not be double-counted); "mined" is only which become conventions. All pass §9.4; cull by `data_term/n_eff` to `minedCap`.

**G.3 Fix classifier (per commit):** message matches `/^(fix|hotfix|bugfix)\b|(^|\s)revert(s|ed)?\b/i` OR conventional-commit type `fix:` OR contains `This reverts commit`.

**G.4 Co-change & completeness.** Over walked non-merge commits with ≤ `megaCommitFileCap` changed files: every unordered file pair increments support; `confidence(a→b) = support(a,b)/commits(a)`; persist pairs with support ≥ `completeness.minSupport` ∧ max-direction confidence ≥ `completeness.minConfidence`; `R` records remap old→new before counting. **Completeness check (Stop, once per session, mode `stop-feedback-once`):** D = files written this session (session log); E = `{b : ∃a∈D, confidence(a→b) ≥ minConfidence ∧ support ≥ minSupport} \ D \ deleted`; if E ≠ ∅ emit T5 listing ≤ 5 items with `{support}/{commits}` evidence.

**G.5 Reference machine:** Apple M-series, 8 performance cores, NVMe. CI gates use ratios vs a stored baseline, never absolute ms.

---
*End of specification v5. Anything not specified (helper naming, file decomposition, test layout beyond §22) is implementer's discretion within I1–I10.*
