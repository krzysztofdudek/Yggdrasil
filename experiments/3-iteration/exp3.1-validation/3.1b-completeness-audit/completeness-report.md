# Completeness Audit — TeamCollectionService Graph

**Source file audited:**
`packages/hoppscotch-backend/src/team-collection/team-collection.service.ts`

**Graph files audited:**
- `aspects/pubsub-events/`
- `aspects/pessimistic-locking/`
- `aspects/retry-on-deadlock/`
- `model/team-collections/` (responsibility)
- `model/team-collections/team-collection-service/` (responsibility, constraints, decisions, logic)
- `flows/collection-management/`

**Audit scope:** COMPLETENESS only — what is MISSING from the graph, not what is wrong in it.

---

## Summary

The graph is substantially complete for the core mutation paths. Constraints, decisions, and the reorder algorithm are well captured. However, several public methods are absent from the graph entirely, important error paths are undocumented, and a number of behavioral edge cases and invariants visible only in the source code are missing. These omissions range from critical (undocumented public API methods) to moderate (undocumented error codes) to low (internal implementation details).

---

## Omissions, Ordered by Severity

### 1. (Critical) Five public methods are entirely absent from the graph

The graph documents no `interface.md` artifact at all for `TeamCollectionService`. As a result, the following public methods have zero graph coverage:

| Method | Signature summary |
|---|---|
| `getTeamOfCollection` | `(collectionID) -> Either<error, Team>` |
| `getParentOfCollection` | `(collectionID) -> TeamCollection \| null` (no Either) |
| `getChildrenOfCollection` | `(collectionID, cursor, take) -> TeamCollection[]` — cursor-based pagination |
| `getTeamRootCollections` | `(teamID, cursor, take) -> TeamCollection[]` — cursor-based pagination |
| `getCollectionForCLI` | `(collectionID, userUid) -> Either<error, GetCollectionResponse>` — includes team membership check |

None of these appear in `responsibility.md`, `constraints.md`, `logic.md`, `decisions.md`, or the flow description. A consuming agent cannot know these methods exist, what parameters they take, how they fail, or what they return.

Notable sub-omissions within these methods:

- `getParentOfCollection` returns a plain `null` (not `Either`) when the collection has no parent or is not found — an unusual return shape inconsistent with the Either pattern used everywhere else. This is an important interface contract that is absent from the graph.
- `getChildrenOfCollection` and `getTeamRootCollections` implement cursor-based pagination using ID cursors with `skip: cursor ? 1 : 0` semantics. This pagination contract is not documented anywhere in the graph.

### 2. (Critical) `sortTeamCollections` method is not in the graph

`sortTeamCollections(teamID, parentID, sortBy: SortOptions)` is a public method that sorts all siblings under a given parent by title (ascending or descending) or restores default order-index order. It:

- Acquires a pessimistic lock (consistent with the aspect)
- Runs all orderIndex updates as `Promise.all` inside a single transaction — concurrent updates, not sequential
- Returns `TEAM_COL_REORDERING_FAILED` on any error
- Does NOT publish a PubSub event

The absence of a PubSub event is a meaningful exception to the `pubsub-events` aspect. It is not documented in `node.yaml` under `aspect_exceptions`. Consumers of the real-time stream cannot know that sort operations produce no notification.

The `responsibility.md` of the parent `team-collections` module lists "sort" as in-scope, but the service-level artifacts do not describe the method, its parameters, or its behavior.

### 3. (High) `renameCollection` is deprecated but not documented as such

`renameCollection(collectionID, newTitle)` is marked `@deprecated` in source code with an instruction to use `updateTeamCollection` instead. The graph does not mention this deprecation. An agent reading the graph would have no way to know which method to prefer, potentially generating calls to a deprecated API.

### 4. (High) `totalCollectionsInTeam` and `getTeamCollectionsCount` are not documented

Two public query methods exist with no graph coverage:

- `totalCollectionsInTeam(teamID) -> number` — counts all collections for a team (no Either wrapper)
- `getTeamCollectionsCount() -> number` — counts ALL collections across ALL teams (system-wide metric)

These are distinct in scope: one is team-scoped, one is global. The difference matters for consumers (analytics, admin tooling). Neither is documented.

### 5. (High) Error code `TEAM_COLL_CREATION_FAILED` is missing from the graph

`importCollectionsFromJSON` and `createCollection` both return `TEAM_COLL_CREATION_FAILED` when the Prisma transaction itself throws (as opposed to validation errors). This error code does not appear anywhere in the graph. An agent implementing error handling for import or create paths cannot know this failure mode exists.

### 6. (High) `importCollectionsFromJSON` publishes events only for top-level collections, not nested ones

The graph's flow description says "Publish `coll_added` for each top-level created collection." This is technically correct, but does not make explicit that nested child collections (created recursively via `generatePrismaQueryObjForFBCollFolder`) receive NO PubSub event. Clients observing the event stream during a bulk import will only see events for the root-level imported collections, not for any nested children. This is an observable behavioral invariant that affects real-time client behavior. It should be captured as an aspect exception or a note in the flow.

### 7. (High) `moveCollection` acquires TWO separate locks but only in specific order

The graph's `pessimistic-locking` aspect documents locking on `(teamID, parentID)`. The flow description notes "Lock source's current sibling set" and "Lock destination's sibling set." However, neither the aspect nor the flow captures:

- The lock acquisition ORDER: source siblings are locked FIRST, then destination siblings. This ordering is what prevents deadlocks in cross-subtree moves. If two concurrent moves swapped this order, they would deadlock.
- The destination lock uses `destCollection.right.parentID` (the destination's parent's siblings), NOT the destination collection itself.

This is a concurrency invariant that cannot be reconstructed from the graph alone.

### 8. (Moderate) `updateCollectionOrder` has a silent no-op for deleted-during-race collections

Both reorder sub-paths (move to end, move to position) re-read orderIndex values inside the transaction after acquiring the lock. If the collection was deleted between the outer read and the inner transaction read (`collectionInTx` is null), the operation silently succeeds (`E.right(true)`) and publishes a PubSub event using the stale pre-transaction data. This is a documented race condition guard in code comments but is absent from the graph. An event is published for a collection that no longer exists.

### 9. (Moderate) `moveCollection` error on transaction failure returns `TEAM_COL_REORDERING_FAILED`, not a move-specific error

The outer catch in `moveCollection` returns `TEAM_COL_REORDERING_FAILED` for any transaction error. This is the same error code used by reorder operations, which is semantically misleading for a move operation. This is not documented in the graph — the constraints file lists the errors that `moveCollection` returns (TEAM_COLL_DEST_SAME, TEAM_COL_ALREADY_ROOT, etc.) but does not document the catch-all transaction failure path.

### 10. (Moderate) `fetchCollectionParentTree` has a silent bug: it swallows errors

At line 1278, `fetchCollectionParentTree` calls `E.left(TEAM_COLL_PARENT_TREE_GEN_FAILED)` but does NOT return the result — the `return` keyword is missing. The function returns `undefined` silently instead of propagating the error. This means search results with broken parent trees silently return no path instead of failing. This is an important failure-mode behavioral invariant missing from the graph (though it is arguably a bug; the graph should document the actual behavior regardless).

### 11. (Moderate) `getCollectionForCLI` has a team membership check not mentioned anywhere in the graph

`getCollectionForCLI` calls `this.teamService.getTeamMember(collection.teamID, userUid)` and returns `TEAM_MEMBER_NOT_FOUND` if the user is not a member of the owning team. The graph's responsibility section mentions "CLI support: `getCollectionForCLI` and `getCollectionTreeForCLI`" but says nothing about this authorization-adjacent membership check, its failure mode, or the dependency on `TeamService`.

### 12. (Moderate) Search pagination uses an unusual offset formula

`searchCollections` and `searchRequests` use this offset formula:
`OFFSET ${skip === 0 ? 0 : (skip - 1) * take}`

This means `skip=1` produces `OFFSET 0` (same as `skip=0`), and `skip=2` produces `OFFSET take`. This is page-based pagination disguised as an offset parameter, where `skip` is a page number (1-indexed), not a row count. The graph documents that search accepts `take` and `skip` parameters but does not explain this non-standard semantics. A consumer implementing search pagination will produce off-by-one errors if they treat `skip` as a row offset.

### 13. (Low) The `data` field transformation via `transformCollectionData` is not documented

Every public method that returns a `TeamCollection` model calls `this.cast()`, which calls `transformCollectionData(collection.data)`. The graph does not document what this transformation does or why it exists. Callers cannot know whether the returned `data` field is in the same format as the stored format, or whether `null` and `{}` are treated differently.

### 14. (Low) `isParent` receives a `tx` parameter but the graph's logic description omits this

`logic.md` documents the `isParent` algorithm correctly, but does not mention that the function accepts an optional `Prisma.TransactionClient`. When called from within `moveCollection`, it reads parent collections using the in-progress transaction — meaning it operates on locked, in-flight data, not committed data. This is a subtle but important transactional correctness property.

### 15. (Low) `generatePrismaQueryObjForFBCollFolder` assigns child orderIndex starting from 1 based on array position

During import, child collections within a folder are assigned `orderIndex = index + 1` based on their array position in the import JSON. This means the import format implicitly encodes ordering — reordering the JSON array changes the resulting tree order. This behavioral contract between import format and stored order is not documented.

### 16. (Low) `duplicateTeamCollection` title suffix is hardcoded

The duplication suffix `" - Duplicate"` is hardcoded. The `decisions.md` explains the export+import pattern but does not document this specific string. An agent recreating duplication behavior cannot know the exact title transformation without reading the source.

---

## Aspect Exceptions Not Recorded in `node.yaml`

The following behaviors deviate from declared aspects but are not recorded under `aspect_exceptions` in `node.yaml`:

| Aspect | Exception |
|---|---|
| `pubsub-events` | `sortTeamCollections` completes successfully but publishes NO event |
| `pubsub-events` | Import publishes events only for top-level collections, not nested children |
| `pubsub-events` | `updateCollectionOrder` publishes with PRE-TRANSACTION stale data (the `collection` passed to publish is read before the lock, not after) |
| `retry-on-deadlock` | The aspect description says "exponential backoff" (`aspect.yaml`) but the content correctly says "linear backoff." The `aspect.yaml` description field contains incorrect metadata. |

---

## Methods Present in Graph vs Source Code

| Method | Documented in graph? |
|---|---|
| `createCollection` | Yes (flow + constraints) |
| `renameCollection` | Implicit (listed in responsibility) — deprecated status absent |
| `updateTeamCollection` | Implicit (listed in responsibility) |
| `deleteCollection` | Yes (flow + constraints) |
| `moveCollection` | Yes (flow + constraints + logic) |
| `updateCollectionOrder` | Yes (logic.md) |
| `importCollectionsFromJSON` | Yes (flow) |
| `exportCollectionToJSONObject` | Implicit (responsibility mentions export) |
| `exportCollectionsToJSON` | Not documented |
| `duplicateTeamCollection` | Yes (flow + decisions) |
| `sortTeamCollections` | Not documented |
| `searchByTitle` | Yes (flow) |
| `getTeamOfCollection` | Not documented |
| `getParentOfCollection` | Not documented |
| `getChildrenOfCollection` | Not documented |
| `getTeamRootCollections` | Not documented |
| `getCollection` | Not documented |
| `getCollectionForCLI` | Mentioned in responsibility, not detailed |
| `totalCollectionsInTeam` | Not documented |
| `getTeamCollectionsCount` | Not documented |
| `getCollectionCount` | Not documented |

---

## Verdict

The graph's coverage is strongest for the mutation paths (create, delete, move, reorder), where constraints, decisions, concurrency rationale, and algorithms are well captured. The graph's coverage is weakest for the read/query paths, CLI methods, and admin/counting methods — which are entirely absent.

The most significant structural gap is the absence of an `interface.md` artifact. The graph correctly routes behavioral invariants to `constraints.md` and algorithms to `logic.md`, but without an interface artifact, no consumer can discover the full public API surface, parameter shapes, return types, or failure modes for the majority of the service's methods.
