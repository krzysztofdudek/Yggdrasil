# PubSub Failure Analysis — Hoppscotch Backend

**Question:** If the PubSub system goes down, which operations fail completely and which degrade gracefully?

**Methodology:** Based solely on context packages for 7 services and the pubsub-events aspect definition. Three services have explicit `aspect_exceptions` documenting deviations from the fire-and-forget pattern (UserService, AdminService, TeamCollectionService). Four services have no exceptions noted, meaning they follow the standard pattern.

---

## Baseline: The Standard PubSub Pattern

The `pubsub-events` aspect describes the expected pattern across all services:

- PubSub publish is called **after** the database transaction commits
- The publish call is **fire-and-forget** (not awaited in the business logic sense)
- If PubSub goes down in the standard pattern: the DB write succeeds, the publish silently fails (or throws into the void), and the operation returns success

This means the standard pattern produces **graceful degradation**: data is persisted, real-time subscribers do not receive an update, but the caller gets a success response.

**The exceptions documented in three context packages break this pattern in different and serious ways.**

---

## Per-Service Analysis

### 1. UserService (enhanced context package — has aspect_exceptions)

**Aspect exception note:**
> `updateUserSessions` and `updateUserDisplayName` AWAIT the pubsub.publish call (not fire-and-forget). Both are inside try-catch blocks — if publish throws, `updateUserSessions` returns `E.left(USER_UPDATE_FAILED)` and `updateUserDisplayName` returns `E.left(USER_NOT_FOUND)`, masking the pubsub failure as a DB error. `deleteUserByUID` uses `TE.fromTask/TE.chainFirst` for the publish, which is fire-and-forget in the fp-ts pipeline.

**Operation: `updateUserSessions`**

- PubSub publish is AWAITED
- Wrapped in try-catch
- If PubSub throws: the DB write has already committed successfully, but the caught exception causes the method to return `E.left(USER_UPDATE_FAILED)`
- Failure mode: **FAIL — the caller sees an error even though the session was written to the DB**
- The failure is masked as a DB error (`USER_UPDATE_FAILED`), making diagnosis difficult
- Data inconsistency risk: the session IS updated in the DB, but the caller believes it failed

**Operation: `updateUserDisplayName`**

- PubSub publish is AWAITED
- Wrapped in try-catch
- If PubSub throws: the DB write has already committed, but the exception causes the method to return `E.left(USER_NOT_FOUND)` — an especially misleading error code
- Failure mode: **FAIL — the caller sees an error (with a misleading error code) even though the display name was written to the DB**
- The error code `USER_NOT_FOUND` is factually wrong when the real cause is PubSub failure; this would send a developer debugging in entirely the wrong direction

**Operation: `deleteUserByUID`**

- Uses `TE.fromTask/TE.chainFirst` — fire-and-forget in the fp-ts pipeline
- If PubSub goes down: the user deletion cascade completes (all handler cleanups run, DB record deleted), publish fails silently
- Failure mode: **Graceful degradation** — deletion succeeds, subscribers do not receive `user/{uid}/deleted` event

---

### 2. AdminService (enhanced context package — has aspect_exceptions)

**Aspect exception note:**
> `inviteUserToSignInViaEmail` AWAITS the `pubsub.publish` call (not fire-and-forget) and has NO try-catch around it. If PubSub throws, the exception propagates as unhandled → 500 Internal Server Error. The invited user record is already written to DB and the email is already sent, so admin sees failure but invitation data persists. Admin may re-invite, hitting `USER_ALREADY_INVITED` guard.

**Operation: `inviteUserToSignInViaEmail`**

- PubSub publish is AWAITED
- NO try-catch
- If PubSub throws: the exception propagates unhandled up to the NestJS exception layer, resulting in a 500 Internal Server Error
- At the point of the PubSub call: the invitation record is already in the DB AND the invitation email has already been sent
- Failure mode: **FAIL — admin sees a 500 error even though the invitation was created and the email was sent**
- Secondary side effect: If the admin retries (because they saw a 500), they will hit `USER_ALREADY_INVITED` because the invitation record persists in the DB. The admin is now stuck: the invitation exists but they cannot create another one. They would need to find and revoke the existing invitation before re-inviting.
- This is the most severe failure mode of any service: unhandled exception + partially committed side effects (DB record + email) with no retry path available

---

### 3. TeamCollectionService (enhanced context package — has aspect_exceptions)

**Aspect exception note:**
> `moveCollection` publishes PubSub events INSIDE the `$transaction` callback (lines 776-779 and 825-828), NOT after commit. Both `coll_moved` and `coll_order_updated` events fire while the transaction is still open. If the transaction rolls back after publishing, subscribers receive phantom events for data that was never committed. Also: `renameCollection` and `updateTeamCollection` publish inside try-catch blocks — if publish throws, caller gets `TEAM_COLL_NOT_FOUND` even though the DB write succeeded.

**Operation: `moveCollection`**

- PubSub is called INSIDE the transaction (before commit), not after
- If PubSub itself goes down: publishing while the transaction is open will throw. The behavior depends on how the transaction handles the error — the transaction is likely rolled back (no DB change), and the exception would propagate to the caller as an error
- Failure mode: **FAIL — the move operation returns an error (the transaction rolls back), AND the DB write does not persist**
- Note: In the inverse scenario (PubSub succeeds but transaction rolls back afterward), clients receive phantom events. However, under a PubSub outage, the throw from PubSub likely prevents the transaction from committing at all.

**Operation: `renameCollection`**

- Publish is inside a try-catch block
- If PubSub throws: the DB write has already committed (rename succeeded in DB), but the caught exception causes the caller to receive `TEAM_COLL_NOT_FOUND` — an incorrect error code
- Failure mode: **FAIL — caller sees `TEAM_COLL_NOT_FOUND` even though the rename succeeded in the DB**
- Same masking problem as UserService: error code is factually wrong, data is inconsistent between what the caller believes and what the DB contains

**Operation: `updateTeamCollection`**

- Same pattern as `renameCollection`: publish inside try-catch
- If PubSub throws: DB write succeeded, but caller receives `TEAM_COLL_NOT_FOUND`
- Failure mode: **FAIL — same masking as renameCollection**

**All other collection mutations** (createCollection, deleteCollection, updateCollectionOrder, sortCollection, importCollectionsFromJSON, duplicateCollection):

- No aspect_exceptions are noted for these operations
- The standard fire-and-forget pattern applies
- Failure mode: **Graceful degradation** — DB writes succeed, real-time events are lost, callers get success responses

---

### 4. TeamService (original context package — no aspect_exceptions)

The context package notes no deviations from the pubsub-events aspect. TeamService publishes events for membership mutations: `member_added`, `member_updated`, `member_removed`.

**Operations: `addMemberToTeam`, `leaveTeam`, `updateTeamAccessRole`, `deleteUserFromAllTeams`**

- Standard fire-and-forget pattern applies
- If PubSub goes down: membership changes succeed in the DB, subscribers do not receive real-time updates (UI stale), callers receive success
- Failure mode: **Graceful degradation** for all membership operations

---

### 5. TeamEnvironmentsService (original context package — no aspect_exceptions)

No deviations from the standard pattern documented. Publishes events for: environment created, updated, deleted, variables cleared.

**Operations: `createTeamEnvironment`, `updateTeamEnvironment`, `deleteTeamEnvironment`, `deleteAllVariablesFromTeamEnvironment`, `createDuplicateEnvironment`**

- Standard fire-and-forget pattern applies
- Failure mode: **Graceful degradation** — all environment mutations succeed in DB, no real-time notifications reach subscribers

---

### 6. TeamInvitationService (original context package — no aspect_exceptions)

No deviations from the standard pattern documented. Publishes events for: `invite_added`, `invite_removed`.

**Operations: `createInvitation`, `revokeInvitation`**

- Standard fire-and-forget pattern applies (based on no exception noted)
- Failure mode: **Graceful degradation** — invitations are created and revoked in DB, subscribers do not see real-time updates

Note: `acceptInvitation` delegates membership creation to `TeamService.addMemberToTeam`, which also follows the standard pattern. The acceptance itself does not appear to directly publish events beyond what the sub-services handle.

---

### 7. TeamRequestService (original context package — no aspect_exceptions)

No deviations from the standard pattern documented. Publishes events for: `req_created`, `req_updated`, `req_deleted`, `req_moved`, `req_order_updated`.

**Operations: `createTeamRequest`, `updateTeamRequest`, `deleteTeamRequest`, `moveRequest`, `sortTeamRequests`**

- Standard fire-and-forget pattern applies
- Failure mode: **Graceful degradation** — all request mutations persist, subscribers get no real-time updates

---

## Summary Table

| Service | Operation | Failure Mode | Mechanism |
|---|---|---|---|
| UserService | `updateUserSessions` | FAIL — caller gets error, DB write succeeded | Awaits publish inside try-catch; PubSub exception returns `E.left(USER_UPDATE_FAILED)` masking DB success |
| UserService | `updateUserDisplayName` | FAIL — caller gets error (wrong code), DB write succeeded | Awaits publish inside try-catch; PubSub exception returns `E.left(USER_NOT_FOUND)` masking DB success |
| UserService | `deleteUserByUID` | Graceful degradation | Fire-and-forget via `TE.fromTask/TE.chainFirst`; deletion succeeds, event lost |
| AdminService | `inviteUserToSignInViaEmail` | FAIL — 500 error, invitation record + email already sent | Awaits publish with NO try-catch; unhandled exception propagates; re-invite blocked by `USER_ALREADY_INVITED` |
| TeamCollectionService | `moveCollection` | FAIL — operation returns error, DB write likely does not persist | Publish called inside open transaction; PubSub failure throws inside transaction, likely rolling it back |
| TeamCollectionService | `renameCollection` | FAIL — caller gets `TEAM_COLL_NOT_FOUND`, DB write succeeded | Publish inside try-catch; PubSub exception returns wrong error code masking DB success |
| TeamCollectionService | `updateTeamCollection` | FAIL — caller gets `TEAM_COLL_NOT_FOUND`, DB write succeeded | Same as renameCollection |
| TeamCollectionService | `createCollection` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamCollectionService | `deleteCollection` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamCollectionService | `updateCollectionOrder` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamCollectionService | `sortCollection` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamCollectionService | `importCollectionsFromJSON` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamCollectionService | `duplicateCollection` | Graceful degradation | Standard pattern; DB write succeeds, event lost |
| TeamService | `addMemberToTeam` | Graceful degradation | Standard fire-and-forget; membership created, event lost |
| TeamService | `leaveTeam` | Graceful degradation | Standard fire-and-forget; membership removed, event lost |
| TeamService | `updateTeamAccessRole` | Graceful degradation | Standard fire-and-forget; role updated, event lost |
| TeamService | `deleteUserFromAllTeams` | Graceful degradation | Standard fire-and-forget; memberships removed, events lost |
| TeamEnvironmentsService | `createTeamEnvironment` | Graceful degradation | Standard fire-and-forget; environment created, event lost |
| TeamEnvironmentsService | `updateTeamEnvironment` | Graceful degradation | Standard fire-and-forget; environment updated, event lost |
| TeamEnvironmentsService | `deleteTeamEnvironment` | Graceful degradation | Standard fire-and-forget; environment deleted, event lost |
| TeamEnvironmentsService | `deleteAllVariablesFromTeamEnvironment` | Graceful degradation | Standard fire-and-forget; variables cleared, event lost |
| TeamEnvironmentsService | `createDuplicateEnvironment` | Graceful degradation | Standard fire-and-forget; environment duplicated, event lost |
| TeamInvitationService | `createInvitation` | Graceful degradation | Standard fire-and-forget; invitation created, event lost |
| TeamInvitationService | `revokeInvitation` | Graceful degradation | Standard fire-and-forget; invitation revoked, event lost |
| TeamRequestService | `createTeamRequest` | Graceful degradation | Standard fire-and-forget; request created, event lost |
| TeamRequestService | `updateTeamRequest` | Graceful degradation | Standard fire-and-forget; request updated, event lost |
| TeamRequestService | `deleteTeamRequest` | Graceful degradation | Standard fire-and-forget; request deleted, event lost |
| TeamRequestService | `moveRequest` | Graceful degradation | Standard fire-and-forget; request moved, event lost |
| TeamRequestService | `sortTeamRequests` | Graceful degradation | Standard fire-and-forget; requests sorted, event lost |

---

## Overall Conclusion

### The architectural intention vs. reality gap

The `pubsub-events` aspect documents fire-and-forget as the intended pattern — designed so that a PubSub outage causes only degraded real-time updates, never operation failures. However, three services deviate from this pattern in ways that introduce partial failure modes.

### Operations that FAIL under PubSub outage (6 operations across 3 services)

1. **UserService.updateUserSessions** — DB write succeeds but caller gets `USER_UPDATE_FAILED`
2. **UserService.updateUserDisplayName** — DB write succeeds but caller gets `USER_NOT_FOUND` (misleading)
3. **AdminService.inviteUserToSignInViaEmail** — DB record written, email sent, caller gets 500, re-invite path is blocked
4. **TeamCollectionService.moveCollection** — Operation likely fails completely (DB write not committed)
5. **TeamCollectionService.renameCollection** — DB write succeeds but caller gets `TEAM_COLL_NOT_FOUND`
6. **TeamCollectionService.updateTeamCollection** — DB write succeeds but caller gets `TEAM_COLL_NOT_FOUND`

### Operations that degrade gracefully (22 operations across 5+ services)

All operations in TeamService, TeamEnvironmentsService, TeamInvitationService, TeamRequestService, plus `UserService.deleteUserByUID` and most TeamCollectionService mutations follow the fire-and-forget pattern and degrade gracefully.

### Severity ranking

**Most severe (AdminService.inviteUserToSignInViaEmail):** Unhandled 500 propagation after side effects are already committed (DB record + email sent). No clean retry path because the invitation persists — admin must first discover and revoke the orphaned invitation.

**High severity (UserService session/display updates):** DB writes succeed silently while callers receive errors. This creates data inconsistency: the system is in a state the caller does not know about. Callers may retry, causing duplicate updates, or believe an operation failed when it succeeded.

**Medium severity (TeamCollectionService renameCollection, updateTeamCollection):** Similar masking problem as UserService. Wrong error code (`TEAM_COLL_NOT_FOUND`) when the real cause is PubSub failure.

**Unique risk (TeamCollectionService.moveCollection):** Unlike all other failures, this likely rolls back the DB write entirely (because PubSub publish happens inside the open transaction). This means the move operation fails completely — no phantom data, but no success either. The risk runs in the other direction under intermittent PubSub issues: if publish succeeds but the transaction rolls back afterward, clients receive phantom events for a move that never committed.

### Diagnostic hazard

Four of the six failing operations return WRONG error codes when PubSub is the actual cause:
- `USER_UPDATE_FAILED` when real cause is PubSub failure in `updateUserSessions`
- `USER_NOT_FOUND` when real cause is PubSub failure in `updateUserDisplayName`
- `TEAM_COLL_NOT_FOUND` when real cause is PubSub failure in `renameCollection`
- `TEAM_COLL_NOT_FOUND` when real cause is PubSub failure in `updateTeamCollection`

This means a PubSub outage would produce error reports that look like data integrity problems or missing records — making the actual root cause (PubSub system down) extremely difficult to identify from error logs alone.
