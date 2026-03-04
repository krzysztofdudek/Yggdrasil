# Exp 3.2: Token Efficiency and Context Scaling

## Measurements

### Per-Node Context Package Size

| Service | Tokens | Own Artifacts | Dependencies | Aspects | Global |
|---------|--------|---------------|-------------|---------|--------|
| AdminService | 11,798 | ~2,500 | 39,156 chars (~9,800 tok) | pubsub, role-based | 476 chars |
| TeamRequestService | 6,501 | ~2,500 | 13,991 chars (~3,500 tok) | pubsub, team-ownership | 476 chars |
| TeamInvitationService | 6,429 | ~2,500 | 15,476 chars (~3,900 tok) | pubsub, role-based, team-ownership | 476 chars |
| TeamCollectionService | 6,380 | ~4,500 | 7,585 chars (~1,900 tok) | pessimistic, pubsub, retry, team-ownership | 476 chars |
| TeamService | 4,856 | ~3,000 | 7,905 chars (~2,000 tok) | pubsub, role-based | 476 chars |
| TeamEnvironmentsService | 4,021 | ~2,000 | 7,585 chars (~1,900 tok) | pubsub, team-ownership | 476 chars |
| AuthService | 3,165 | ~1,500 | 8,097 chars (~2,000 tok) | (none) | 476 chars |
| UserService | 2,629 | ~2,000 | 0 | pubsub | 476 chars |

**Total across all 8 nodes: 45,779 tokens**
**Average per node: 5,722 tokens**

### Context Budget Distribution

For the full 8-node graph loaded into one prompt (as in Exp 8 Agent A):

| Component | Tokens | % of Total |
|-----------|--------|------------|
| Own artifacts (8 nodes) | ~20,500 | 44.8% |
| Dependency sections | ~25,000 | 54.6% |
| Global config (8x duplicated) | ~950 | 2.1% |
| Aspects (deduplicated) | ~1,720 | 3.8% |
| Flow | ~1,240 | 2.7% |
| Tree + lists | ~500 | 1.1% |

**Note:** Aspects appear ~3,400 tokens total in the raw packages (due to duplication), but
contain only ~1,720 unique tokens. The pubsub-events aspect alone is duplicated 7 times.

### Duplication Analysis

| Duplicated Element | Instances | Waste (tokens) |
|-------------------|-----------|----------------|
| Global config section | 8 copies | ~830 (7 × ~119) |
| pubsub-events aspect | 7 copies | ~1,050 (6 × ~175) |
| team-ownership aspect | 4 copies | ~525 (3 × ~175) |
| role-based-access aspect | 3 copies | ~350 (2 × ~175) |
| pessimistic-locking aspect | 2 copies | ~175 (1 × ~175) |
| TeamService responsibility (in deps) | 5 times | ~2,500 (4 × ~625) |
| UserService responsibility (in deps) | 3 times | ~1,250 (2 × ~625) |
| **Total duplication waste** | | **~6,680 tokens (14.6%)** |

### Dependency Section Dominance

The dependency sections (responsibility + interface of consumed services) account for
54.6% of total context. AdminService alone has 9,800 tokens of dependency context because
it consumes 6 services — each contributing their full responsibility + interface.

This is the primary scaling concern: dependency context grows with the number of relations,
and hub nodes (AdminService) accumulate disproportionate context.

---

## Scaling Projections

### Linear Model (from 8-node data)

| Graph Size | Estimated Total Tokens | Fits in 128k? | Fits in 200k? |
|------------|----------------------|---------------|---------------|
| 8 nodes | 45,779 | Yes | Yes |
| 16 nodes | ~92,000 | Yes (72%) | Yes (46%) |
| 32 nodes | ~184,000 | No (143%) | Yes (92%) |
| 50 nodes | ~286,000 | No | No (143%) |
| 100 nodes | ~572,000 | No | No |

**However:** This assumes loading ALL nodes simultaneously (as in Exp 8 Agent A).
In normal operation, agents load context for 1-3 nodes at a time.

### Per-Query Context Load (Realistic Usage)

| Operation | Nodes Loaded | Estimated Tokens |
|-----------|-------------|-----------------|
| Single node work | 1 | 2,600-11,800 |
| Cross-module analysis | 3-5 | 15,000-35,000 |
| Full system reasoning | 8 (all) | 45,779 |
| Full + guards | 8+7 guards | ~60,000 |

**The 10,000 token warning and 20,000 error thresholds in config.yaml are appropriate.**
AdminService (11,798) already exceeds the warning. At 50+ nodes, hub services would
likely exceed 20,000 without pruning.

---

## Utilization Analysis (from Exp 8 Agent A answers)

### Context Package Utilization Per Question

| Service | Q1 | Q2 | Q3 | Q4 | Q5 | Used in |
|---------|----|----|----|----|----|---------|
| TeamCollectionService | ✓ | ✓ | ✓ | ✓ | ✓ | 5/5 |
| TeamService | ✓ | ✓ | ✗ | ✓ | ✓ | 4/5 |
| AdminService | ✓ | ✗ | ✗ | ✗ | ✓ | 2/5 (shallow) |
| TeamInvitationService | ✓ | ✓ | ✗ | ✗ | ✓ | 3/5 |
| UserService | ✗ | ✓ | ✗ | ✓ | ✓ | 3/5 |
| TeamRequestService | ✗ | ✗ | ✓ | ✗ | ✓ | 2/5 |
| TeamEnvironmentsService | ✗ | ✗ | ✗ | ✗ | ✓ | 1/5 (aspect only) |
| AuthService | ✗ | ✗ | ✗ | ✗ | ✓ | 1/5 (absence only) |

### Signal-to-Noise Ratio

**Highly utilized context (>60% of questions):**
TeamCollectionService (5/5), TeamService (4/5) = 11,236 tokens = 24.5% of total

**Moderately utilized (20-60%):**
TeamInvitationService, UserService, AdminService, TeamRequestService = 25,858 tokens = 56.5%

**Rarely utilized (<20%):**
TeamEnvironmentsService, AuthService = 7,186 tokens = 15.7%

**Signal utilization ratio:** ~85% of context was used in at least one question.
For any single question, utilization drops to ~30-50%.

### Best 3-Node Subset

**TeamCollectionService + TeamService + TeamInvitationService** (17,665 tokens, 38.6% of full):

| Question | Coverage | Gap |
|----------|----------|-----|
| Q1 | ~70% | Missing AdminService indirect path |
| Q2 | ~95% | Missing UserService brief mention |
| Q3 | ~60% | Missing TeamRequestService comparison |
| Q4 | ~90% | Missing UserService deletion detail |
| Q5 | ~40% | Missing 5 services' PubSub status |

This subset provides strong answers for Q2 and Q4 but would fail on Q5 (which by design
requires full system knowledge) and be incomplete on Q1 and Q3.

---

## Key Findings

### 1. Dependency sections are the dominant cost (54.6%)

The largest token expense is not a node's own artifacts but the context of services it
consumes. This grows with relation count. AdminService's 6 relations contribute 9,800
dependency tokens — more than any other node's total context.

**Product implication:** Consider a `--depth` flag for `build-context` that controls how
much dependency context is included: depth=0 (own artifacts only), depth=1 (dependency
responsibility only), depth=2 (full dependency context).

### 2. Aspect duplication wastes ~15% of tokens

The same aspect content is embedded in every node that uses it. For the 8-node graph,
this wastes ~6,680 tokens (14.6%). At 50 nodes with a ubiquitous aspect, the waste
would be proportionally larger.

**Product implication:** Consider deduplicated aspect delivery — emit aspects once at the
top of the context package rather than per-node. This requires restructuring the context
assembly algorithm.

### 3. Per-question utilization is 30-50%, but system-level questions need everything

Most questions use 3-5 service packages. However, system-level questions like Q5
("what happens if PubSub goes down?") require all nodes. The tradeoff is clear:
selective context improves efficiency for focused questions but makes system-level
reasoning impossible.

### 4. The 8-node graph fits comfortably in modern context windows

At 45,779 tokens for full graph + all aspects + flow, the 8-node Hoppscotch graph uses
~36% of a 128k context window, leaving ample room for the prompt and response. The
practical limit for "load everything" is ~25-30 nodes in a 128k window.

### 5. Hub nodes are the bottleneck

AdminService (25.8% of total) is a hub node with many relations. In a larger graph,
hub nodes would dominate context budgets. The existing `max_direct_relations: 10` and
`context_budget.warning: 10000` thresholds are correctly calibrated for this.

---

## Recommendations

1. **Dependency depth control.** `yg build-context --depth 0|1|2` to control context
   inclusion. Most focused work needs depth=1 (dependency responsibility only).

2. **Aspect deduplication.** Emit each aspect once at the top of a multi-node context
   assembly rather than duplicating per node. Saves ~15% at current scale, more at larger.

3. **Selective context assembly.** For cross-module questions, let agents request context
   for specific nodes rather than loading all. The utilization data shows 3 well-chosen
   nodes provide 60-95% coverage for most questions.

4. **Hub node summarization.** For hub nodes like AdminService, offer a summary mode that
   includes only the dependency names and consumed methods, not full responsibility+interface.
