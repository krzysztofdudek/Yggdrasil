# Exp 3.4: Minimum Viable Graph — Experiment Design

## Goal

Find the inflection point where adding more nodes to the graph starts providing
diminishing returns for cross-module reasoning. Test the "hub node" hypothesis:
do high-connectivity nodes provide disproportionate value?

## Method

Use the Hoppscotch backend graph (8 nodes) as substrate. At each stage, provide
the agent with ONLY the context packages for the nodes in that stage, then ask
the same 5 cross-module questions from Exp 8. Score answers against the same
gold standard rubric (5 dimensions x 5 points = 25 per question, 125 total).

## Stages

| Stage | Nodes | Selection Rationale | Token Estimate |
|-------|-------|---------------------|---------------|
| 1 (2 nodes) | TeamService + TeamCollectionService | Core dependency pair — most questions reference these | ~11k |
| 2 (4 nodes) | + UserService + TeamInvitationService | Flow participants — complete the team-member-lifecycle | ~20k |
| 3 (6 nodes) | + AdminService + TeamRequestService | Extended graph — adds PubSub and locking coverage | ~38k |
| 4 (8 nodes) | + TeamEnvironmentsService + AuthService | Full graph — baseline from Exp 8 Agent A | ~46k |
| Hub (2 nodes) | TeamService + UserService | Highest-connectivity nodes only | ~7k |

## Scoring Rubric (same as Exp 8)

5 dimensions per question, each scored 0-5:
1. **Completeness** — Coverage of relevant facts and dependencies
2. **Accuracy** — Correctness of stated facts against ground truth
3. **Cross-node** — Ability to reason across service boundaries
4. **Rationale** — Understanding of WHY, not just WHAT
5. **Actionability** — Practical utility for decision-making

## Questions (from Exp 8)

- **Q1:** "If I change `getTeamMember` in TeamService, what breaks in TeamCollectionService and other modules?"
- **Q2:** "Describe the complete flow from receiving a team invitation through to creating a user's first collection."
- **Q3:** "What would it take to switch from pessimistic to optimistic locking?"
- **Q4:** "Can a removed team member still see their previously created collections?"
- **Q5:** "If PubSub fails, which operations fail completely vs degrade gracefully?"

## Baseline (Stage 4 = Exp 8 Agent A)

| Question | Score |
|----------|-------|
| Q1 | 24/25 |
| Q2 | 25/25 |
| Q3 | 25/25 |
| Q4 | 24/25 |
| Q5 | 20/25 |
| **Total** | **118/125** |

## Success Criteria

1. Identify the stage where total score first exceeds 100/125 (80% of full graph)
2. Measure the marginal value of each additional node pair
3. Compare hub-only vs stage-1 (both 2 nodes, different selection)
