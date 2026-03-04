<context-package node-path="user/user-service" node-name="UserService" token-count="2800">

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

<hierarchy path="user" aspects="pubsub-events">
### responsibility.md
# User

Manages user accounts and profiles in Hoppscotch. Users are the identity layer: they authenticate via SSO or magic links, have profiles with display names and photos, and can be elevated to admin status. This module handles all user CRUD, session management, and coordinates user deletion across dependent services via the UserDataHandler pattern.

## In scope

- User CRUD (create via magic link or SSO, find, update, delete)
- User profile management (display name, photo URL, last logged on, last active on)
- Session management (REST and GQL sessions)
- Provider account management (SSO provider linking)
- Admin status management (make/remove admin)
- User deletion orchestration via registered UserDataHandler callbacks
- Real-time event publishing for user updates and deletions
- Bulk operations (find by IDs, make/remove admins in batch)

## Out of scope

- Authentication flow (handled by auth module)
- Team membership (handled by team module, but coordinates via UserDataHandler)
- Authorization and guards

</hierarchy>

<own-artifacts aspects="pubsub-events">
### node.yaml
name: UserService
type: service
aspects: [pubsub-events]
aspect_exceptions:
  - aspect: pubsub-events
    note: "updateUserSessions and updateUserDisplayName AWAIT the pubsub.publish call (not fire-and-forget). Both are inside try-catch blocks — if publish throws, updateUserSessions returns E.left(USER_UPDATE_FAILED) and updateUserDisplayName returns E.left(USER_NOT_FOUND), masking the pubsub failure as a DB error. deleteUserByUID uses TE.fromTask/TE.chainFirst for the publish, which is fire-and-forget in the fp-ts pipeline."

relations: []

mapping:
  paths:
    - packages/hoppscotch-backend/src/user/user.service.ts

### interface.md
# UserService -- Interface

## User queries

- `findUserByEmail(email: string): Promise<Option<AuthUser>>` -- case-insensitive email lookup
- `findUserById(userUid: string): Promise<Option<AuthUser>>` -- lookup by UID
- `findUsersByIds(userUIDs: string[]): Promise<AuthUser[]>` -- bulk lookup
- `fetchAllUsers(cursorID: string, take: number): Promise<User[]>` -- cursor-paginated (deprecated)
- `fetchAllUsersV2(searchString: string, pagination: OffsetPaginationArgs): Promise<User[]>` -- offset-paginated with search
- `getUsersCount(): Promise<number>` -- total user count
- `fetchAdminUsers(): Promise<User[]>` -- all admin users
- `fetchUserWorkspaces(userUid: string): Promise<Either<string, GetUserWorkspacesResponse[]>>` -- user's team workspaces with role counts

## User mutations

- `updateUserSessions(user: AuthUser, currentSession: string, sessionType: string): Promise<Either<string, User>>` -- update REST/GQL session, **awaits** publish (deviation from fire-and-forget)
- `updateUserDisplayName(userUID: string, displayName: string): Promise<Either<string, User>>` -- update name, **awaits** publish (deviation from fire-and-forget)

## User deletion

- `deleteUserByUID(user: AuthUser): TaskEither<string, Either<string, boolean>>` -- full deletion cascade with handler checks, publishes event via TE.chainFirst (fire-and-forget)

### responsibility.md
# UserService -- Responsibility

The central service for user account management. Handles user creation (via magic link or SSO), profile updates, session management, admin status, and user deletion with a plugin-style data handler pattern. Other services register as UserDataHandler implementations to participate in user deletion checks and cleanup.

## In scope

- User lookup: find by email (case-insensitive), find by ID, find by multiple IDs
- User creation: via magic link (email only), via SSO (with profile data)
- Profile updates: display name, photo URL, last logged on, last active on
- Session management: update and validate REST/GQL sessions (JSON stored in DB)
- Admin management: make admin (single/batch), remove admin (single/batch), fetch admins
- User deletion orchestration: register data handlers, check deletion eligibility, cascade to handlers, delete account, publish event

## Out of scope

- Authentication flow (auth module)
- Team membership CRUD (team module, but registers as UserDataHandler)
- Authorization guards

</own-artifacts>

<materialization-target paths="packages/hoppscotch-backend/src/user/user.service.ts" />

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

**⚠ Node exception (user/user-service):** updateUserSessions and updateUserDisplayName AWAIT the pubsub.publish call (not fire-and-forget). Both are inside try-catch blocks — if publish throws, updateUserSessions returns E.left(USER_UPDATE_FAILED) and updateUserDisplayName returns E.left(USER_NOT_FOUND), masking the pubsub failure as a DB error. deleteUserByUID uses TE.fromTask/TE.chainFirst for the publish, which is fire-and-forget in the fp-ts pipeline.

</aspect>

</context-package>Budget status: ok
