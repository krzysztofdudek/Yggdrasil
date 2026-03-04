# Exp 3.1a Blindfold Test: PubSub Failure Analysis with Aspect Exceptions

## Setup

You are an AI agent analyzing the Hoppscotch codebase. You have access ONLY to the
Yggdrasil graph context packages provided below. You do NOT have access to source code.
Answer based solely on the information in these context packages.

## Question (same as Exp 8 Q5)

**"If the PubSub system goes down, which operations fail completely and which degrade gracefully?"**

Provide a detailed analysis for each service that publishes PubSub events. For each operation,
determine whether a PubSub outage would:
1. Cause the operation to fail completely (user sees an error, data may or may not be written)
2. Cause graceful degradation (operation succeeds but real-time updates are lost)
3. Cause other side effects

Pay close attention to aspect exceptions noted in the context packages — they describe
deviations from the general PubSub pattern that affect failure behavior.

## Gold Standard Answer (for scoring — not shown to agent)

### Operations that FAIL or produce errors on PubSub outage:

1. **UserService.updateUserSessions** — `await`s pubsub.publish inside try-catch. PubSub failure
   is caught → returns `E.left(USER_UPDATE_FAILED)`. DB write already succeeded. User sees error;
   data IS saved but caller doesn't know.

2. **UserService.updateUserDisplayName** — `await`s pubsub.publish inside try-catch. PubSub failure
   caught → returns `E.left(USER_NOT_FOUND)`. DB write already succeeded. User sees misleading
   error; data IS saved.

3. **AdminService.inviteUserToSignInViaEmail** — `await`s pubsub.publish with NO try-catch.
   PubSub failure propagates as unhandled exception → 500 Internal Server Error. Invitation record
   IS written to DB, email IS sent. Admin sees failure, may re-invite → hits USER_ALREADY_INVITED.

### Operations with PHANTOM EVENT risk on PubSub outage:

4. **TeamCollectionService.moveCollection** — publishes PubSub events INSIDE the $transaction
   callback. If PubSub throws synchronously, the exception propagates out of the transaction
   callback, potentially rolling back the database move. This is the only operation where a
   PubSub failure could cause a DATA OPERATION to fail.

### Operations that DEGRADE GRACEFULLY:

5. **TeamService** — all publish calls (addMemberToTeam, updateTeamAccessRole, leaveTeam)
   are fire-and-forget, outside transactions. PubSub failure is silently ignored.

6. **TeamCollectionService** (except moveCollection) — createCollection, deleteCollection,
   importCollections, updateCollectionOrder, renameCollection, updateTeamCollection all publish
   fire-and-forget outside transactions. PubSub failure is silently ignored.
   Note: renameCollection and updateTeamCollection publish inside try-catch — if publish throws,
   caller gets TEAM_COLL_NOT_FOUND even though DB write succeeded (error masking, not failure).

7. **TeamEnvironmentsService** — all publish calls are fire-and-forget. Several are inside
   try-catch blocks (deleteTeamEnvironment, updateTeamEnvironment, etc.) — error masking risk
   but not operational failure.

8. **TeamInvitationService** — createInvitation, revokeInvitation both fire-and-forget.

9. **TeamRequestService** — most publish calls fire-and-forget. updateTeamRequest publishes
   inside try-catch.

### Summary classification:

| Category | Operations |
|----------|-----------|
| Fails with error (await + try-catch) | updateUserSessions, updateUserDisplayName |
| Fails with 500 (await, no try-catch) | inviteUserToSignInViaEmail |
| May fail data operation (inside $transaction) | moveCollection |
| Degrades gracefully (fire-and-forget) | All other ~22 operations |

Key insight: 4 out of ~28 operations have failure-propagating PubSub patterns.
The aspect_exceptions in the context packages explicitly flag all of these deviations.
