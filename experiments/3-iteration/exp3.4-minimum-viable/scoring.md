# Exp 3.4: Minimum Viable Graph — Scoring

## Rubric

5 dimensions per question, each 0-5:
1. **Completeness** — Coverage of relevant facts and dependencies
2. **Accuracy** — Correctness of stated facts against ground truth
3. **Cross-node** — Ability to reason across service boundaries
4. **Rationale** — Understanding of WHY, not just WHAT
5. **Actionability** — Practical utility for decision-making

---

## Stage 1: 2 nodes (TeamService + TeamCollectionService)

### Q1 (getTeamMember impact): 17/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 3 | Found TeamCollectionService as direct consumer. Mentioned others from aspects but couldn't enumerate. Missing AdminService, TeamInvitationService as confirmed consumers. |
| Accuracy | 4 | All stated facts correct. Properly identified null-check vs role pattern. |
| Cross-node | 3 | Traced between 2 nodes + aspect-level inference. Couldn't trace team-member-lifecycle flow. |
| Rationale | 4 | Good team-ownership reasoning from aspect. |
| Actionability | 3 | Useful within scope but acknowledged major gaps in blast radius. |

### Q2 (invitation-to-collection flow): 14/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 2 | Could NOT describe invitation flow at all (TeamInvitationService missing). Only Phase 2 and 3. |
| Accuracy | 5 | What was described was accurate. |
| Cross-node | 2 | Only 2 services connected, massive gap in the middle. |
| Rationale | 3 | Understood role assignment and pessimistic locking for its parts. |
| Actionability | 2 | Incomplete flow not actionable. |

### Q3 (pessimistic to optimistic): 21/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | Excellent on TeamCollectionService (7 operations). Missing TeamRequestService but acknowledged. |
| Accuracy | 5 | Quoted design rationale correctly. All claims accurate. |
| Cross-node | 3 | One service deeply analyzed; second exists but can't analyze. |
| Rationale | 5 | Quoted explicit aspect rationale for why pessimistic was chosen. KEY advantage. |
| Actionability | 4 | 3 concrete proposals, detailed risk analysis. Missing TeamRequestService specifics. |

### Q4 (removed user visibility): 20/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | No creatorID, team-scoped access, CLI path verification. Missing guard enumeration. |
| Accuracy | 5 | All claims correct. |
| Cross-node | 3 | Synthesized team-ownership + role-based-access aspects. Only 2 services. |
| Rationale | 4 | Good WHY explanation, consequences of no creator tracking. |
| Actionability | 4 | Clear answer with supporting evidence, missing guard names. |

### Q5 (PubSub failure): 15/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 3 | Only 2/7 services' PubSub usage covered. |
| Accuracy | 4 | Correct for analyzed scope. Wisely flagged uncertainty about await vs fire-and-forget. |
| Cross-node | 2 | Only 2 services. |
| Rationale | 3 | Understood "after transaction commit" pattern, couldn't explain variations. |
| Actionability | 3 | Good categorization for 2 services, honestly noted gaps. |

**Stage 1 Total: 87/125**

---

## Stage 2: 4 nodes (+UserService, +TeamInvitationService)

### Q1 (getTeamMember impact): 21/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | Found TCS, TIS (2 uses), AdminService (getTeamMemberTE via aspect reference). Missing TeamEnvironmentsService. |
| Accuracy | 5 | All claims correct. Good detail on per-consumer usage patterns. |
| Cross-node | 4 | Traced across 4 services with specifics. Missing some infrastructure. |
| Rationale | 4 | Good null-check vs role pattern explanation. |
| Actionability | 4 | Concrete breakage scenarios per consumer. |

### Q2 (invitation-to-collection flow): 24/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | Complete 3-phase flow: creation (5 validations), acceptance (3 validations), collection creation (3 checks). All events listed. |
| Accuracy | 5 | Validation order correct. Role assignment mechanics correct. |
| Cross-node | 5 | 4-service trace, coherent narrative. Full invitation→membership→collection path. |
| Rationale | 4 | Good on VIEWER can't create, idempotency re-check. Missing some deeper WHY. |
| Actionability | 5 | Complete, usable as a specification. |

### Q3 (pessimistic to optimistic): 23/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | 6+ operations for TeamCollectionService. TeamRequestService acknowledged but not detailed. |
| Accuracy | 5 | Quoted design rationale correctly. All technical claims accurate. |
| Cross-node | 4 | Collection locking + retry-on-deadlock aspect interaction analyzed. |
| Rationale | 5 | Quoted explicit aspect rationale. Excellent batch-operation reasoning. |
| Actionability | 5 | Concrete change proposals, risk assessment, migration concerns. |

### Q4 (removed user visibility): 22/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | No creatorID, team-scoped, CLI path, guard enforcement, 5 consequences. |
| Accuracy | 5 | All correct. |
| Cross-node | 4 | Team-ownership + role-based-access aspects synthesized. Multiple services. |
| Rationale | 4 | Good WHY. Consequences well-articulated. |
| Actionability | 4 | Clear, definitive. Missing specific guard names. |

### Q5 (PubSub failure): 19/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | 4 services covered. Missing AdminService, TeamEnvironmentsService, AuthService. |
| Accuracy | 4 | Correctly flagged await uncertainty. Didn't make wrong "all degrade" claim. |
| Cross-node | 4 | 4-service analysis with categorization. |
| Rationale | 3 | Pattern understanding good but couldn't explain per-service variations. |
| Actionability | 4 | Good categorization table, noted limitations honestly. |

**Stage 2 Total: 109/125**

---

## Stage 3: 6 nodes (+AdminService, +TeamRequestService)

### Q1 (getTeamMember impact): 21/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 4 | TCS, TIS (2 uses), AdminService (getTeamMemberTE). Internal callers. Missing TeamEnvironmentsService. |
| Accuracy | 5 | All claims correct and detailed. |
| Cross-node | 4 | 4 direct consumers across services. Transitive TeamRequestService impact noted. |
| Rationale | 4 | Membership vs role pattern, sole-owner guard chain. |
| Actionability | 4 | Concrete breakage per service. |

### Q2 (invitation-to-collection flow): 24/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | Complete 3-phase flow. All validations and events. |
| Accuracy | 5 | Correct. |
| Cross-node | 5 | Full 4-service trace with coherent narrative. |
| Rationale | 4 | Good on idempotency, role separation. |
| Actionability | 5 | Complete, usable flow specification. |

### Q3 (pessimistic to optimistic): 25/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | BOTH services fully analyzed. TCS (7+ operations), TRS (4 operations). Schema, retry, migration. |
| Accuracy | 5 | Quoted design rationale. Per-operation analysis for both services correct. |
| Cross-node | 5 | Full cross-service: both affected services, retry-on-deadlock aspect, contiguity invariant. |
| Rationale | 5 | Quoted explicit architectural rationale. Full decision analysis. |
| Actionability | 5 | 6 specific risks, per-service change list, migration considerations. |

### Q4 (removed user visibility): 23/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | No creatorID, team-scoped, CLI path, guard-level, removal paths, cross-team isolation. |
| Accuracy | 5 | All correct. |
| Cross-node | 4 | Aspects synthesized, multiple services checked. |
| Rationale | 4 | WHY team-scoped, 4 specific consequences. |
| Actionability | 5 | Definitive, evidence from multiple context packages. |

### Q5 (PubSub failure): 21/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 5 | All 6 services covered: TCS (8 ops), TRS (5 ops), TS (3), TIS (3), US (3), AS (1). |
| Accuracy | 3 | Made same error as Exp 8 Agent A: "no operations fail completely." Wrong — UserService awaits PubSub in 2 methods (try-catch masking), AdminService awaits without try-catch. Trusted aspect. But did flag the unhandled-exception caveat at end. |
| Cross-node | 5 | All 6 services analyzed systematically. |
| Rationale | 4 | Good pattern understanding. Noted error-handling caveat. |
| Actionability | 4 | Comprehensive categorization, but main conclusion wrong. |

**Stage 3 Total: 114/125**

---

## Stage 4: 8 nodes (full graph — from Exp 8 Agent A)

Scores from Exp 8:

| Q | Comp | Acc | Cross | Rat | Act | Total |
|---|------|-----|-------|-----|-----|-------|
| Q1 | 4 | 5 | 5 | 5 | 5 | 24 |
| Q2 | 5 | 5 | 5 | 5 | 5 | 25 |
| Q3 | 5 | 5 | 5 | 5 | 5 | 25 |
| Q4 | 5 | 5 | 5 | 4 | 5 | 24 |
| Q5 | 4 | 3 | 5 | 4 | 4 | 20 |

**Stage 4 Total: 118/125**

---

## Hub-only: 2 nodes (TeamService + UserService)

### Q1 (getTeamMember impact): 13/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 2 | Only internal TeamService callers found. Could NOT identify any external consumer by name. |
| Accuracy | 4 | What was stated was correct, just limited. |
| Cross-node | 2 | Only TeamService internal impact. External = purely inferred from aspects. |
| Rationale | 3 | Some role-based-access reasoning from aspect. Limited. |
| Actionability | 2 | Not actionable without knowing actual consumers. |

### Q2 (invitation-to-collection flow): 11/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 2 | Only Phase 2 (membership creation). Missing invitation AND collection phases entirely. |
| Accuracy | 4 | What was described was accurate. |
| Cross-node | 1 | Barely any cross-node tracing. Only TS→US (email resolution). |
| Rationale | 2 | Some role reasoning but couldn't explain the flow's design. |
| Actionability | 2 | Incomplete, not useful for understanding the full flow. |

### Q3 (pessimistic to optimistic): 11/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 2 | Knew locking exists from global standards but couldn't enumerate operations. |
| Accuracy | 4 | Correct about lockTeamCollectionByTeamAndParent from global standards. |
| Cross-node | 1 | Couldn't analyze either affected service. |
| Rationale | 2 | No pessimistic-locking aspect available (it's on TCS/TRS, not TS/US). |
| Actionability | 2 | Generic description, no specifics. |

### Q4 (removed user visibility): 16/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 3 | Good aspect-level reasoning. Couldn't confirm no creatorID without TCS schema. |
| Accuracy | 4 | Correct conclusion, but flagged as uncertain about creatorUid. |
| Cross-node | 3 | Aspect synthesis (team-ownership + role-based-access). |
| Rationale | 3 | Reasonable "clean cut" explanation but uncertain. |
| Actionability | 3 | Correct answer with uncertainty caveats. |

### Q5 (PubSub failure): 15/25

| Dim | Score | Rationale |
|-----|-------|-----------|
| Completeness | 3 | 2/7 services covered (TeamService + UserService). |
| Accuracy | 4 | Correctly raised await question without wrong confident answer. |
| Cross-node | 2 | Only 2 services. |
| Rationale | 3 | "After transaction commit" pattern understood. |
| Actionability | 3 | Table for 2 services with noted limitations. |

**Hub-only Total: 66/125**

---

## Summary Scoring Matrix

| Stage | Nodes | Q1 | Q2 | Q3 | Q4 | Q5 | Total | % of Full |
|-------|-------|----|----|----|----|----|----|----------|
| Hub-only | TS+US | 13 | 11 | 11 | 16 | 15 | **66** | 56% |
| Stage 1 (2 core) | TS+TCS | 17 | 14 | 21 | 20 | 15 | **87** | 74% |
| Stage 2 (4 flow) | +US+TIS | 21 | 24 | 23 | 22 | 19 | **109** | 92% |
| Stage 3 (6 ext) | +AS+TRS | 21 | 24 | 25 | 23 | 21 | **114** | 97% |
| Stage 4 (8 full) | +TES+AuthS | 24 | 25 | 25 | 24 | 20 | **118** | 100% |

## Delta Analysis

| Transition | Delta | Per-node marginal value |
|------------|-------|------------------------|
| Hub → Stage 1 | N/A (different nodes, not additive) | N/A |
| Stage 1 → 2 | **+22** | **+11 per node** |
| Stage 2 → 3 | +5 | +2.5 per node |
| Stage 3 → 4 | +4 | +2 per node |
