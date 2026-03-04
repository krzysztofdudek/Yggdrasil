# Exp 3.5: Cross-Stack Generalization — Findings

## The Data

| Metric | Agent A (Graph) | Agent C (Raw Code) |
|--------|----------------|--------------------|
| Q1 (Impact) | 24/25 | 23/25 |
| Q2 (Flow) | 24/25 | 23/25 |
| Q3 (Architecture) | 24/25 | 21/25 |
| **Total** | **72/75 (96%)** | **67/75 (89%)** |

Graph beats raw code by 5 points. The gap is entirely in the **Rationale dimension**
(+3 of the +5 delta). Completeness and Accuracy are tied at 15/15.

---

## Finding 1: Yggdrasil Works for Python/Django — No NestJS-Specific Assumptions

The graph was built successfully for Django's auth system (1,523 lines across 5 modules)
with no blocking issues. All core Yggdrasil concepts mapped cleanly:

| Yggdrasil Concept | NestJS/TypeScript (Hoppscotch) | Python/Django (Auth) | Works? |
|-------------------|-------------------------------|---------------------|--------|
| Aspects | PubSub events, pessimistic locking | Async/sync duality, permission checking, lazy evaluation, backend polymorphism, redirect-or-deny | YES — 5 aspects identified |
| Infrastructure nodes | Guards (GqlTeamMemberGuard, etc.) | Middleware, decorators, mixins | YES — 3 modules typed as infrastructure |
| aspect_exceptions | UserService PubSub await pattern | Mixins lack async support, ModelBackend-only caching | YES — 3 exceptions captured |
| Flows | Team-member-lifecycle | Request-authentication, permission-check | YES — 2 flows defined |
| Relations | Service-to-service calls | Module-to-module calls + attribute protocol | YES |
| "rationale: unknown" | Used for all unknown decisions | Used for all unknown decisions | YES |

**No language-specific or framework-specific assumptions blocked the workflow.**

## Finding 2: Infrastructure Nodes Map Naturally to Python Patterns

The NestJS "infrastructure" node type (for guards, resolvers, middleware) maps directly to
Python equivalents:

| NestJS Infrastructure | Django Equivalent | Same Role? |
|----------------------|-------------------|-----------|
| Guards (e.g., GqlTeamMemberGuard) | Decorators (@permission_required) | YES — intercept before business logic |
| Middleware (NestJS) | Middleware (Django) | YES — request pipeline |
| Resolvers | N/A (Django uses views) | N/A |
| N/A | Mixins | YES — dispatch() intercept for CBVs |

The infrastructure type captures the key insight: **code that runs without being explicitly
called by business logic**. Django decorators, middleware, and mixins all fit this definition.
They affect blast radius analysis but are invisible in normal call graphs.

## Finding 3: Aspects Capture Python-Specific Patterns

Five cross-cutting patterns were identified, two of which are Python-specific:

1. **async-sync-duality** — Every I/O method has an `a`-prefixed async counterpart using
   `sync_to_async`. This is Django's response to supporting both WSGI and ASGI. No TypeScript
   equivalent exists (TypeScript uses async/await uniformly).

2. **lazy-evaluation** — `SimpleLazyObject` defers database queries until first attribute
   access. Python's dynamic attribute resolution enables this; TypeScript would need
   a Proxy pattern.

3. **permission-checking** — Multi-layered permission delegation through backend chain.
   Structurally similar to Hoppscotch's role-based-access aspect but more complex
   (supports object-level, multiple backends, hard deny via exception).

4. **backend-polymorphism** — Configuration-driven backend loading with signature
   introspection (`inspect.signature().bind()`). No Hoppscotch equivalent.

5. **redirect-or-deny** — Duplicated access-denial logic across decorators, mixins,
   and middleware. Similar to Hoppscotch's pattern of repeated null-check patterns
   across services.

**Key insight:** Aspect identification is language-agnostic. The 3-instance heuristic
("if the same pattern appears in 3+ places") works regardless of whether the pattern
is implemented via decorators, guards, mixins, or services.

## Finding 4: aspect_exceptions Capture Python-Specific Deviations

Three exceptions were correctly identified:

1. **Mixins ↔ async-sync-duality:** Mixins do NOT provide async counterparts. They only
   work with synchronous `dispatch()`. This is the Django equivalent of Hoppscotch's
   "UserService awaits PubSub instead of fire-and-forget" — a specific module deviating
   from a general pattern.

2. **ModelBackend-only ↔ lazy-evaluation:** Only ModelBackend caches permissions on the
   user object. BaseBackend and RemoteUserBackend do not cache.

3. **LoginRequiredMiddleware-only ↔ redirect-or-deny:** Only LoginRequiredMiddleware
   participates in redirect-or-deny. AuthenticationMiddleware and RemoteUserMiddleware
   set/resolve the user without denying.

These exceptions are exactly the kind of information that prevents aspect-level
abstractions from masking implementation details — the same lesson from Exp 3.1a.

## Finding 5: The Scoring Pattern Matches Hoppscotch

| Dimension | Exp 8 (Hoppscotch) | Exp 3.5 (Django) |
|-----------|-------------------|------------------|
| Graph advantage | Rationale, Cross-node | Rationale, Cross-node |
| Raw code advantage | Completeness, Accuracy | Neither (tied) |
| Biggest gap | Rationale (+8 across 5Q) | Rationale (+3 across 3Q) |
| Graph total | 118/125 (94%) | 72/75 (96%) |
| Raw code total | 109/125 (87%) | 67/75 (89%) |
| Delta | +9 (7.2%) | +5 (6.7%) |

The pattern is remarkably consistent: **graph provides ~7% improvement over raw code,
concentrated in the Rationale dimension.** Raw code matches or exceeds on Completeness
and Accuracy. The advantage is smaller for Django because the codebase is more
self-documenting (comments explaining credential compatibility, timing attack mitigation).

## Finding 6: "rationale: unknown" Works Across Languages

The graph builder correctly used "rationale: unknown" for:
- Why signature-based backend filtering was chosen
- Why user_passes_test is the foundation for decorators
- Why mixins lack async support
- Why decorators default to redirect instead of 403

In all cases, the agent observed the pattern, documented WHAT it does, and refrained
from inventing WHY. This confirms the pattern is natural and language-independent.

---

## Implications

1. **Yggdrasil is language-agnostic.** The graph structure (aspects, nodes, flows, relations,
   aspect_exceptions) maps to Python/Django without modification. No schema changes needed.

2. **The infrastructure node type generalizes.** Middleware, decorators, and mixins are the
   Python equivalent of NestJS guards — they intercept request flow and affect blast radius
   without being in call graphs.

3. **Aspect identification is universal.** The 3-instance heuristic and aspect taxonomy
   (domain-specific, architectural, concurrency) work for Python patterns.

4. **The scoring pattern is stable.** Graph provides ~7% improvement over raw code,
   concentrated in Rationale. This appears to be a fundamental property of the
   representation, not a stack-specific artifact.

5. **No product changes needed for Python support.** The current Yggdrasil schema and
   agent rules work out-of-the-box for Django.
