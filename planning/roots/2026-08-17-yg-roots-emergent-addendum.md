# Addendum: Total-genericity (emergent) deep test — results & refinements

**Probe:** `probe-emergent.mjs` — ZERO semantic predicates. Eight generic enumerators over raw trees/paths: name morphology (char-class runs — casing *emerges*), arity bands, node-type presence, statement sequences, return-shape, callee/decorator vocabulary, path segments, import specifiers + supertypes. Same v5 math (KT, MDL + index cost, fire-ability + raw-share gates). Post-mining: correlation dedup (conform-set Jaccard ≥ 0.9 ⇒ one FACT), generic per-enumerator verbalizer, vacuous-fact filter. Runs: immich, nest, Yggdrasil.

## Headline: the framework ontology was DISCOVERED, not declared

nest (with zero knowledge of NestJS):
- guards → `extend CanActivate` (share 1.0) · interceptors → `extend NestInterceptor` (1.0) · pipes → `extend PipeTransform` (1.0) · resolvers → `@Resolver` (1.0) · controllers → `@Controller` (1.0) · services → `@Injectable` (1.0) · exception roles → `extend RuntimeException` (1.0) · `canActivate` methods → `return true-literal` (0.9)

immich: dto-role → `extend createZodDto` (0.97, real deviant: `ReactionLevel` enum w pliku dto) · repository-role → `@InjectKysely` (0.81) · schema-role → `@Table` (0.94) · sync-handlers → always `await` (0.94) · generated SDK: 93 correlated surfaces → **1 fact** ("bodies are single return-expressions").

Yggdrasil (dogfood): `files do not import web-tree-sitter` (0.94; 22 deviants = the AST layer — matches the repo's authored aspect) · type-name morphology `(Ua)+` with real deviants (`Violation`, `DB`) · dependency-shape facts (`do not import ../../model/graph.js` — the graph-access boundary).

Sample rendered message (all fields machine-generated from the discovery + exemplars):
```
[roots] group "guard" convention: types here extend `CanActivate`
In this repo, 10/10 established types of this group extend `CanActivate`.
Your type `RolesGuard` does not.
See the pattern: integration/.../auth.guard.ts:6 `AuthGuard` · common/guards/roles.guard.ts:5 `RolesGuard`
```

## Numbers
| | immich | nest | Yggdrasil |
|---|---|---|---|
| scopes | 4 695 | 5 161 | 3 026 |
| eligible convs → FACTS after dedup | 339→42 | 486→80 | 231→24 |
| dedup compression | 3.5–14× | 5–7× | 6–10× |
| runtime (full pipeline) | 3.2 s | 2.5 s | 2.5 s |
| ambiguity (rich features, nest _root) | — | **39%** | — |
| ambiguity (sparse features) | 56–70% | 63–69% | 56–85% |

## Refinements the deep test produced (each empirically motivated)
1. **Vacuous-fact filter (implemented, validated):** a vocabulary-derived negative ("never calls X") where X has zero occurrences in the partition is a non-choice, not a convention — P1's own logic ("the partition never voted"). Cut sdk noise 117→7 eligible.
2. **Correlation dedup is load-bearing, not cosmetic:** one latent fact spawns 2–93 surface predicates; conform-set clustering (J ≥ 0.9) with lead = max bits/instance is the difference between 42 facts and 339 messages.
3. **τ recalibration for the generic space:** the 0.85–0.92-share band yields weak style negatives ("never contains a ternary") that pass τ = 2.5 but are poor speech. For emergent vocabularies τ ≈ 3.5 (boolean boundary ~0.92) fits; alternatively a higher bar for absence-facts only. **Absence facts should also be a separate message tier** (they read as prohibitions and deserve stricter thresholds).
4. **Normalize relative imports to repo paths** before vocabulary building (`../core/check.js` vs `./check.js` are one edge today, two tokens in the probe).
5. **Per-partition vocabulary enumeration** (probe used global vocab; cross-partition tokens leak as vacuous negatives — the filter catches most, per-partition vocab removes the class).
6. **Role ambiguity is a feature-richness problem, confirmed:** nest's `_root` with decorator+supertype features hit 39% ambiguity vs 56–85% elsewhere — the v6 feature bags should include decorator and callee vocabulary (both generic), which the probe shows directly reduces the silence rate.
7. **Default exclusions must cover tool-state dirs** (`.yggdrasil/**` drills polluted the dogfood run's `_root`).

## Verdict for the v6 direction
Total genericity is not only viable on the v5 statistical chassis — on convention-rich repos it **outperforms the hand catalog** (25 vs 5 role conventions on immich server; the entire NestJS ontology self-discovered on nest) while keeping 0 null false-positives at C up to 4 663 candidates. The messages are fully machine-generated (enumerator template + exemplars) and agent-actionable. The costs are known and bounded: dedup + vacuous filtering + τ recalibration + absence-tier — all four now empirically specified. Recommended v6 rewrite scope: §7 → eight enumerators + vocabulary/support rules + dedup; §10 → agent-as-witness (exemplar-contrast) with an optional recognizer pack for named fixes; §11 → generic verbalizer; Appendix B/C → recognizer pack (optional UX layer, not a gate).
