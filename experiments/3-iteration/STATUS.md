# Experiment Series 3: Iteration — Validating Improvements

**Started:** 2026-03-04
**Status:** IN PROGRESS

## Overview

Five experiments testing whether improvements implemented after Experiment Series 2 actually work,
plus new dimensions (token efficiency, agent consistency, minimum viable graph, cross-stack).

## Experiments

### Exp 3.1: Validation of Fixes

**Status:** COMPLETE
**Goal:** Re-run failing scenarios from Exp 8 and 9 with new product features enabled.

| ID | Re-runs | Tests Feature | Status | Result |
|----|---------|---------------|--------|--------|
| 3.1a | Exp 8 Q5 (PubSub failure) | `aspect_exceptions` | DONE | 20→24/25, beats raw code (22) |
| 3.1b | Exp 9 C2 (missing invariant) | Completeness audit | DONE | Still 0% on planted omission |
| 3.1c | Exp 8 Q1/Q4 (guard blind spot) | `infrastructure` nodes | DONE | 22%→85% blast radius, 25/25 |

**Key findings:**

- **3.1a: aspect_exceptions WORK.** Score went from 20/25 to 24/25, now BEATS raw code (22/25).
  Agent correctly identified all 6 PubSub deviations and their failure mechanisms.
- **3.1b: Completeness audit DOES NOT solve aspect-level omissions.** The prompt improves
  method-level coverage (16 findings vs 14) but still fails to detect the missing timing
  section in the PubSub aspect. Root cause: agent checks code→graph completeness
  (method-centric) but not aspect→properties completeness (artifact-centric).
  **Product implication:** Need aspect completeness checklists or templates.
- **3.1c: Infrastructure nodes WORK.** Blast radius from 22% to 85%. Enhanced graph
  scores 25/25 on both Q1 and Q4, beating raw code (22/25 on both). Guards named
  with resolution chains and role-vs-null-check distinction.

---

### Exp 3.2: Token Efficiency and Context Scaling

**Status:** COMPLETE
**Goal:** Measure how context package size scales with graph size and at what point it becomes impractical.

**Results:**

| Metric | Value |
|--------|-------|
| Total tokens (8 nodes) | 45,779 |
| Average per node | 5,722 |
| Smallest node | AuthService (2,189) |
| Largest node | TeamCollectionService (12,267) |
| Dependency sections share | 54.6% of total |
| Aspect duplication waste | ~15% (~6,680 tokens) |
| Practical limit (128k window) | ~25-30 nodes full-load |

**Key findings:**

- **Dependency sections dominate** — 54.6% of all tokens are dependency context (other nodes'
  artifacts included for relational understanding). This is the primary scaling bottleneck.
- **Aspect duplication** wastes ~15%. The same aspect content is repeated in every node that
  uses it. Deduplication would save ~6,680 tokens across 8 nodes.
- **Signal utilization is uneven.** TeamCollectionService used in 5/5 Exp 8 questions,
  AuthService in 1/5 (absence only). Best 3-node subset (TeamCollectionService + TeamService +
  TeamInvitationService) covers 60-95% of questions with 38.6% of tokens.
- **Scaling projection:** At current per-node cost (~5.7k tokens), 128k window supports
  ~22 nodes full-load. With deduplication and selective assembly, practical limit is ~25-30 nodes.

**Product implications:**
1. Dependency depth control (limit to depth-1 by default)
2. Aspect deduplication in context assembly
3. Selective context assembly (load relevant nodes, not all)
4. Hub node summarization for high-connectivity nodes

---

### Exp 3.3: Inter-Agent Consistency

**Status:** COMPLETE
**Goal:** Test whether two independent agents building graphs for the same code produce consistent results.

**Design executed:** Two independent agents (Alpha and Beta) built Yggdrasil graphs for
ShortcodeService (342 lines, Hoppscotch) from identical source code with identical prompts.

**Results:**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Structural similarity | 90% | Same type, aspects, relations (Beta +1 consumer) |
| Semantic equivalence | 95% | Same responsibility scope (Beta +expiry absence) |
| Interface completeness | 98% | Same methods, signatures, error codes |
| Internals equivalence | 90% | Same core logic; Beta found TOCTOU, Alpha found key-ordering |
| Contradiction rate | 0% | No mutually exclusive claims |
| Aspect identification | 100% | Same 4 concepts identified independently |

**Key findings:**

- **Independent agents produce 90-98% consistent graphs with 0% contradictions.**
  The representation is largely deterministic.
- **The 2-10% divergence is exclusively ADDITIVE** — Beta found the TOCTOU race condition;
  Alpha found JSON key-ordering side effect. Neither invented wrong information.
- **Both used "rationale: unknown" correctly** for all decisions where WHY was not observable.
- **Combining two independently-built graphs would be strictly additive** — a merge would
  contain everything in both with no conflicts to resolve.

---

### Exp 3.4: Minimum Viable Graph

**Status:** COMPLETE
**Goal:** Find the inflection point where cross-module graph reasoning starts providing value.

**Results:**

| Stage | Nodes | Score | % of Full |
|-------|-------|-------|-----------|
| Hub-only (2) | TeamService + UserService | 66/125 | 56% |
| Stage 1 (2) | TeamService + TeamCollectionService | 87/125 | 74% |
| Stage 2 (4) | + UserService + TeamInvitationService | 109/125 | 92% |
| Stage 3 (6) | + AdminService + TeamRequestService | 114/125 | 97% |
| Stage 4 (8) | Full graph (Exp 8 baseline) | 118/125 | 100% |

**Key findings:**

- **Inflection point is at 4 nodes.** The 2→4 node transition provides +22 points (+11 per
  node). After that, marginal value drops to 2.5 per node (4→6) and 2.0 per node (6→8).
  4 well-chosen nodes achieve 92% of full graph quality.
- **Hub node hypothesis REJECTED.** Hub-only (66/125) scores 21 points lower than the core
  dependency pair (87/125). High connectivity ≠ high value. Domain centrality matters more.
- **Node selection matters more than node count.** The right 2 nodes (core pair) provide 32%
  more value than the wrong 2 (hub pair) despite identical count.
- **Flow participation is the best selection heuristic.** The biggest jump came from adding
  flow participants (TeamInvitationService unlocked Q2 flow: +10 points on one question).
- **Q5 PubSub accuracy never reaches full score** at any node count — the problem is
  aspect abstraction fidelity, confirming Exp 3.1a findings.

---

### Exp 3.5: Cross-Stack Generalization

**Status:** COMPLETE
**Goal:** Test whether Yggdrasil findings hold for non-NestJS/TypeScript codebases.

**Target:** Django Authentication System (5 modules, 1,523 lines)

**Results:**

| Question | Agent A (Graph) | Agent C (Raw Code) | Delta |
|----------|----------------|--------------------|-------|
| Q1 (Impact) | 24/25 | 23/25 | +1 |
| Q2 (Flow) | 24/25 | 23/25 | +1 |
| Q3 (Architecture) | 24/25 | 21/25 | +3 |
| **Total** | **72/75 (96%)** | **67/75 (89%)** | **+5 (7%)** |

**Key findings:**

- **Yggdrasil is language-agnostic.** All concepts (aspects, infrastructure nodes,
  aspect_exceptions, flows) mapped cleanly to Python/Django without modification.
- **5 aspects identified** including 2 Python-specific: async-sync-duality (sync_to_async
  pattern) and lazy-evaluation (SimpleLazyObject).
- **Infrastructure node type works** for Django middleware, decorators, and mixins —
  the Python equivalent of NestJS guards.
- **3 aspect_exceptions captured** Python-specific deviations (e.g., mixins lack async support).
- **Scoring pattern matches Hoppscotch:** Graph provides ~7% improvement over raw code,
  concentrated in Rationale dimension. Raw code matches on Completeness and Accuracy.
- **No schema changes needed** for Python support.

---

## Active Task

All experiments complete. Writing synthesis.

## File Layout

```
experiments/3-iteration/
  STATUS.md                    ← this file
  exp3.1-validation/           ← materials for fix validation
    3.1a-aspect-exceptions/    ← enhanced PubSub context
    3.1b-completeness-audit/   ← C2 re-run with completeness prompt
    3.1c-infrastructure-nodes/ ← guard nodes re-run
  exp3.2-token-efficiency/     ← measurement data and analysis
  exp3.3-agent-consistency/    ← two independent graph builds
  exp3.4-minimum-viable/       ← incremental graph snapshots
  exp3.5-cross-stack/          ← Django experiment
  synthesis.md                 ← final cross-experiment synthesis
```
