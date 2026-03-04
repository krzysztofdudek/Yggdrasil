# Exp 3.4: Minimum Viable Graph — Findings

## The Data

| Stage | Nodes | Total Score | % of Full Graph |
|-------|-------|-------------|-----------------|
| Hub-only (2) | TeamService + UserService | 66/125 | 56% |
| Stage 1 (2) | TeamService + TeamCollectionService | 87/125 | 74% |
| Stage 2 (4) | + UserService + TeamInvitationService | 109/125 | 92% |
| Stage 3 (6) | + AdminService + TeamRequestService | 114/125 | 97% |
| Stage 4 (8) | Full graph (baseline from Exp 8) | 118/125 | 100% |

## Finding 1: The Inflection Point is at 4 Nodes

The biggest single jump occurs from Stage 1 (2 nodes) to Stage 2 (4 nodes): **+22 points**.
After that, returns diminish rapidly:

| Transition | Delta | Marginal value per node |
|------------|-------|------------------------|
| 2 → 4 nodes | +22 | **+11.0 per node** |
| 4 → 6 nodes | +5 | +2.5 per node |
| 6 → 8 nodes | +4 | +2.0 per node |

At 4 nodes, the graph already achieves **92% of the full graph's score**. The remaining
4 nodes provide only 8% additional value. The 80% threshold (94.4 points) is crossed
between Stage 1 and Stage 2 — meaning 4 well-chosen nodes are sufficient for 80%+ quality.

**Why the 2→4 jump is so large:** Adding TeamInvitationService unlocks the Q2 flow
(+10 points on that question alone). Q2 is fundamentally unanswerable without knowing the
invitation acceptance workflow. This demonstrates that **flow participants are more valuable
than peripheral services** — the 2→4 selection was guided by flow participation
(team-member-lifecycle), not by connectivity metrics.

## Finding 2: The Hub Node Hypothesis FAILS

| 2-node configuration | Score | % of Full |
|---------------------|-------|-----------|
| **Core pair** (TS + TCS) | 87/125 | 74% |
| **Hub pair** (TS + US) | 66/125 | 56% |

The hub-only configuration (highest-connectivity nodes) scores **21 points lower** than the
core dependency pair. This is a decisive refutation of the hypothesis that high-connectivity
nodes provide disproportionate value.

**Why hub nodes fail:** UserService has high connectivity (many services reference it) but
low domain relevance for these specific questions. TeamCollectionService is the subject of
most questions — its presence in Stage 1 provides direct answers, while UserService in the
hub configuration provides almost nothing.

**The lesson:** Node selection should be based on **domain centrality to the question space**,
not graph connectivity. For a set of questions about team collections, the service that
manages collections matters more than the service with the most edges.

## Finding 3: Node Selection Matters More Than Node Count

Compare two 2-node configurations:
- Core pair (TS+TCS): 87 points, answers Q3 at 84% quality, Q4 at 83%
- Hub pair (TS+US): 66 points, answers Q3 at 44% quality, Q4 at 67%

With identical node counts, the right 2 nodes provide **32% more value** than the wrong 2.
This has a direct product implication: **selective context assembly based on query relevance
should outperform naive "load everything" approaches**.

## Finding 4: Per-Question Inflection Patterns

Each question has a different "unlocking" stage:

| Question | Unlocked at | Why |
|----------|-------------|-----|
| Q1 (impact) | Stage 2 (4 nodes) | Each additional consumer service adds blast radius coverage |
| Q2 (flow) | Stage 2 (4 nodes) | TeamInvitationService completes the flow (+10 points) |
| Q3 (locking) | Stage 3 (6 nodes) | TeamRequestService adds the second affected service (→25/25) |
| Q4 (access) | Stage 1 (2 nodes) | TeamCollectionService + aspects provide 83% answer at 2 nodes |
| Q5 (PubSub) | Never fully | Aspect-level description masks implementation exceptions at all stages |

Key patterns:
- **Q4 is cheap** — answerable at 83% quality with just 2 nodes because the answer derives
  primarily from aspect-level reasoning (team-ownership, role-based-access).
- **Q2 is binary** — the flow is either complete or not; no partial credit for having half
  the participants. Adding TeamInvitationService was the single most valuable node addition
  in the entire experiment (+10 points on one question).
- **Q3 reaches full score at 6 nodes** — needs both TeamCollectionService AND TeamRequestService
  to enumerate all affected services. The pessimistic-locking aspect rationale is available at
  Stage 1 (comes with TeamCollectionService context), providing the WHY even at 2 nodes.
- **Q5 never reaches full accuracy** — the PubSub failure question exposed an inherent graph
  limitation: aspect-level descriptions mask per-node implementation deviations (await vs
  fire-and-forget). Adding more nodes adds completeness (more services categorized) but
  doesn't fix the accuracy problem. This is consistent with Exp 3.1a findings: only
  `aspect_exceptions` can close this gap.

## Finding 5: Diminishing Returns Are Steep

The marginal value curve drops from 11.0 per node (Stage 1→2) to 2.0 per node (Stage 3→4).
This means:

- **The first 4 nodes provide 92% of value** (if well-chosen)
- **Nodes 5-8 provide only 8% additional value**
- **Extrapolating:** In a 50-node graph, loading all 50 nodes would waste significant context
  budget. Loading the 4-6 most relevant nodes would provide nearly equivalent quality.

This strongly supports **selective context assembly** over **full graph loading** as the
default strategy.

## Implications for Yggdrasil

### 1. Selective Context Assembly Should Be Default

At 4 well-chosen nodes achieving 92% of full graph quality, "load everything" is wasteful.
The product should support query-aware context selection:
- Analyze the question/task to identify which nodes are relevant
- Load those nodes + their direct dependencies
- Include aspects that are effective on loaded nodes
- Skip peripheral nodes that add tokens without adding relevant content

### 2. Flow Participation is the Best Selection Heuristic

The biggest quality jump came from adding flow participants (TeamInvitationService for the
team-member-lifecycle flow). This suggests:
- When a question involves a business process → load all flow participants
- When a question involves a specific service → load that service + its declared dependencies
- When a question is architectural → load services that share the relevant aspect

### 3. Node Selection > Node Count

Quality depends more on WHICH nodes are loaded than HOW MANY. Product implications:
- A smart 4-node selection matches an 8-node dump
- Context budget should be spent on relevance, not completeness
- The `yg build-context` command could accept a question/task parameter and select relevant
  nodes automatically

### 4. Hub Nodes Are Not Special

Despite having the most connections, hub nodes (TeamService, UserService) are not
disproportionately valuable. This means:
- Don't prioritize high-connectivity nodes when building a graph incrementally
- Prioritize nodes that are **central to the domain being analyzed**
- A graph built around a specific development area is more valuable than a graph built
  around the most-connected nodes

### 5. The Q5 Ceiling Confirms Exp 3.1a

The PubSub failure question NEVER reaches full accuracy at any node count because the
problem is abstraction fidelity, not coverage. This is the same finding as Exp 3.1a:
`aspect_exceptions` are needed to close the gap between aspect-level generalizations
and per-node implementation reality. Adding more nodes cannot fix aspect-level inaccuracy.

---

## Summary

| Metric | Value |
|--------|-------|
| Inflection point (80% quality threshold) | **4 nodes** |
| Full graph quality at inflection | **92%** |
| Marginal value at inflection | **11.0 per node** (drops to 2.5 after) |
| Hub node hypothesis | **REJECTED** (56% vs 74% for core pair) |
| Best selection heuristic | **Flow participation + domain centrality** |
| Unreachable ceiling | **Q5 PubSub accuracy** (aspect abstraction gap) |
