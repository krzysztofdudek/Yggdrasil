# Exp 3.5: Cross-Stack Generalization — Experiment Design

## Goal

Test whether Yggdrasil findings hold for non-NestJS/TypeScript codebases.
Specifically: does graph construction work for Python/Django, and do the
product features (aspects, infrastructure nodes, aspect_exceptions) remain useful?

## Target System

**Django Authentication System** (django.contrib.auth)

| Module | File | Lines | Node Type |
|--------|------|-------|-----------|
| decorators | django/contrib/auth/decorators.py | 136 | infrastructure |
| backends | django/contrib/auth/backends.py | 342 | service |
| middleware | django/contrib/auth/middleware.py | 275 | infrastructure |
| mixins | django/contrib/auth/mixins.py | 136 | infrastructure |
| models | django/contrib/auth/models.py | 634 | module |
| **Total** | | **1,523** | |

## Why This Target

1. **Multiple interacting modules** — 5 tightly coupled files with 15+ cross-module calls
2. **Python-specific patterns** — decorators, metaclasses, mixins, async/sync duality
3. **Infrastructure nodes** — middleware and decorators are the Python equivalent of NestJS guards
4. **Cross-cutting patterns** — async/sync duality, permission checking, lazy evaluation
5. **Manageable size** — 1,523 lines total, similar to Hoppscotch experiment scope

## Questions

3 cross-module questions testing the same dimensions as Exp 8:

**Q1 (Impact Analysis):** "If you change the `authenticate()` method signature in
BaseBackend — what breaks across the auth system?"

**Q2 (Flow Tracing):** "Trace the complete flow from HTTP request to a view decorated
with @permission_required returning a response."

**Q3 (Architectural Reasoning):** "Three parallel mechanisms exist for restricting
view access: decorators, mixins, and LoginRequiredMiddleware. Why do all three exist?"

## Method

1. **Agent 1:** Reverse-engineer Django auth into Yggdrasil graph format
   (aspects, nodes with artifacts, flows)
2. **Agent 2 (raw code):** Answer Q1-Q3 from raw code only (baseline)
3. **Create context package** from Agent 1's graph output
4. **Agent 3 (graph):** Answer Q1-Q3 from context package only (blindfold)
5. **Score** both agents on same 5-dimension rubric

## Success Criteria

1. Graph built successfully — aspects, nodes, flows all valid for Python code
2. No NestJS-specific assumptions block the workflow
3. Graph answers achieve comparable quality to raw code answers
4. Python-specific patterns captured: decorators as infrastructure, async/sync as aspect,
   metaclasses handled

## What We're Testing About Yggdrasil

| Feature | Test |
|---------|------|
| Aspect identification | Does async-sync-duality capture a Python pattern correctly? |
| Infrastructure node type | Do middleware/decorators work as infrastructure nodes? |
| aspect_exceptions | Can deviations be captured for Python-specific patterns? |
| Flow modeling | Does request-authentication flow work for Django's pipeline? |
| "rationale: unknown" | Does the agent correctly avoid inventing Django design rationale? |
