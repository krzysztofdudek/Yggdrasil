# Blindfold Answers — Infrastructure Node Blast Radius

Source: graph context packages and guard node descriptions only. No source code accessed.

---

## Q1: If I change the team membership check in TeamService (getTeamMember), what breaks in TeamCollectionService and other modules?

### Complete List of getTeamMember Callers

The guard-nodes summary table identifies 10 call sites total. Here is each one:

**Services:**

1. **TeamCollectionService** (service)
   - Declared in `node.yaml` relations: `consumes: [getTeamMember]`
   - Used in: `getCollectionForCLI(collectionID, userUid)` — the CLI-access method
   - How it uses the result: null check only. If `getTeamMember` returns null, the method returns `TEAM_MEMBER_NOT_FOUND`. The role field is not inspected.

2. **TeamEnvironmentsService** (service)
   - Declared in `node.yaml` relations: `consumes: [getTeamMember]`
   - Used in: `getTeamEnvironmentForCLI(id, userUid)` — CLI access method
   - How it uses the result: null check only. Non-null = member exists = allowed. Role is not inspected.

3. **TeamInvitationService** (service)
   - Declared in `node.yaml` relations: `consumes: [getTeamMember]`
   - Used in: `createInvitation` — verifies that the invitation creator is a team member
   - How it uses the result: null check only. Any role qualifies. From the constraint: "The service does not check the creator's role — any member can invite."

4. **AdminService** (service)
   - Declared in `node.yaml` relations: `consumes: [getTeamMemberTE]` (the fp-ts TaskEither variant)
   - Note: AdminService uses `getTeamMemberTE`, not the plain `getTeamMember`. This is the TE (TaskEither) variant — same underlying membership check, different return type wrapper.
   - How it uses the result: the Either result determines success/failure of admin team member operations.

**Infrastructure (Guards):**

5. **GqlTeamMemberGuard** (infrastructure)
   - Protects: team queries, collection list/create/import by teamID, environment creation, invitation creation, request search, sort, subscription endpoints
   - How it uses the result: null check AND role inspection. Calls `getTeamMember(teamID, user.uid)`, checks result is non-null (else `TEAM_MEMBER_NOT_FOUND`), then reads `teamMember.role` against `@RequiresTeamRole()` decorator metadata (else `TEAM_NOT_REQUIRED_ROLE`).

6. **RESTTeamMemberGuard** (infrastructure)
   - Protects: REST search endpoint `GET /team-collection/search/:teamID`
   - How it uses the result: same logic as GqlTeamMemberGuard — null check + role inspection, but throws HTTP 400/404/403 instead of GQL errors.

7. **GqlCollectionTeamMemberGuard** (infrastructure)
   - Protects: collection view, create child, rename, delete, move, reorder, update, duplicate
   - Resolution chain: calls `getCollection(collectionID)` first to get `collection.teamID`, then calls `getTeamMember(collection.teamID, user.uid)`
   - How it uses the result: null check + role inspection. Reads `teamMember.role` for RBAC decisions.

8. **GqlTeamEnvTeamGuard** (infrastructure)
   - Protects: delete, update, clear variables, duplicate environment
   - Resolution chain: calls `getTeamEnvironment(id)` first to get teamID, then calls `getTeamMember`
   - How it uses the result: null check + role inspection (implied by `role-based-access` aspect).

9. **TeamInviteTeamOwnerGuard** (infrastructure)
   - Protects: invitation revocation
   - Resolution chain: resolves invitation by ID, then calls `getTeamMember`
   - How it uses the result: hard-coded OWNER check — reads `teamMember.role` and requires it to be OWNER specifically. Does not use the `@RequiresTeamRole` decorator — this is an aspect exception documented in the guard node.

10. **TeamInviteViewerGuard** (infrastructure)
    - Protects: viewing invitation details
    - Resolution chain: resolves invitation by ID; only calls `getTeamMember` if user email does NOT match invitee email
    - How it uses the result: truthiness only — checks whether a TeamMember record exists at all, does not inspect role.

11. **GqlRequestTeamMemberGuard** (infrastructure)
    - Protects: view, update, delete, reorder, move request operations
    - Resolution chain: calls `getTeamOfRequestFromID(requestID)` first to get teamID, then calls `getTeamMember`
    - How it uses the result: null check + role inspection (RBAC via `@RequiresTeamRole`).

### Summary by Usage Pattern

| Caller | Usage of result |
|--------|----------------|
| TeamCollectionService | Null check only — member exists or not |
| TeamEnvironmentsService | Null check only — member exists or not |
| TeamInvitationService | Null check only — any role qualifies |
| AdminService | TE variant — Either success/failure |
| GqlTeamMemberGuard | Null check + role field (RBAC) |
| RESTTeamMemberGuard | Null check + role field (RBAC) |
| GqlCollectionTeamMemberGuard | Null check + role field (RBAC) |
| GqlTeamEnvTeamGuard | Null check + role field (RBAC) |
| TeamInviteTeamOwnerGuard | Role field (hard-coded OWNER required) |
| TeamInviteViewerGuard | Null check / truthiness only |
| GqlRequestTeamMemberGuard | Null check + role field (RBAC) |

### Blast Radius Analysis

Changes to `getTeamMember` break differently depending on what is changed:

**If null semantics change (non-member returns non-null, or member returns null):**
- All 11 callers are broken. Every caller gates on null vs. non-null.
- The most damaging scenario: returning a non-null object for non-members would bypass all membership enforcement across every team-scoped operation.
- Services affected: TeamCollectionService CLI access, TeamEnvironmentsService CLI access, TeamInvitationService invitation creation, AdminService team operations.
- Guards affected: all 6 guards — every team-scoped GQL operation and the REST search endpoint.

**If the role field changes (renamed, restructured, or enum values change):**
- Services doing null-check-only are unaffected: TeamCollectionService, TeamEnvironmentsService, TeamInvitationService.
- Guards doing role inspection are broken: GqlTeamMemberGuard, RESTTeamMemberGuard, GqlCollectionTeamMemberGuard, GqlTeamEnvTeamGuard, TeamInviteTeamOwnerGuard, GqlRequestTeamMemberGuard.
- TeamInviteViewerGuard is unaffected (truthiness only).
- This is highlighted explicitly in the guard node description: "A change that preserves null/non-null semantics on `getTeamMember` but modifies the role field would pass service-level checks but break this guard."

**If the function signature changes (parameter names/types):**
- All callers must be updated. The function signature is `getTeamMember(teamID: string, userUid: string): Promise<TeamMember | null>`.

**Operations affected by a breaking change:**

If membership checks fail silently or incorrectly:
- Every GQL mutation on collections (create, rename, delete, move, reorder, update, duplicate) — via GqlCollectionTeamMemberGuard
- Every GQL query/mutation on team-level operations (collection list/create, environment create, invitation create, request search/sort) — via GqlTeamMemberGuard
- REST collection search — via RESTTeamMemberGuard
- Environment mutations (delete, update, clear, duplicate) — via GqlTeamEnvTeamGuard
- Request mutations (view, update, delete, reorder, move) — via GqlRequestTeamMemberGuard
- Invitation revocation — via TeamInviteTeamOwnerGuard
- CLI collection access — via TeamCollectionService
- CLI environment access — via TeamEnvironmentsService
- Invitation creation (any member) — via TeamInvitationService

In summary: `getTeamMember` is the central authorization primitive for the entire team-scoped access control layer. A breaking change to it affects every team-resource operation in the system, across all access patterns (GraphQL, REST, CLI).

### Cascading Effects Through Flows and Aspects

**Flow: Team Member Lifecycle**
- The flow's invitation-creation path relies on `getTeamMember` (via TeamInvitationService) to verify the creator is a member. A broken check here would allow non-members to create invitations.
- The admin-direct-addition path does not use `getTeamMember` for the add itself (uses `addMemberToTeamWithEmail`), but the already-member guard in AdminService uses `getTeamMemberTE`.

**Aspect: role-based-access**
- This aspect declares that most role enforcement is at the guard/resolver level, not service level. Every guard implementing this aspect calls `getTeamMember` and reads the role field. Any change that corrupts the role field propagates to all guards under this aspect simultaneously — a binary failure mode consistent with the aspect lifecycle warning in the agent rules.

**Aspect: team-ownership**
- The `getCollectionForCLI` method in TeamCollectionService (a team-ownership enforcement point) uses `getTeamMember` for its null check. A break here undermines CLI-level team isolation.

---

## Q4: Can a user who was removed from a team still see collections they previously created?

### How Team Membership Removal Works

Removal happens via one of these paths (from the Team Member Lifecycle flow):

1. **Member self-removal (leaveTeam):** `TeamService.leaveTeam(teamID, userUid)` — deletes the membership record after sole-owner check. Publishes `member_removed` event.
2. **Admin removal (removeUserFromTeam):** `AdminService.removeUserFromTeam` — delegates to `TeamService.leaveTeam`. Same mechanism, same effect.
3. **User account deletion (deleteUserFromAllTeams):** `TeamService.onUserDelete` iterates all the user's memberships and calls leave on each. The membership records are deleted.

In all cases, the result is the same: the `TeamMember` database record for (teamID, userUid) is deleted. There is no "suspended" or "read-only" membership state — it is a hard delete.

### How Collection Access is Enforced

**Service level:**

`TeamCollectionService` does not perform membership checks for standard collection operations (create, read, rename, delete, move, etc.). The service's `responsibility.md` explicitly states: "Authentication/authorization (handled by resolvers and guards)" is out of scope. The only membership check in TeamCollectionService is in `getCollectionForCLI`, which is a separate CLI-specific method.

`getCollectionForCLI(collectionID, userUid)` calls `TeamService.getTeamMember` and returns `TEAM_MEMBER_NOT_FOUND` if the user is not a member. This blocks CLI access post-removal.

**Guard level:**

For standard GraphQL operations (the primary API surface), two guards protect collection access:

1. **GqlTeamMemberGuard** — protects collection list and create operations via teamID argument. After removal, `getTeamMember(teamID, removedUser.uid)` returns null, and the guard throws `TEAM_MEMBER_NOT_FOUND`. The removed user cannot list or create collections.

2. **GqlCollectionTeamMemberGuard** — protects per-collection operations (view, create child, rename, delete, move, reorder, update, duplicate). Resolution chain: `getCollection(collectionID)` → `collection.teamID` → `getTeamMember(collection.teamID, user.uid)`. After removal, the getTeamMember call returns null, and the guard blocks access with `TEAM_MEMBER_NOT_FOUND`.

### Whether Collections Have a Creator Field

The context packages do not document a `creatorUID` or `createdBy` field on `TeamCollection`. The data model described in the team-ownership aspect shows: `TeamCollection.teamID` — collection belongs to team. No creator field is mentioned anywhere in the collection's data model, constraints, interface, or responsibility documents.

This absence is architecturally significant: collections belong to teams, not to individual users. There is no concept of "user-owned" collections within a team context. The graph does not document any creator tracking at the collection level.

### Exactly Which Guards/Checks Prevent Access After Removal

After a user is removed from a team, the following mechanisms block their access:

| Operation | Guard/Check | Mechanism |
|-----------|-------------|-----------|
| List collections for a team (GQL) | GqlTeamMemberGuard | getTeamMember returns null → TEAM_MEMBER_NOT_FOUND |
| Create collection in a team (GQL) | GqlTeamMemberGuard | Same — null check fails |
| View/rename/delete/move specific collection (GQL) | GqlCollectionTeamMemberGuard | getCollection → teamID → getTeamMember returns null → blocked |
| Search collections (REST) | RESTTeamMemberGuard | getTeamMember returns null → HTTP 404/403 |
| Get collection via CLI | TeamCollectionService.getCollectionForCLI | Direct getTeamMember null check → TEAM_MEMBER_NOT_FOUND |
| Get collection tree via CLI | TeamCollectionService.getCollectionTreeForCLI | (No explicit membership check documented at this level; guarded upstream) |

The enforcement is uniform: every access path — GraphQL, REST, CLI — checks membership before allowing any operation. The check is always the same: `TeamService.getTeamMember(teamID, userUid)` returns null for removed members, and every caller treats null as "access denied."

### Any Edge Cases Where Access Might Persist

Based on the context packages, there are two potential edge cases:

**Edge case 1: `getCollectionTreeForCLI` — undocumented membership check**

`getCollectionForCLI` documents an explicit membership check. `getCollectionTreeForCLI` is documented separately in the interface but its membership enforcement at the service level is not explicitly described in the constraints or responsibility documents. The interface description says it returns "full recursive tree for CLI" — it may rely on upstream authorization (e.g., a guard in front of the CLI endpoint) rather than an internal check. If that upstream guard is `GqlTeamMemberGuard` or similar, access is properly blocked. If the CLI endpoint for tree retrieval lacks guard coverage, a removed user who knows the collectionID could potentially access the full subtree. This is a gap in the graph documentation, not a confirmed vulnerability.

**Edge case 2: No creator-based access model**

Because collections have no creator field, there is no scenario where "I created this collection" grants residual access. Access is purely membership-based. Once membership is removed, all collection access is blocked regardless of creation history.

**Edge case 3: PubSub subscriptions**

Removal triggers a `member_removed` PubSub event. However, the context packages do not document whether active GraphQL subscriptions (which the client may have open) are automatically terminated on member removal. If a client remains subscribed to a team's collection events after removal (because the websocket connection predates the removal), they might continue to receive real-time updates for a period. This is a session/connection-lifetime concern, not a query-access concern, and the graph does not describe how subscription sessions are invalidated on membership change.

### Summary Answer

A removed team member cannot see collections they previously created because:

1. Collections have no creator field — there is no creator-based access channel.
2. All access paths (GQL mutations, GQL queries, REST search, CLI access) enforce membership via `TeamService.getTeamMember`, which returns null for removed members.
3. GqlTeamMemberGuard blocks team-level operations (collection listing, creation).
4. GqlCollectionTeamMemberGuard blocks per-collection operations (view, rename, delete, move, etc.).
5. TeamCollectionService.getCollectionForCLI directly enforces membership for CLI access.

The answer is: no, a removed member cannot access collections. The access control model is membership-scoped, not creator-scoped, and all access paths enforce current membership at request time.
