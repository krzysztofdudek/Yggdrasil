# Experiment Series 3: Iteration — Final Synthesis

## Executive Summary

Five experiments validated improvements from Experiment Series 2 and explored new
dimensions of Yggdrasil's value proposition. Key results:

| Experiment | Core Finding |
|------------|-------------|
| **3.1a** aspect_exceptions | WORKS. Score 20→24/25, beats raw code (22). |
| **3.1b** completeness audit | FAILS for aspect-level omissions. 0% detection unchanged. |
| **3.1c** infrastructure nodes | WORKS. Blast radius 22%→85%, score 25/25. |
| **3.2** token efficiency | 45,779 tokens for 8 nodes. Practical limit ~25-30 nodes in 128k window. |
| **3.3** inter-agent consistency | 90-98% overlap, 0% contradictions between independent agents. |
| **3.4** minimum viable graph | Inflection at 4 nodes (92% of full graph quality). Hub hypothesis REJECTED. |
| **3.5** cross-stack (Django) | Yggdrasil is language-agnostic. Same ~7% improvement over raw code. |

---

## What Works

### 1. aspect_exceptions Close the Abstraction-Accuracy Gap (Exp 3.1a)

The single most impactful product feature validated. When an aspect says "fire-and-forget
PubSub" but a specific node awaits the publish call, `aspect_exceptions` record this
deviation in the node's context. Result: the agent answers Q5 (PubSub failure impact)
at 24/25, beating both the original graph (20/25) and raw code (22/25).

**Why this matters:** Abstractions are powerful but dangerous. They enable reasoning at
scale while potentially masking implementation details. `aspect_exceptions` provide the
safety valve — the generalization + its exceptions, delivered together.

### 2. Infrastructure Nodes Eliminate the Guard Blind Spot (Exp 3.1c)

Modeling guards/middleware/decorators as infrastructure nodes expanded `getTeamMember`
blast radius from 22% (4/18 call sites) to 85% (10/10 confirmed service + guard sites).
The full graph now scores 25/25 on both impact analysis (Q1) and access control (Q4).

**Why this matters:** Guards/middleware/decorators are the real authorization enforcement
layer. They run without being explicitly called, making them invisible in normal call
graphs. The infrastructure node type makes them visible.

### 3. Graph Construction is Deterministic (Exp 3.3)

Two independent agents building graphs for the same code produced 90-98% identical
results with 0% contradictions. The 2-10% divergence is exclusively additive (one agent
found an edge case the other didn't). Neither invented wrong information. Both correctly
used "rationale: unknown" for unobservable design decisions.

**Why this matters:** Yggdrasil graphs are reproducible. Different agents, different sessions,
same source code → same graph. This means the representation is objective, not subjective.

### 4. Yggdrasil is Language-Agnostic (Exp 3.5)

All core concepts (aspects, infrastructure nodes, aspect_exceptions, flows, relations)
mapped cleanly to Python/Django without modification. The scoring pattern matched
Hoppscotch: graph provides ~7% improvement over raw code, concentrated in Rationale.
No schema changes needed for Python support.

**Why this matters:** Yggdrasil is not a TypeScript/NestJS tool. It works for any codebase
where cross-module understanding matters.

---

## What Doesn't Work

### 1. Completeness Audit Fails for Aspect-Level Omissions (Exp 3.1b)

The Graph Audit completeness prompt improved method-level coverage (16 findings vs 14)
but still failed to detect the planted omission: a missing "Timing" section in the
PubSub aspect. Root cause: agents check code→graph completeness (method-centric) but
not aspect→properties completeness (artifact-centric).

**Product implication:** Need aspect completeness checklists or templates. The agent needs
to know WHAT sections an aspect should have, not just whether methods are present.

### 2. Aspect-Level Abstractions Can Still Mislead (Exp 3.4, Q5)

Even at 6 or 8 nodes, the PubSub failure question never reaches full accuracy because
the aspect says "events published AFTER transaction commit" while some implementations
deviate. Without `aspect_exceptions`, the agent trusts the aspect and produces a
confidently wrong answer. This was the same finding as Exp 2 Q5 — but now with the
solution validated (aspect_exceptions from Exp 3.1a).

---

## Key Metrics

### Token Efficiency (Exp 3.2)

| Metric | Value |
|--------|-------|
| Total tokens (8 nodes) | 45,779 |
| Average per node | 5,722 |
| Dependency sections share | 54.6% |
| Aspect duplication waste | ~15% |
| Practical limit (128k window) | ~25-30 nodes |
| Best 3-node subset coverage | 60-95% of questions |

### Minimum Viable Graph (Exp 3.4)

| Stage | Nodes | Score | % of Full | Marginal per node |
|-------|-------|-------|-----------|-------------------|
| 2 (core pair) | TS+TCS | 87/125 | 74% | — |
| 4 (flow) | +US+TIS | 109/125 | 92% | 11.0 |
| 6 (extended) | +AS+TRS | 114/125 | 97% | 2.5 |
| 8 (full) | all | 118/125 | 100% | 2.0 |
| Hub-only | TS+US | 66/125 | 56% | — |

### Cross-Stack Comparison (Exp 3.5)

| Metric | NestJS/TypeScript | Python/Django |
|--------|-------------------|---------------|
| Graph total | 118/125 (94%) | 72/75 (96%) |
| Raw code total | 109/125 (87%) | 67/75 (89%) |
| Delta | +9 (7.2%) | +5 (6.7%) |
| Rationale gap | +8 | +3 |

---

## Product Implications

### Confirmed Features (ship with confidence)

1. **aspect_exceptions** — Validated. Closes the abstraction-accuracy gap.
2. **infrastructure node type** — Validated. Captures guards/middleware/decorators.
3. **"rationale: unknown" pattern** — Validated across both languages and independent agents.
4. **Graph Audit consistency step** — Works for catching WRONG information.
5. **Three-artifact structure** (responsibility, interface, internals) — Works cross-stack.

### Roadmap Items (based on experiment findings)

| Priority | Item | Evidence |
|----------|------|----------|
| HIGH | Selective context assembly | Exp 3.4: 4 well-chosen nodes = 92% quality. Loading everything is wasteful. |
| HIGH | Aspect deduplication | Exp 3.2: ~15% token waste from repeated aspect content. |
| HIGH | Dependency depth control | Exp 3.2: Dependency sections are 54.6% of tokens. Depth-1 default would help. |
| MEDIUM | Aspect completeness checklists | Exp 3.1b: Current audit misses aspect-level omissions. |
| MEDIUM | Query-aware node selection | Exp 3.4: Flow participation > connectivity for node selection. |
| LOW | Multi-agent graph merge | Exp 3.3: Two graphs merge additively with 0% conflicts. Could improve coverage. |

### Key Design Principles Validated

1. **Node selection > node count.** The right 2 nodes provide 32% more value than the
   wrong 2. Smart selection beats brute-force loading.

2. **Flow participation is the best selection heuristic.** When a question involves a
   business process, load all flow participants. This beats connectivity-based selection.

3. **Graph advantage is in Rationale, not Completeness.** Raw code matches or exceeds
   the graph on factual completeness. The graph's unique value is WHY, not WHAT.

4. **aspect_exceptions are the safety valve.** Without them, aspects are dangerous
   abstractions. With them, aspects are the most powerful feature in the system.

5. **The representation is deterministic.** Same code → same graph (90%+ consistency).
   This enables trust in the representation.

---

## What's Next

Based on these findings, the highest-impact product work is:

1. **Implement selective context assembly** in `yg build-context` — accept a question/task
   parameter, select relevant nodes automatically using flow participation and relation
   graph, deduplicate aspects across nodes.

2. **Add aspect completeness checking** to Graph Audit — define expected sections per
   aspect and check that each section exists.

3. **Ship aspect_exceptions** as a first-class feature with documentation and examples.

4. **Validate at scale** — test with a 50+ node graph to confirm the 25-30 node
   practical limit and measure selective context assembly improvement.
