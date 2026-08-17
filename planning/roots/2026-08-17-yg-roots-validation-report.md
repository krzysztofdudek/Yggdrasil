# `yg roots` — Empirical Validation Report (synthetic tests on real repositories)

**Date:** 2026-08-17. **Spec under test:** consolidated v5 (→ amended to v5.2 as a result of these tests).
**Method:** a standalone probe (`roots-probe.mjs`, ~330 lines, Node + the repo's own web-tree-sitter build and grammar WASMs) implementing the spec's exact statistical core: KT α=½ posteriors (§9.3), role acceptance vs the partition posterior with parameter + index costs (§9.4a), `_all` acceptance vs uniform B=max(|V|,2) (§9.4b), fire-ability + raw-share eligibility gates (§9.4c), preference gap Δ (§9.7), Jaccard average-linkage (Lance–Williams) with the incremental-DL MDL cut (§8.3), nearest-medoid single classifier (§8.4), ambiguity (§8.5), `_untyped` gate (§8.1), overlap exclusion (§7.1), package-root partitions with the 300-scope floor (§6.7), speakability filtering per Appendix C. Extraction is real tree-sitter (TS/TSX/JS) over a **subset** of ~14 predicates with heuristic-grade rules; role feature bags omit callee/caller graph tokens (probe limitation — noted where it matters). Weights: uniform ("mature repo" mode) everywhere, plus real file-level lifecycle weights (§9.1/§13.3 Phase-1 form) on two repos with git history via the §13.1 single-pass walk.

**Test corpus (7 runs):**

| Repo | Character | Files | Scopes | Partitions | Weights |
|---|---|---|---|---|---|
| expressjs/express | small JS lib, loose conventions | 141 | 264 | 1 | uniform |
| fastify/fastify | JS framework, moderate conventions | 273 | 1 100 | 1 | uniform |
| fastify (12-mo history) | same, real lifecycle | 273 | 1 100 | 1 | **file-lifecycle** (752 commits) |
| typeorm/typeorm | mature TS lib | 3 296 | 8 829 | 2 | uniform |
| nestjs/nest | TS framework **monorepo** | 1 820 | 6 988 | 5 | uniform |
| immich-app/immich | NestJS app, strong conventions | 934 | 4 931 | 4 | uniform |
| krzysztofdudek/Yggdrasil | this repo (dogfood) | 1 148 | 5 065 | 2 | **file-lifecycle** |

Zero parse errors across all runs; zero oversize skips triggered except by design.

---

## 1. What the design got RIGHT (validated)

**V1 — False-positive control holds in vivo.** The shuffled-label null control (each predicate's values permuted across scopes, deterministic seed) produced **0 accepted role-conditioned conventions on every repo and every partition** — the `log2(C₂)` model-index cost does in practice what Appendix E.4 claims in theory. (The null is structurally uninformative for `_all` conventions — marginals are shuffle-invariant — so the control tests exactly the associative claim, which is the one at risk.)

**V2 — The eligibility gates mute what should be mute.** Every accepted-but-non-majority distribution was correctly withheld from speech: `mined.name_suffix=dto` (share 0.28, immich), `=options` (0.15) and `=sql` (0.07, typeorm), `ts.method_name_case=lowercase` (0.52, fastify — a genuinely split JS style), `ts.logs_on_entry` at share 0.52 on an immich role. High-bits ≠ speech; the §9.4c gate pair filtered all of them. No gate false-negatives observed on clean conventions (`export_style=named` 0.97, `class_name_case=PascalCase` 1.0 all speak).

**V3 — Silence on conforming, mature code.** nest `packages/common`: 48 speakable conventions, nearly all with **0 deviant instances** — an agent writing conforming code there hears nothing, exactly the J1 promise. Express (small, loose): 3 speakable conventions, 6 deviant instances total; under the spec-strict no-history rule (§21.1: no lifecycle ⇒ unsurvived ⇒ ineligible) it is fully silent with `status` explaining — the J4 path behaves.

**V4 — The mining finds real, load-bearing conventions.** Dogfood highlight: on this repository the probe independently discovered `mined.imports.chalk=false` (share 0.97) and `mined.imports.web-tree-sitter=false` (0.96) as speakable negative-dependency conventions — these correspond to **actual authored Yggdrasil aspects** (color restricted to formatters; parser access restricted to the AST layer). The statistical layer converges on rules the maintainer wrote by hand. Also found: `method_name_case=camelCase` (0.85, 436 deviants — real mixed-casing debt in tests), `logs_on_entry=false`, `has_logger_member=false` (this CLI genuinely does not do member loggers).

**V5 — Role-conditioned placement works exactly as designed.** immich r39: "types shaped like *-util live under `utils/`" — share 1.0, speakable, the flagship §7.2 arch convention emerging naturally. typeorm r36–r41: six roles with "this type-shape lives under `src/`" at share ≥ 0.92. This is the DENY family functioning.

**V6 — Performance extrapolates within budget.** Parse+extract: 8 829 scopes (typeorm) in ~4 s single-threaded probe. Role induction ≤ 350 ms/partition at the probe's N=700 clustering cap; O(N²) extrapolation to the spec's N=6 000 ⇒ ~25 s, inside the §20.1 re-induction budget (≤ 60 s). The §13.1 single-pass walk: 752 commits with `-M --name-status` in **46 ms** — the 4 000-commit cap costs well under a second, supporting the ≤ 15-min history budget with room for blob extraction.

**V7 — The Phase 1→2 weight shift is real and material (as the spec warns).** fastify uniform vs file-lifecycle: accepted 14→13, speakable 5→6, deviant instances 19→122 (`guard_clause_first=false` became eligible under survival weighting). §13.3's release-note requirement ("borderline conventions may shift at the boundary") is not hypothetical.

## 2. What the tests FOUND WRONG (spec amended, v5.2)

**F1 (fixed, §7.2) — `_all` placement conventions are structurally nonsense.** `core.dir_top=test` at share 0.84 (typeorm — a test-heavy repo) and `core.dir_layer=other` at 0.83 (immich) were accepted and speakable, with hundreds of "deviants" = **all production files**. A partition-level "expected directory" encodes the directory size distribution, not a convention; taken literally it instructs agents to move production code into `tests/`. **Amendment: placement pids are role-conditioned candidates only.** (Role-conditioned placement — V5 above — is unaffected and is where the value lives.)

**F2 (fixed, §9.4c + App B) — fallback buckets as `expected` produce false speech.** `core.file_name_style=other` at share 0.81 was speakable — the message would read "name your file in the *other* style". Buckets that mean "unclassified" (`other`, `none`, `mixed`) are not styles. **Amendment: fallback-bucket values are never eligible as `expected`; Appendix B marks them per row.**

**F3 (fixed, §16.1) — raw bpi ranking is dominated by distributional facts.** The top of typeorm's and immich's lists by bits/instance were suffix-distribution facts at share 0.07–0.28 (huge information content, zero actionability). **Amendment: the report ranks hook-eligible conventions first; distributional facts get their own section.**

## 3. Honest caveats & open empirical questions (not spec defects)

**C1 — Role-conditioned speech is thin on real repos, and ambiguity is high.** With probe-grade feature bags (no callee/caller tokens), role assignment ambiguity ran **47–83%** across partitions, and role-conditioned conventions numbered 0–18 per partition (vs 10–60 `_all` conventions). Part of this is probe fidelity (sparser bags ⇒ coarser Jaccard ⇒ more ties), but the direction of the finding is robust: **most enforceable convention mass sits in `_all`; the role layer's distinctive contribution is placement and a handful of per-role behaviors.** Implications: (a) the §8.5 ambiguity thresholds (gap 0.15, m1 0.35) deserve early calibration against full-fidelity feature bags in Phase 1 — with quantized Jaccard on small sets they silence most role speech; (b) the product's value does not collapse if roles underperform — the `_all` tier carried most of the useful findings in every repo tested. This de-risks the design's most speculative module in the best way: the system degrades to a strong global-conventions engine.

**C2 — Message pressure on first contact varies 0.9–37 deviant instances per 100 scopes** (pre-F1/F2 numbers; the amendments remove the two biggest noise drivers — immich's corrected pressure is roughly half). Stock debt ≠ per-session messages (dedup + budgets cap per-session exposure at `sessionMaxWarnings`), but repos with genuinely mixed styles (fastify's 50/50 casing) will generate steady WARN streams on touched files. The §18.2 demotion valve and §11.2 budgets are the designed mitigations; the compliance telemetry will show whether they suffice — this is precisely the Phase-1 gate metric.

**C3 — Probe limitations.** ~14 heuristic predicates (no member_order, no di_style precision, no import_relative_depth nuance); no callee/caller graph features; clustering sampled at N=700; `C` counted per partition rather than repo-wide (lower index cost ⇒ *more* permissive acceptance than the real system — the 0-false-positive null result therefore under-states the real control); Yggdrasil's CCR checkout is shallow (50 commits), so its lifecycle weights are partial. None of these overturn the directional findings; all of them argue the real system will be *quieter* and *cleaner* than the probe.

## 4. Verdict

The v5 statistical core survives contact with real code: no false positives under the null, correct muting of non-majorities, silence on conforming mature code, real conventions found (including ones this repo independently encodes as authored rules), role-conditioned placement working as the arch flagship, and performance inside budgets. The tests earned their keep by exposing three defects invisible to five rounds of adversarial review — all three are *semantic* (what a convention means), not mathematical, and all three are now fixed in v5.2 with one-paragraph amendments. The two open questions that only production telemetry can answer — role-layer yield at full feature fidelity, and message-pressure tolerance — are exactly what Phase 1's instrumentation is built to measure.

**Artifacts:** probe script + raw JSON outputs for all 7 runs in the session scratchpad (`probe/roots-probe.mjs`, `probe/out-*.json`); spec updated in place (`.plans/2026-08-17-yg-roots-spec-final.md`, v5.2).
