# Grounding Reference — Increment 2 (R1–R3, Roots Mining Core)

Produced by a full read of the strategic plan's R1–R3 scope, every planning/roots document,
the working prototype, and the engine seams the module must integrate with. Line anchors
verified against the tree at the time of writing; re-locate by quoted code on drift.

## A. Scope per the strategic plan

- **R1 — Foundations** (plan:44-54): `src/roots/` skeleton (15 files: binding, extract,
  enumerate, roles, mine, history, weights, trends, calibrate, verdict, speech, inquiry,
  promote, stores, advise-bridge, cli); storage `.yggdrasil/roots/` (committed model.json
  with the I2a header incl. decisionsHash, seeds.jsonl, union-merged decisions/ledger
  jsonl; gitignored .cache/ + .state/); `roots:` config block (spec §4.5 keys, per-block
  unknown-key rejection, configHash scoped to subtree, absent block = dormant);
  rootsVersion riding migrations infra; shared parser pool (the prototype's standalone
  WASM loader does NOT port); genericity lint (P6) over src/roots/**.
  OUT: EXT2GRAMMAR constant, standalone loader, daemon, scaffold, check --exit-code.
- **R2 — Extraction & enumeration** (plan:56-62): binding derivation from node-types.json
  (lexical @/[ marker, decoration window (loRow, bodyRow]); scope ordinals + skeyR keys;
  twelve enumerators; per-partition vocabularies; relative-import normalization; committed
  binding snapshots for all 16 grammars in unit tests; build assertion every grammar wasm
  ships node-types.json; extensions from language-registry only (.mts/.cts confirmed
  present). OUT: any per-language authored code.
- **R3 — Roles & acceptance** (plan:64-73): weighted Lance-Williams clustering, clone-aware
  ambiguity (0.6), sticky roles; full acceptance chain (KT/MDL vs parent posterior, index
  cost, fire-ability, survived-raw >= 2/3 FAIL-CLOSED without history — the prototype's
  inversion corrected here; vacuous filter; two-tier absence tau 3.5/4.5; placement
  group-only; fallback buckets; locality lattice dirMin 25 with redundant/nested-refinement
  pruning; correlation dedup; seeds cap 0.5×n_eff); productionized §7.3 tautology filter,
  §9.4g stability, §9.4h factCap, REAL role_lift (held-out DL — no reference impl exists,
  spec formula only). OUT: history weights (R4), verdict/speech (R5), trends/DENY (R6).
- §6 binding decisions touching R1-R3: roots never gates CI; fail-closed survived-raw
  without history (fail-open only on the hook path); artifact names via
  rules-artifact-names.ts; nothing descoped without the owner's written decision.
- Increment 2 = "R1–R3 + goldens for the 6 MEASURED grammars start here" (plan:260):
  TS/TSX/JS/Python/Java/Go have prototype-measured priors; the other 7 code grammars get
  their first real contact later (R9 completes all 16).

## B. What the prototype proves / does not cover

Proven (report): 65/0/0 mutation detection + 130/130 silence across 7 models / 2 languages;
zero language-specific code across 6 languages (Java/Go binding derivation cost 0 lines);
locality lattice self-discovers boundaries; byte-identical determinism across cache states;
incremental relearn 0-cost; compliance loop + export-aspect ratchet verified live.
NOT covered by the code: survived-raw fails OPEN in the prototype (mjs:190) — R3 fixes to
closed; role_lift is a proxy (mjs:252-255) — real formula implemented fresh from spec
§8.10; stable_id is the simple relPath#kind#name#k, not sha256(partition∥path∥kind∥qname∥
arity); no sharded blob cache / resume (R4); ledger cap approximated post-hoc at fact
level, not inside w(s,q); mine() is one ~75-line function conflating acceptance/dedup/
pruning/directory context — must decompose into mine.ts with the R3/R4 seam (mkWeightFn/
ageFn threading) made explicit.

## C. Integration seams (patterns to follow, not invent)

- Command registration: bin.ts imports+registration; handler shape per build-context.ts
  (options validation with buildIssueMessage BEFORE graph load; loadGraphOrAbort;
  abortOnUnexpectedError) — cli/preamble.ts.
- Parser/grammars: src/ast/parser.ts getParser(extension) IS the pool (memoized init/load);
  grammar resolution via language-registry getGrammarForExtension; dist/grammars/ already
  ships 16 matched .wasm/.node-types.json pairs — no build change needed for R2.
- Derived state: two live precedents — relations/facts-cache.ts (astCacheDir, schema
  version in filename) and io/type-class-cache.ts (versioned dir). Roots' layout is a
  deliberate THIRD shape (nested roots/ subdir + committed model.json snapshot) — extend
  init-scaffold.ts's GITATTRIBUTES_LINES (3 new lines) and YGGDRASIL_GITIGNORE_LINES.
- Config: copy the per-block unknown-key rejection shape from config-parser.ts signals:/
  events: blocks. rootsVersion = separate version axis (infrastructure reuse only).
- Errors: formatters/message-builder.ts buildIssueMessage for all CLI-facing errors.

## D. USER-GATED: architecture-graph coverage for src/roots/** (UNRESOLVED)

- 38 node types exist; NONE matches src/roots/**; model/cli/ has no roots/ subtree.
- Closest by role: ast-adapter (binding/extract), relations-adapter (enumerate/roles/mine —
  but its description is relation-specific), command/command-support (cli.ts),
  persistence-adapter (stores.ts).
- v6 spec I10: the maintainer authors the node types and the model/cli/roots/** subtree in
  the design-lock step — NEVER programmatically. AGENTS.md: yg-architecture.yaml changes
  require the user's confirmation.
- The increment CANNOT resolve this internally. Options for the maintainer: (a) approve a
  small set of new node types (mirroring existing granularity) + the model subtree before
  implementation; (b) accept incomplete dogfood coverage for the increment's duration,
  flagged honestly; (c) broaden an existing type's when: — also a gated graph edit.

## E. Test-harness implications

- New fixture family needed: tests/fixtures/roots/bindings/<grammar>.json (committed
  binding snapshots) + tests/fixtures/roots/golden/<grammar>/ (golden repos with scripted
  history + MUST-mine/MUST-NOT-mine assertions) — NO precedent in the repo (the only
  golden today is a value-pinning JSON: pair-hash-golden.json).
- git-fixture.ts determinism block confirmed ABSENT (no GIT_AUTHOR_DATE/COMMITTER_DATE,
  no TZ=UTC, no init.defaultBranch pin) — a named prerequisite for golden repos.
- E2E convention live: 131 spawned-bin.js test files; a roots-* family follows it.
- Genericity lint (P6) is NOT a drop-in: eslint.config.js has no custom-rule scaffolding
  and carries a cautionary note about a REMOVED eslint-plugin-boundaries setup whose
  resolver silently no-opped under flat config — the plan must prove the lint fires
  (a red-case test), not assume it.

## F. Risks a plan must resolve

1. Architecture coverage (D) — user-gated, must precede or accompany implementation.
2. Genericity-lint mechanism — documented local failure precedent; require evidence.
3. Golden-repo infrastructure — new pattern, budget explicitly (incl. git determinism).
4. 6-vs-13 goldens boundary — increment 2 scope is the 6 measured grammars; say so.
5. mine() decomposition — R3/R4 code seam less clean than spec sections suggest.
6. role_lift — no reference implementation; fresh from spec formula.
7. Roots storage = third shape — validate against init-scaffold machinery explicitly.
