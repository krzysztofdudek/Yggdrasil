<context-package node-path="team-collections/team-collection-service" node-name="TeamCollectionService" token-count="6500">

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

<hierarchy path="team-collections" aspects="pessimistic-locking,pubsub-events">
### responsibility.md
# Team Collections

Manages the hierarchical collection tree for teams in Hoppscotch. Collections organize API requests into a tree structure with arbitrary nesting depth, integer-based sibling ordering, and real-time collaboration via PubSub events.

## In scope

- Collection CRUD (create, read, update, delete)
- Tree operations (move between parents, reorder siblings, sort)
- Tree integrity (circular reference prevention, orderIndex consistency)
- Import/export (JSON serialization of entire subtrees)
- Search with parent tree reconstruction (breadcrumb paths)
- Duplication (export + re-import pattern)
- Real-time event publishing for all mutations

## Out of scope

- User authentication and authorization (handled by guards/resolvers)
- Request-level CRUD (separate TeamRequest service)
- Team management (delegated to TeamService)

</hierarchy>

<own-artifacts aspects="pessimistic-locking,pubsub-events,retry-on-deadlock,team-ownership">
### node.yaml
name: TeamCollectionService
type: service
aspects: [pessimistic-locking, pubsub-events, retry-on-deadlock, team-ownership]
aspect_exceptions:
  - aspect: pubsub-events
    note: "moveCollection publishes PubSub events INSIDE the $transaction callback (lines 776-779 and 825-828), NOT after commit. Both coll_moved and coll_order_updated events fire while the transaction is still open. If the transaction rolls back after publishing, subscribers receive phantom events for data that was never committed. Also: renameCollection and updateTeamCollection publish inside try-catch blocks — if publish throws, caller gets TEAM_COLL_NOT_FOUND even though the DB write succeeded."

relations:
  - target: team/team-service
    type: calls
    consumes: [getTeamMember]

mapping:
  paths:
    - packages/hoppscotch-backend/src/team-collection/team-collection.service.ts

### constraints.md
# TeamCollectionService — Constraints

## Circular reference prevention

A collection cannot be moved into its own descendant. The `isParent` method walks up the tree from the destination to the root. If it encounters the source collection on that path, the move is rejected with `TEAM_COLL_IS_PARENT_COLL`. This prevents infinite loops in the tree structure.

## OrderIndex contiguity

Within a sibling set (same teamID + parentID), orderIndex values must be contiguous starting from 1. Every delete decrements all higher siblings. Every create appends at `lastIndex + 1`. Reorder shifts affected ranges up or down by 1. This invariant ensures no gaps and no duplicates, which is critical for predictable cursor-based pagination and drag-and-drop UI.

## Same-team constraint

A collection can only be moved to a parent that belongs to the same team. Cross-team moves are rejected with `TEAM_COLL_NOT_SAME_TEAM`.

## Self-move prevention

A collection cannot be moved into itself (`TEAM_COLL_DEST_SAME`) or reordered next to itself (`TEAM_COL_SAME_NEXT_COLL`).

## Already-root guard

Moving a root collection to root (parentID null → null) is rejected with `TEAM_COL_ALREADY_ROOT`. This is a no-op prevention, not a business rule.

## Title minimum length

Collection titles must be at least 1 character (`TITLE_LENGTH = 1`). Empty titles are rejected with `TEAM_COLL_SHORT_TITLE`.

## Data field validation

The optional `data` field (collection metadata/headers) must be valid JSON if provided. Empty string is explicitly rejected (not treated as null). Invalid JSON is rejected with `TEAM_COLL_DATA_INVALID`.


### decisions.md
# TeamCollectionService — Decisions

## Why duplication uses export + import

Rather than implementing a separate deep-copy method, duplication exports the collection to JSON, modifies the title (appending " - Duplicate"), then re-imports. This reuses the existing recursive import logic (which handles nested children, requests, locking, and orderIndex assignment) without duplicating it. Trade-off: slightly more overhead (serialization round-trip) but eliminates a separate code path that would need to maintain parity with import logic.

## Why search uses raw SQL instead of Prisma query builder

The search requires PostgreSQL-specific features: `ILIKE` for case-insensitive matching, `similarity()` function for fuzzy ranking, and `escapeSqlLikeString` for safe wildcard injection. Prisma's query builder doesn't expose `similarity()` or custom ordering by a function result. Raw SQL is the only option for this query pattern.

## Why parent tree reconstruction uses recursive CTE

After finding search matches, the UI needs to display breadcrumb paths (e.g., "Team > Parent Collection > Child Collection > Match"). Rather than making N queries to walk up the tree per result, a single `WITH RECURSIVE` CTE efficiently fetches the entire ancestor chain in one query. This is critical for performance when search returns many results.

## Why `isParent` walks up, not down

To check if Collection_A is an ancestor of Collection_D, the code walks UP from D to root (following parentID links), checking if any parent is A. The alternative — walking DOWN from A through all descendants — would require loading the entire subtree. Walking up follows a single chain of parentID pointers, which is O(depth) not O(subtree_size).

## Why orderIndex is integer-based, not fractional

Integer orderIndex with gap-filling (decrement on delete, shift on reorder) requires touching multiple rows on every mutation but guarantees contiguous, predictable indexes. Fractional ordering (assigning values between existing items) avoids touching siblings but eventually requires rebalancing when precision is exhausted. For a real-time collaborative tool where consistency matters more than write throughput, integer ordering is simpler to reason about.

## Why delete has retries but other mutations do not

Delete+reindex can race with other deletes on the same sibling set. Two concurrent deletes each start a transaction, lock, then try to decrement overlapping ranges. The pessimistic lock prevents data corruption but can cause deadlocks when lock acquisition order differs. The retry loop handles these transient deadlocks. Create and move operations are less prone to this because they typically modify non-overlapping index ranges (append at end, or shift in one direction).


### interface.md
# TeamCollectionService -- Interface

## Collection queries

- `getCollection(collectionID: string): Promise<Either<string, TeamCollection>>` -- get by ID
- `getTeamOfCollection(collectionID: string): Promise<Either<string, Team>>` -- resolve team from collection
- `getChildCollections(collectionID: string): Promise<TeamCollection[]>` -- direct children
- `searchByTitle(searchTerm: string, teamID: string, take: number, type: string): Promise<CollectionSearchNode[]>` -- fuzzy search with breadcrumbs
- `totalCollectionsInTeam(teamID: string): Promise<number>` -- count per team
- `getTeamCollectionsCount(): Promise<number>` -- total count

## Collection mutations

- `createCollection(title: string, teamID: string, parentID?: string, data?: string): Promise<Either<string, TeamCollection>>` -- create with ordering
- `renameCollection(collectionID: string, newTitle: string): Promise<Either<string, TeamCollection>>` -- rename (deprecated)
- `updateTeamCollection(collectionID: string, data: string): Promise<Either<string, TeamCollection>>` -- update metadata
- `deleteCollection(collectionID: string): Promise<Either<string, boolean>>` -- delete with sibling reindexing and retry
- `moveCollection(srcCollID: string, destCollID?: string): Promise<Either<string, TeamCollection>>` -- move to root or into another collection. **⚠ PubSub deviation:** publishes events INSIDE the $transaction callback, not after commit.
- `updateCollectionOrder(collectionID: string, nextCollectionID?: string): Promise<Either<string, TeamCollection>>` -- reorder siblings
- `sortCollection(teamID: string, collectionID?: string, sortBy: SortOptions): Promise<Either<string, boolean>>` -- sort children

## Import/export

- `importCollectionsFromJSON(jsonString: string, teamID: string, parentCollID?: string): Promise<Either<string, boolean>>` -- import from JSON
- `exportCollectionsToJSON(teamID: string, collectionID?: string): Promise<Either<string, string>>` -- export to JSON
- `duplicateCollection(teamID: string, collectionID: string): Promise<Either<string, boolean>>` -- export + reimport with title change


### logic.md
# TeamCollectionService — Logic

## Reorder algorithm (updateCollectionOrder)

Two cases based on `nextCollectionID`:

### Move to end (nextCollectionID = null)

1. Lock siblings
2. Re-read collection's current orderIndex inside transaction (race condition guard)
3. Decrement all siblings with orderIndex > current (fills the gap)
4. Set collection's orderIndex = total count of siblings (puts it at the end)

### Move to specific position (nextCollectionID != null)

1. Lock siblings
2. Re-read BOTH collection and nextCollection orderIndex inside transaction
3. Determine direction: `isMovingUp = nextCollection.orderIndex < collection.orderIndex`
4. If moving UP: increment all siblings in range `[nextCollection.orderIndex, collection.orderIndex - 1]`
5. If moving DOWN: decrement all siblings in range `[collection.orderIndex + 1, nextCollection.orderIndex - 1]`
6. Set collection's orderIndex to: if moving up → `nextCollection.orderIndex`, if moving down → `nextCollection.orderIndex - 1`

The "next collection" semantics mean: "place me just before this collection."


### responsibility.md
# TeamCollectionService — Responsibility

The central service for all team collection operations. Coordinates Prisma database transactions with pessimistic row locking, maintains orderIndex consistency across sibling sets, prevents circular tree structures, and publishes real-time PubSub events after every mutation.

## In scope

- Collection CRUD: create, rename, update (title/data), delete with sibling reindexing
- Tree operations: move collection (to root or into another collection), reorder siblings, sort siblings
- Tree integrity: recursive ancestor check (`isParent`) to prevent circular moves
- Import/export: recursive JSON serialization and deserialization of entire collection subtrees
- Search: raw SQL queries with `ILIKE` + `similarity()` fuzzy matching, plus recursive CTE for parent tree reconstruction
- Duplication: export-then-import with title modification

## Out of scope

- Authentication/authorization (handled by resolvers and guards)
- Individual request CRUD within collections
- Team membership management (delegated to TeamService)
- PubSub infrastructure (delegated to PubSubService)

</own-artifacts>

<materialization-target paths="packages/hoppscotch-backend/src/team-collection/team-collection.service.ts" />

<aspect name="Pessimistic Locking" id="pessimistic-locking">
### content.md
# Pessimistic Locking

Every operation that reads and then modifies sibling orderIndex values must acquire a row lock first. Without this, two concurrent reorder/create/delete operations on siblings under the same parent could read stale orderIndex values and produce duplicates or gaps.

## Pattern

1. Open a `prisma.$transaction`
2. Call `prisma.lockTeamCollectionByTeamAndParent(tx, teamID, parentID)` — this locks all sibling rows under the given parent
3. Read current state (last orderIndex, collection to move, etc.)
4. Perform mutations (create, delete, update orderIndex)
5. Transaction commits, releasing locks

## Why pessimistic, not optimistic

Optimistic locking (version columns + retry on conflict) would require every collection row to carry a version field and every read to include it. Since reorder operations often touch MANY siblings (updateMany with range conditions), optimistic locking would be impractical — a single conflicting row would invalidate the entire batch. Pessimistic locking serializes access to the sibling set, which is the correct granularity.

## Scope

The lock is scoped to `(teamID, parentID)` — it locks siblings, not the entire team's collections. This means operations on different subtrees can proceed in parallel.

</aspect>

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

**⚠ Node exception (team-collections/team-collection-service):** moveCollection publishes PubSub events INSIDE the $transaction callback (lines 776-779 and 825-828), NOT after commit. Both coll_moved and coll_order_updated events fire while the transaction is still open. If the transaction rolls back after publishing, subscribers receive phantom events for data that was never committed. Also: renameCollection and updateTeamCollection publish inside try-catch blocks — if publish throws, caller gets TEAM_COLL_NOT_FOUND even though the DB write succeeded.

</aspect>

<aspect name="Retry on Deadlock" id="retry-on-deadlock">
### content.md
# Retry on Deadlock

Delete+reorder operations use a retry loop because concurrent modifications to sibling orderIndexes can cause transient database errors.

## Retry conditions

The retry loop continues ONLY for these specific Prisma error codes:
- `UNIQUE_CONSTRAINT_VIOLATION` — two operations assigned the same orderIndex
- `TRANSACTION_DEADLOCK` — two transactions locked rows in conflicting order
- `TRANSACTION_TIMEOUT` — lock wait exceeded timeout

Any other database error is NOT retried — it indicates a non-transient problem (bad data, missing record, etc.).

## Strategy

- Maximum retries: 5 (`MAX_RETRIES`)
- Delay: linear backoff `retryCount * 100ms` (100ms, 200ms, 300ms, 400ms, 500ms)
- On exhaustion: returns `E.left(TEAM_COL_REORDERING_FAILED)`

## Where this applies

Currently only `deleteCollectionAndUpdateSiblingsOrderIndex`. Other order mutations (create, move, reorder) do NOT retry — they rely solely on pessimistic locking.

</aspect>

<aspect name="Team Ownership" id="team-ownership">
### content.md
# Team Ownership

All collaborative resources in Hoppscotch are scoped to a team. Before creating or accessing a resource, the service verifies that it belongs to the expected team.

## Cross-team isolation

There is no cross-team sharing. A collection, request, or environment belongs to exactly one team. Moving resources between teams is not supported.

</aspect>

<dependency target="team/team-service" type="calls" consumes="getTeamMember">
Consumes: getTeamMember

### responsibility.md
# TeamService -- Responsibility

The core service for team and team membership operations. Manages the full lifecycle of teams (create, rename, delete) and team members (add, remove, update roles, query). Publishes PubSub events for all membership mutations.

### interface.md
# TeamService -- Interface

## Team member queries

- `getTeamMember(teamID: string, userUid: string): Promise<TeamMember | null>` -- find specific membership

</dependency>

</context-package>Budget status: ok
