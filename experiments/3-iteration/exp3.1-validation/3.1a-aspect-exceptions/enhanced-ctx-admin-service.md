<context-package node-path="admin/admin-service" node-name="AdminService" token-count="11900">

<global>
**Project:** Hoppscotch

**Stack:**
- language: TypeScript
- runtime: Node.js
- framework: NestJS

**Standards:**
fp-ts Either/Option for error handling (never throw for business errors).
Prisma ORM for database access. PubSub for real-time event propagation.
Collections form a tree hierarchy (parent-child). OrderIndex is integer-based for sibling ordering.
All mutations that affect sibling order use row locking via lockTeamCollectionByTeamAndParent.


</global>

<hierarchy path="admin" aspects="pubsub-events">
### responsibility.md
# Admin

Provides administrative operations for managing the Hoppscotch infrastructure. Admin is the orchestration layer that delegates to domain services (user, team, collections, requests, environments, invitations) to perform privileged operations like user management, team management, and platform statistics.

## In scope

- User management (fetch, invite, delete, update display names)
- Admin role management (promote, demote, bulk operations)
- Team management (create, rename, delete, member operations)
- Platform statistics (user count, team count, collection count, request count)
- Shortcode management
- User history management
- Infra-level user invitation workflow

## Out of scope

- Authentication (handled by auth module)
- Direct database operations (delegates to domain services)
- Business logic for domain entities (implemented in respective services)

</hierarchy>

<own-artifacts aspects="pubsub-events,role-based-access">
### node.yaml
name: AdminService
type: service
aspects: [pubsub-events, role-based-access]
aspect_exceptions:
  - aspect: pubsub-events
    note: "inviteUserToSignInViaEmail AWAITS the pubsub.publish call (not fire-and-forget) and has NO try-catch around it. If PubSub throws, the exception propagates as unhandled → 500 Internal Server Error. The invited user record is already written to DB and the email is already sent, so admin sees failure but invitation data persists. Admin may re-invite, hitting USER_ALREADY_INVITED guard."

relations:
  - target: user/user-service
    type: calls
    consumes: [findUserByEmail, findUserById, createUserViaMagicLink, deleteUserByUID, makeAdmin, removeUserAsAdmin, makeAdmins, removeUsersAsAdmin, fetchAllUsers, fetchAllUsersV2, getUsersCount, fetchAdminUsers, updateUserDisplayName]
  - target: team/team-service
    type: calls
    consumes: [createTeam, deleteTeam, renameTeam, getTeamWithIDTE, addMemberToTeamWithEmail, addMemberToTeam, getTeamMembers, getCountOfMembersInTeam, leaveTeam, updateTeamAccessRole, fetchAllTeams, fetchAllTeamsV2, getTeamsCount]
  - target: team-collections/team-collection-service
    type: calls
    consumes: [getTeamCollectionsCount, searchByTitle]
  - target: team-request/team-request-service
    type: calls
    consumes: [totalRequestsInATeam, getTeamRequestsCount, searchRequest]
  - target: team-environments/team-environments-service
    type: calls
    consumes: [getTeamEnvironmentsCount]
  - target: team-invitation/team-invitation-service
    type: calls
    consumes: [getInvitation]

mapping:
  paths:
    - packages/hoppscotch-backend/src/admin/admin.service.ts

### responsibility.md
# AdminService -- Responsibility

[abbreviated for context budget — same as original]

### interface.md
# AdminService -- Interface

[abbreviated for context budget — same as original]

**PubSub-specific:** `inviteUserToSignInViaEmail` awaits `pubsub.publish` with no try-catch — PubSub failure = unhandled 500 error.

</own-artifacts>

<materialization-target paths="packages/hoppscotch-backend/src/admin/admin.service.ts" />

<aspect name="PubSub Events" id="pubsub-events">
### content.md
# PubSub Events

Every mutation to a team collection publishes a PubSub event so that connected clients (GraphQL subscriptions) receive real-time updates.

## Channel naming convention

- `team_coll/${teamID}/coll_added` — new collection created or imported
- `team_coll/${teamID}/coll_updated` — collection title or data changed
- `team_coll/${teamID}/coll_removed` — collection deleted (payload: collection ID, not full object)
- `team_coll/${teamID}/coll_moved` — collection moved to different parent
- `team_coll/${teamID}/coll_order_updated` — sibling order changed (payload includes moved collection + next collection)

## Timing

Events are published AFTER the database transaction commits successfully. This prevents phantom events where the client sees an update but the transaction rolled back. The exception is `deleteCollectionAndUpdateSiblingsOrderIndex` where the PubSub call happens after the retry loop succeeds.

## Payload shape

- Added/Updated/Moved: full `TeamCollection` model (cast from DB record)
- Removed: just the collection ID string
- Order updated: `{ collection, nextCollection }` pair

**⚠ Node exception (admin/admin-service):** inviteUserToSignInViaEmail AWAITS the pubsub.publish call (not fire-and-forget) and has NO try-catch around it. If PubSub throws, the exception propagates as unhandled → 500 Internal Server Error. The invited user record is already written to DB and the email is already sent, so admin sees failure but invitation data persists. Admin may re-invite, hitting USER_ALREADY_INVITED guard.

</aspect>

</context-package>Budget status: ok
