# Infrastructure Nodes: Team-Related Guards

These are additional context entries for the Hoppscotch graph, modeling guard classes
as infrastructure nodes. They supplement the existing service nodes.

---

## Node: team-guards/gql-team-member-guard

```yaml
name: GqlTeamMemberGuard
type: infrastructure
aspects: [role-based-access]

relations:
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]
    note: "Resolves team membership from teamID GQL arg"

mapping:
  paths:
    - packages/hoppscotch-backend/src/team/guards/gql-team-member.guard.ts
```

### responsibility.md

NestJS guard for GraphQL operations that require team membership with a specific role.
Extracts `teamID` from GQL args, calls `TeamService.getTeamMember`, and verifies the
member's role against `@RequiresTeamRole()` metadata.

Protects: team queries, team member mutations, collection list/create/import (by teamID),
environment creation, invitation creation, request search, sort operations, subscription
endpoints. The broadest-scope team guard — any GQL operation with a `teamID` argument.

### interface.md

**Input:** GQL execution context with `teamID` in args and authenticated user in context.

**Behavior:**
- Reads `requiresTeamRole` decorator metadata
- Extracts `teamID` from GQL args
- Calls `TeamService.getTeamMember(teamID, user.uid)`
- If member is null → throws `TEAM_MEMBER_NOT_FOUND`
- If member role not in required roles → throws `TEAM_NOT_REQUIRED_ROLE`
- If guard passes → sets `teamMember` on request for downstream use

**Errors:**
- `BUG_TEAM_NO_REQUIRE_TEAM_ROLE` — decorator missing (programmer error)
- `BUG_AUTH_NO_USER_CTX` — user not in GQL context
- `BUG_TEAM_NO_TEAM_ID` — teamID not in GQL args
- `TEAM_MEMBER_NOT_FOUND` — user not a team member
- `TEAM_NOT_REQUIRED_ROLE` — role insufficient

**Key behavior:** Reads `teamMember.role` for RBAC decisions. A change that preserves
null/non-null semantics on `getTeamMember` but modifies the role field would pass
service-level checks but break this guard.

---

## Node: team-guards/rest-team-member-guard

```yaml
name: RESTTeamMemberGuard
type: infrastructure
aspects: [role-based-access]

relations:
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]

mapping:
  paths:
    - packages/hoppscotch-backend/src/team/guards/rest-team-member.guard.ts
```

### responsibility.md

REST counterpart to GqlTeamMemberGuard. Same logic but for HTTP context — extracts
`teamID` from `request.params.teamID`, throws HTTP errors (400/404/403) instead of GQL errors.

Protects: REST search endpoint (`GET /team-collection/search/:teamID`).

---

## Node: team-collection-guards/gql-collection-team-member-guard

```yaml
name: GqlCollectionTeamMemberGuard
type: infrastructure
aspects: [role-based-access]

relations:
  - target: team-collections/team-collection-service
    type: calls
    consumes: [getCollection]
    note: "Resolves team ownership from collectionID"
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]
    note: "Checks membership in the resolved team"

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-collection/guards/gql-collection-team-member.guard.ts
```

### responsibility.md

NestJS guard for GQL operations on specific collections. Takes `collectionID` (not teamID)
from args, resolves which team owns the collection via `TeamCollectionService.getCollection`,
then checks team membership and role via `TeamService.getTeamMember`.

Protects: collection view, create child, rename, delete, move, reorder, update, duplicate.
This is the primary authorization layer for per-collection operations.

### interface.md

**Input:** GQL execution context with `collectionID` in args.

**Resolution chain:**
1. `TeamCollectionService.getCollection(collectionID)` → gets `collection.teamID`
2. `TeamService.getTeamMember(collection.teamID, user.uid)` → membership + role check

**Key behavior:** Two-service dependency chain. Changes to either `getCollection` return
shape or `getTeamMember` behavior affect this guard. Reads `teamMember.role` for RBAC.

---

## Node: team-env-guards/gql-team-env-team-guard

```yaml
name: GqlTeamEnvTeamGuard
type: infrastructure
aspects: [role-based-access]

relations:
  - target: team-environments/team-environments-service
    type: calls
    consumes: [getTeamEnvironment]
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-environments/gql-team-env-team.guard.ts
```

### responsibility.md

NestJS guard for environment-specific GQL operations. Takes environment `id` from args,
resolves team via `TeamEnvironmentsService.getTeamEnvironment`, checks membership.

Protects: delete, update, clear variables, duplicate environment.

---

## Node: team-invitation-guards/team-invite-team-owner-guard

```yaml
name: TeamInviteTeamOwnerGuard
type: infrastructure
aspects: [role-based-access]
aspect_exceptions:
  - aspect: role-based-access
    note: "Hard-codes OWNER role check instead of using @RequiresTeamRole decorator. Does not use configurable role metadata."

relations:
  - target: team-invitation/team-invitation-service
    type: calls
    consumes: [getInvitation]
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-invitation/team-invite-team-owner.guard.ts
```

### responsibility.md

Guard for invitation revocation. Resolves invitation by ID, checks team membership
with hard-coded OWNER requirement (no decorator). Only team owners can revoke invitations.

---

## Node: team-invitation-guards/team-invite-viewer-guard

```yaml
name: TeamInviteViewerGuard
type: infrastructure

relations:
  - target: team-invitation/team-invitation-service
    type: calls
    consumes: [getInvitation]
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]
    note: "Only called if user is NOT the invitee"

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-invitation/team-invite-viewer.guard.ts
```

### responsibility.md

Guard for viewing invitation details. Allows access if user's email matches invitee
OR if user is any team member (no role check). Truthiness check only on `getTeamMember`
result — does not inspect role.

---

## Node: team-request-guards/gql-request-team-member-guard

```yaml
name: GqlRequestTeamMemberGuard
type: infrastructure
aspects: [role-based-access]

relations:
  - target: team-request/team-request-service
    type: calls
    consumes: [getTeamOfRequestFromID]
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-request/guards/gql-request-team-member.guard.ts
```

### responsibility.md

NestJS guard for request-specific GQL operations. Takes `requestID` from args, resolves
team via `TeamRequestService.getTeamOfRequestFromID`, checks membership and role.

Protects: view, update, delete, reorder, move request operations.

---

## Summary: getTeamMember Call Sites (Services + Guards)

| Caller | Type | Uses role? | ID resolution |
|--------|------|-----------|---------------|
| TeamCollectionService | service | No (null check only) | Direct teamID |
| GqlTeamMemberGuard | infrastructure | Yes (RBAC) | Direct teamID from args |
| RESTTeamMemberGuard | infrastructure | Yes (RBAC) | Direct teamID from params |
| GqlCollectionTeamMemberGuard | infrastructure | Yes (RBAC) | collectionID → teamID |
| GqlTeamEnvTeamGuard | infrastructure | Yes (RBAC) | envID → teamID |
| TeamInviteTeamOwnerGuard | infrastructure | Yes (OWNER only) | inviteID → teamID |
| TeamInviteViewerGuard | infrastructure | Truthiness only | inviteID → teamID |
| GqlRequestTeamMemberGuard | infrastructure | Yes (RBAC) | requestID → teamID |
| MockRequestGuard | infrastructure | Truthiness only | mockServerID → workspaceID |
| TeamService (internal) | service | Yes (sole owner check) | Direct |

**Total call sites: 10 (4 service, 6 infrastructure)**
**Original graph coverage: 4/10 = 40%**
**With infrastructure nodes: 10/10 = 100%**
