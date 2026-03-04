# Exp 3.5: Cross-Stack Generalization — Scoring

## Rubric

Same 5 dimensions as Exp 8, scored 0-5 each:
1. Completeness, 2. Accuracy, 3. Cross-node, 4. Rationale, 5. Actionability

3 questions x 25 points = 75 total.

---

## Agent A (Graph Context Package)

### Q1 (authenticate() impact): 24/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | All callers found: authenticate, aauthenticate, RemoteUserMiddleware, login chain, session. Severity-rated blast radius table. |
| Accuracy | 5 | Silent-skip behavior correctly identified. Return type cascade correct. |
| Cross-node | 5 | Full trace: BaseBackend → __init__ → middleware → session → downstream. Aspect-level reasoning enhances coverage. |
| Rationale | 4 | Cited "allows different backends to accept different credential types." Correctly noted "rationale: unknown." Better framing than raw code. |
| Actionability | 5 | Component-by-component severity table. Clear silent-failure warning. |

### Q2 (request-to-permission flow): 24/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | Complete 6-stage flow. Lazy evaluation, session hash, fallback, permission caching, decorator/mixin difference. |
| Accuracy | 5 | All claims correct. LoginRequiredMiddleware interaction correctly placed. |
| Cross-node | 5 | Full cross-module trace using flow + node context. Aspect integration into narrative. |
| Rationale | 4 | "Password-change protection" = functional WHY. Lazy-evaluation aspect provides design reasoning. Some decisions "rationale: unknown." |
| Actionability | 5 | Complete, usable flow. Key behavioral differences highlighted. |

### Q3 (three parallel mechanisms): 24/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | All three mechanisms. Trade-off table with async, scope, security model. When-to-use guidance. |
| Accuracy | 5 | Async exception for mixins correctly from aspect_exception. Decorator/mixin behavioral difference correct. |
| Cross-node | 5 | Excellent aspect-level reasoning: redirect-or-deny duplication, async-sync-duality exception, attribute protocol. |
| Rationale | 4 | Aspect framing provides design-level context. "Pattern duplicated... nearly identical logic" = structural observation. No explicit decision record for coexistence. |
| Actionability | 5 | Trade-off table, per-mechanism guidance, composition explanation. |

**Agent A Total: 72/75 (96%)**

---

## Agent C (Raw Code)

### Q1 (authenticate() impact): 23/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | ALL callers found with exact code references. _get_compatible_backends mechanism fully traced. |
| Accuracy | 5 | All claims correct. Code-level precision (line numbers, exact signatures). |
| Cross-node | 5 | Full trace through __init__, middleware, backend chain, session. |
| Rationale | 3 | Found comment about credential compatibility but couldn't explain broader architectural decision. |
| Actionability | 5 | Clear blast radius summary. Circuit-breaker metaphor useful. |

### Q2 (request-to-permission flow): 23/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | Complete 6-stage flow with code references. Lazy evaluation fully traced. |
| Accuracy | 5 | All code-level claims correct. Exact function signatures. |
| Cross-node | 5 | Full trace: middleware → __init__ → session → backend → models → decorator → view. |
| Rationale | 3 | "Structure implies purpose" for lazy eval. "Security concern" for session hash. But WHY for design choices is thin. |
| Actionability | 5 | Complete, detailed, usable as documentation. |

### Q3 (three parallel mechanisms): 21/25

| Dim | Score | Notes |
|-----|-------|-------|
| Completeness | 5 | All three mechanisms with key differences. Trade-off analysis. |
| Accuracy | 5 | Mixin vs decorator handle_no_permission difference correctly identified. |
| Cross-node | 4 | Good analysis but less architectural framing than graph agent. |
| Rationale | 3 | "Historical layering implied." "Code does NOT explain WHY." No design-level framing. |
| Actionability | 4 | Trade-off table, when-to-use guidance. Less structured than graph version. |

**Agent C Total: 67/75 (89%)**

---

## Comparison

| Question | Agent A (Graph) | Agent C (Raw Code) | Delta |
|----------|----------------|--------------------|-------|
| Q1 | 24/25 | 23/25 | +1 |
| Q2 | 24/25 | 23/25 | +1 |
| Q3 | 24/25 | 21/25 | **+3** |
| **Total** | **72/75** | **67/75** | **+5** |

### Per-Dimension Comparison

| Dimension | Agent A | Agent C | Delta |
|-----------|---------|---------|-------|
| Completeness | 15/15 | 15/15 | 0 |
| Accuracy | 15/15 | 15/15 | 0 |
| Cross-node | 15/15 | 14/15 | +1 |
| Rationale | 12/15 | 9/15 | **+3** |
| Actionability | 15/15 | 14/15 | +1 |

**The graph advantage is primarily in the Rationale dimension (+3)** — consistent with
Hoppscotch findings where aspects provide design-level context that code cannot.
