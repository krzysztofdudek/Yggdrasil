# Exp 3.1a Scoring: PubSub Failure Analysis with Aspect Exceptions

## Comparison: Original Exp 8 Agent A vs Enhanced Agent A'

### Original Agent A (Exp 8, no aspect_exceptions)

**Answer:** "No operations FAIL COMPLETELY due to PubSub outage."
**Score:** 20/25 (lost 5 points on accuracy for the confidently wrong conclusion)

Agent A trusted the pubsub-events aspect description as a universal rule and applied the
fire-and-forget pattern to ALL services. It identified all 7 publishing services and their
event types but concluded everything degrades gracefully.

### Enhanced Agent A' (Exp 3.1a, WITH aspect_exceptions)

**Answer:** Identified 6 operations that FAIL across 3 services, with correct mechanisms.
**Scoring (same 5 dimensions, 5 points each):**

#### Completeness (5/5)
- Identified all 7 publishing services ✓
- Correctly classified 6 failing operations and ~22 graceful operations ✓
- Named specific operations per service ✓
- Covered both direct failures AND the moveCollection transaction risk ✓

#### Accuracy (5/5)
- updateUserSessions: correctly identified await + try-catch → USER_UPDATE_FAILED ✓
- updateUserDisplayName: correctly identified await + try-catch → USER_NOT_FOUND ✓
- inviteUserToSignInViaEmail: correctly identified await + NO try-catch → unhandled 500 ✓
- moveCollection: correctly identified publish inside $transaction → rollback risk ✓
- renameCollection/updateTeamCollection: correctly identified try-catch error masking ✓
- deleteUserByUID: correctly identified as fire-and-forget (TE.fromTask) ✓
- All other services correctly classified as graceful degradation ✓
- NO factually wrong claims ✓

#### Cross-node (5/5)
- Traced PubSub failure impact across ALL 7 services ✓
- Identified the AdminService → UserService chain (re-invite → USER_ALREADY_INVITED) ✓
- Distinguished between service-level patterns ✓

#### Rationale (4/5)
- Explained WHY each failure happens (await vs fire-and-forget) ✓
- Identified the diagnostic hazard (wrong error codes) ✓
- Provided severity ranking ✓
- Minor gap: did not discuss WHY these deviations exist (accidental or deliberate?) -1

#### Actionability (5/5)
- Summary table with operation | failure mode | mechanism ✓
- Severity ranking for prioritization ✓
- Identified the diagnostic hazard that would affect incident response ✓
- Clear enough for a developer to act on ✓

**Total Score: 24/25**

### Score Comparison

| Dimension | Original Agent A (Exp 8) | Enhanced Agent A' (Exp 3.1a) | Agent C (raw code, Exp 8) |
|-----------|-------------------------|------------------------------|---------------------------|
| Completeness | 5/5 | 5/5 | 5/5 |
| Accuracy | 3/5 | 5/5 | 5/5 |
| Cross-node | 5/5 | 5/5 | 4/5 |
| Rationale | 4/5 | 4/5 | 3/5 |
| Actionability | 3/5 | 5/5 | 5/5 |
| **TOTAL** | **20/25** | **24/25** | **22/25** |

## Key Finding

**Aspect exceptions completely close the accuracy gap.**

The original Agent A scored 20/25 because the aspect generalization led to a confidently wrong
conclusion ("no operations fail completely"). The enhanced Agent A' scored 24/25 — HIGHER than
Agent C's 22/25 from raw code analysis — because:

1. It correctly identified ALL 6 failing operations (matching Agent C's findings)
2. It provided better rationale than Agent C (aspect-level reasoning about WHY the deviations matter)
3. It identified the diagnostic hazard (wrong error codes) which Agent C also found
4. It provided cross-module analysis that Agent C could not (AdminService re-invite chain)

**The 1-point gap (24 vs 25) is on rationale** — the agent did not discuss whether the deviations
are accidental bugs or deliberate design choices. This is a "why" question that the graph could
capture in decisions.md or internals.md but currently does not.

## Verdict

**Aspect exceptions WORK.** They prevent the abstraction-accuracy inversion that was the most
concerning finding in Exp 8. The enhanced graph now beats raw code analysis on Q5.

## Limitation

This test validates that aspect_exceptions in context packages are USED correctly by agents.
It does NOT validate that agents will POPULATE aspect_exceptions correctly when building graphs
(that would require testing the graph-building workflow, which is a different experiment).
