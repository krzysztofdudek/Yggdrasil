# ShortcodeService — Graph Artifacts

---

### node.yaml

```yaml
node:
  name: ShortcodeService
  type: service
  description: >
    Manages the lifecycle of shortcodes — short alphanumeric identifiers that
    encode an HTTP request payload and optional embed properties. Provides CRUD
    operations, pagination, pub/sub event emission, and participates in user
    data cleanup on account deletion.

files:
  - src/shortcode/shortcode.service.ts
  - src/shortcode/shortcode.resolver.ts
  - src/shortcode/shortcode.model.ts

aspects:
  - fp-ts-either-returns        # All mutating methods return E.Either; callers must unwrap
  - pubsub-fire-and-forget       # pub/sub publish calls are not awaited
  - cursor-based-pagination      # list queries use cursor + take pattern
  - user-data-handler            # implements UserDataHandler; hooks into user deletion lifecycle

relations:
  - target: PrismaService
    type: structural
    description: Sole persistence layer for all shortcode read/write operations.
  - target: PubSubService
    type: structural
    description: >
      Receives created/updated/revoked events keyed by
      shortcode/<creatorUid>/<event>.
  - target: UserService
    type: structural
    description: >
      Registers itself as a UserDataHandler on module init so it is called
      when a user account is deleted.
```

---

### responsibility.md

## Identity

ShortcodeService is the single authoritative service for shortcode data in the
Hoppscotch backend. A shortcode is a 12-character alphanumeric identifier that
encodes a serialised HTTP request and, optionally, a set of embed properties
used for iframe/widget presentation.

## In Scope

- Generating collision-free 12-character alphanumeric shortcode IDs.
- Creating, reading, updating (embed properties only), and deleting individual
  shortcodes.
- Bulk-deleting all shortcodes belonging to a user (used during account
  deletion).
- Listing shortcodes by owner (paginated, cursor-based, newest-first).
- Listing all shortcodes across all users for admin purposes, with optional
  filter by creator email (paginated, cursor-based, newest-first).
- Emitting real-time pub/sub events on create, update, and revoke so GraphQL
  subscriptions can propagate changes to connected clients.
- Registering with UserService as a UserDataHandler so user deletion
  automatically purges owned shortcodes.

## Out of Scope

- Authentication and authorisation — enforced by guards in the resolver layer.
- Rate limiting — enforced by `GqlThrottlerGuard` in the resolver.
- Serving the resolved shortcode content (e.g., redirects) — outside this
  service.
- Any aspect of the GraphQL transport layer.
- Managing user accounts or any other user data beyond shortcodes.

---

### interface.md

## Public Methods

### `getShortCode(shortcode: string): Promise<E.Either<"SHORTCODE_NOT_FOUND", Shortcode>>`

Fetches a single shortcode by its ID.

- **Parameters:** `shortcode` — the 12-character ID string.
- **Returns:** `E.right(Shortcode)` if found; `E.left(SHORTCODE_NOT_FOUND)` if
  no record exists or the DB call throws.
- **Side effects:** None.

---

### `createShortcode(request: string, properties: string | null, userInfo: AuthUser): Promise<E.Either<error, Shortcode>>`

Creates a new shortcode and emits a creation event.

- **Parameters:**
  - `request` — JSON string of the request payload. Must be non-null and
    parseable as JSON.
  - `properties` — JSON string of embed properties; `null` is allowed and
    stored as absent.
  - `userInfo` — the authenticated user; `uid` is stored as `creatorUid`.
- **Returns:** `E.right(Shortcode)` on success. Possible left values:
  - `SHORTCODE_INVALID_REQUEST_JSON` — `request` is not valid JSON or is
    falsy after parsing.
  - `SHORTCODE_INVALID_PROPERTIES_JSON` — `properties` is non-null but not
    valid JSON.
- **Side effects:** Publishes `shortcode/<creatorUid>/created` via PubSub
  (fire-and-forget, only when `creatorUid` is non-null).

---

### `fetchUserShortCodes(uid: string, args: PaginationArgs): Promise<Shortcode[]>`

Returns a page of shortcodes owned by the given user, ordered newest-first.

- **Parameters:**
  - `uid` — the owner's user UID.
  - `args` — `{ cursor?: string; take: number }` cursor-based pagination.
- **Returns:** Array of `Shortcode` (may be empty). Never throws; returns `[]`
  on no results.
- **Side effects:** None.

---

### `revokeShortCode(shortcode: string, uid: string): Promise<E.Either<"SHORTCODE_NOT_FOUND", true>>`

Deletes a specific shortcode that belongs to the given user.

- **Parameters:**
  - `shortcode` — the shortcode ID.
  - `uid` — the owning user's UID. The delete uses the composite unique
    constraint `(creatorUid, id)` — only the owner can revoke their own code.
- **Returns:** `E.right(true)` on success; `E.left(SHORTCODE_NOT_FOUND)` if
  the record does not exist or does not match the given uid.
- **Side effects:** Publishes `shortcode/<creatorUid>/revoked` via PubSub
  (fire-and-forget). Note: unlike `createShortcode`, this publish is
  unconditional — no null-check on `creatorUid`.

---

### `deleteUserShortCodes(uid: string): Promise<number>`

Bulk-deletes all shortcodes owned by a user. Used by the user deletion
lifecycle handler.

- **Parameters:** `uid` — the user UID whose shortcodes are purged.
- **Returns:** Count of deleted records.
- **Side effects:** None — no pub/sub events emitted.
- **Note:** Does not emit pub/sub events for individual deletions.

---

### `deleteShortcode(shortcodeID: string): Promise<E.Either<"SHORTCODE_NOT_FOUND", true>>`

Deletes a shortcode by ID regardless of owner. Intended for admin use.

- **Parameters:** `shortcodeID` — the shortcode ID.
- **Returns:** `E.right(true)` on success; `E.left(SHORTCODE_NOT_FOUND)` if
  not found.
- **Side effects:** None — no pub/sub events emitted.

---

### `updateEmbedProperties(shortcodeID: string, uid: string, updatedProps: string): Promise<E.Either<error, Shortcode>>`

Updates the `embedProperties` field of a shortcode owned by the given user.

- **Parameters:**
  - `shortcodeID` — the shortcode ID.
  - `uid` — the owning user's UID (enforced via composite unique constraint).
  - `updatedProps` — non-empty JSON string of the new embed properties.
- **Returns:** `E.right(Shortcode)` with updated data on success. Possible
  left values:
  - `SHORTCODE_PROPERTIES_NOT_FOUND` — `updatedProps` is falsy.
  - `SHORTCODE_INVALID_PROPERTIES_JSON` — `updatedProps` is not valid JSON or
    parses to a falsy value.
  - `SHORTCODE_NOT_FOUND` — no matching `(creatorUid, id)` record.
- **Side effects:** Publishes `shortcode/<creatorUid>/updated` via PubSub
  (fire-and-forget).

---

### `fetchAllShortcodes(args: PaginationArgs, userEmail?: string | null): Promise<ShortcodeWithUserEmail[]>`

Returns a paginated list of all shortcodes across all users. Intended for
admin-facing queries.

- **Parameters:**
  - `args` — cursor-based pagination `{ cursor?: string; take: number }`.
  - `userEmail` — optional case-insensitive filter by creator email.
- **Returns:** Array of `ShortcodeWithUserEmail` (includes creator uid and
  email if user record exists; `creator` may be `null` for orphaned shortcodes).
- **Side effects:** None.

---

## Lifecycle Hooks (UserDataHandler interface)

### `canAllowUserDeletion(user: AuthUser): TO.TaskOption<string>`

Always returns `TO.none` — the service never blocks user deletion.

### `onUserDelete(user: AuthUser): T.Task<void>`

Invokes `deleteUserShortCodes(user.uid)` asynchronously when a user account is
deleted.

---

## Data Structures

### `Shortcode`
| Field       | Type     | Notes                                   |
|-------------|----------|-----------------------------------------|
| `id`        | string   | 12-char alphanumeric ID                 |
| `request`   | string   | JSON string of the HTTP request payload |
| `properties`| string?  | JSON string of embed properties; nullable |
| `createdOn` | Date     | Creation timestamp                      |

### `ShortcodeWithUserEmail`
Extends `Shortcode` with:
| Field     | Type                        | Notes                                      |
|-----------|-----------------------------|--------------------------------------------|
| `creator` | `{ uid, email }` or `null`  | Null if user record no longer exists       |

---

### internals.md

## Logic

### ID Generation

Shortcode IDs are 12 characters drawn uniformly at random from 62 characters
(`a-z`, `A-Z`, `0-9`). The character set and length are module-level constants:

```
SHORT_CODE_LENGTH = 12
SHORT_CODE_CHARS  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
```

Uniqueness is guaranteed by a retry loop in `generateUniqueShortCodeID`: a
candidate ID is generated, looked up in the DB via `getShortCode`, and only
accepted if the lookup returns `E.left` (not found). The loop is unbounded —
it retries indefinitely until a collision-free ID is found.

Observation: The probability space is 62^12 ≈ 3.2 × 10^21 entries. Collisions
are astronomically unlikely in practice, which likely explains the unbounded
retry over a bounded retry with error fallback — rationale: unknown, inferred
from code, not confirmed by developer.

### Type Casting (`cast` method)

`cast` converts a Prisma `Shortcode` DB record to the GQL `Shortcode` model:

- `request` (stored as Prisma JSON / `JsonValue`) is re-serialised to a JSON
  string via `JSON.stringify`.
- `embedProperties` is re-serialised to a JSON string if present, or mapped to
  `null`.
- `id` and `createdOn` are passed through unchanged.

This re-serialisation at every read means the string representation may not
be byte-for-byte identical to what was originally stored (JSON key ordering
may vary). Rationale for this approach: unknown — inferred from code, not
confirmed by developer.

### Pub/Sub Event Topics

Events are published to per-user, per-action topics:

| Action   | Topic pattern                        | Emitter method          |
|----------|--------------------------------------|-------------------------|
| Create   | `shortcode/<creatorUid>/created`     | `createShortcode`       |
| Update   | `shortcode/<creatorUid>/updated`     | `updateEmbedProperties` |
| Revoke   | `shortcode/<creatorUid>/revoked`     | `revokeShortCode`       |

All publish calls are fire-and-forget (not awaited). The resolver subscribes
to these topics per authenticated user.

**Asymmetry in null-guard:** `createShortcode` checks `creatorUid != null`
before publishing. `revokeShortCode` and `updateEmbedProperties` do not.
Rationale: unknown — inferred from code, not confirmed by developer. In
practice, all three mutations require `GqlAuthGuard`, so `creatorUid` should
always be present at the resolver layer.

### Pagination

All list queries use cursor-based pagination:

- `cursor` is the `id` field of the last-seen shortcode.
- When `cursor` is provided, `skip: 1` is set to exclude the cursor record
  itself from the result.
- Results are ordered `createdOn DESC` (newest first).
- `take` controls page size; no server-side cap is applied within the service —
  caller is responsible for sensible limits.

### User Deletion Integration

`ShortcodeService` registers itself with `UserService.registerUserDataHandler`
in `onModuleInit`. When a user is deleted, `UserService` calls
`onUserDelete(user)`, which triggers `deleteUserShortCodes(uid)`. This bulk
delete does not emit pub/sub events — connected clients are not notified of
individual shortcode removals during account deletion.

## Constraints

- Shortcode IDs are always exactly 12 alphanumeric characters.
- Only the owning user can revoke or update a shortcode (enforced at DB level
  via composite unique constraint `creator_uid_shortcode_unique (creatorUid, id)`).
- `deleteShortcode` bypasses the owner check — it deletes by ID alone. This
  suggests an admin-only code path. Rationale: unknown — inferred from code,
  not confirmed by developer.
- `request` field is mandatory and must be valid, non-empty JSON.
- `embedProperties` / `properties` is optional on create; mandatory and
  non-empty JSON on update.

## Decisions

### fp-ts Either for error propagation
The service returns `E.Either<ErrorCode, T>` from all fallible operations rather
than throwing exceptions. The resolver layer unwraps via `throwErr` to convert
left values into GraphQL errors.
Rationale: unknown — inferred from code, not confirmed by developer.
Rejected alternatives: not documented in code.

### Unbounded uniqueness retry loop
`generateUniqueShortCodeID` uses `while(true)` with no iteration cap.
Rationale: unknown — likely acceptable given the enormous ID space (62^12),
but this is an inference, not confirmed by developer.
Rejected alternatives: bounded retry with a fallback error; UUID-based IDs;
database-generated sequences. None are evidenced in the code.

### No pub/sub events on bulk user deletion
`deleteUserShortCodes` does not emit per-shortcode revoke events. This means
subscribed clients are not notified when shortcodes are removed as a side
effect of user deletion.
Rationale: unknown — inferred from code, not confirmed by developer.
Rejected alternatives: emitting individual revoke events per deleted shortcode.
