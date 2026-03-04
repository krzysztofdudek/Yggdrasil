### node.yaml

```yaml
node:
  id: shortcode-service
  name: ShortcodeService
  type: service
  description: >
    Manages the lifecycle of shortcodes — short alphanumeric identifiers that
    encode HTTP request data and optional embed properties, allowing requests
    to be shared via a compact URL-safe code.

aspects:
  - fp-ts-error-handling        # Either<Error, T> pattern used throughout public methods
  - pubsub-event-publishing     # Publishes domain events after state mutations
  - cursor-based-pagination     # All list queries use PaginationArgs (cursor + take)
  - user-data-handler           # Implements UserDataHandler; participates in user deletion lifecycle

relations:
  - target: prisma-service
    type: structural
    role: persistence — all shortcode CRUD operations go through PrismaService
  - target: pubsub-service
    type: structural
    role: event publishing — publishes created/updated/revoked events per user channel
  - target: user-service
    type: structural
    role: lifecycle registration — registers itself as a UserDataHandler on module init
  - target: shortcode-resolver
    type: structural
    role: consumed by — resolver calls this service for all GraphQL operations

files:
  - src/shortcode/shortcode.service.ts
  - src/shortcode/shortcode.model.ts
  - src/shortcode/shortcode.resolver.ts
```

---

### responsibility.md

## Identity

ShortcodeService is the domain service responsible for the full lifecycle of shortcodes in the Hoppscotch backend. A shortcode is a 12-character alphanumeric identifier that encodes an HTTP request payload (and optionally embed display properties), enabling requests to be referenced and shared by a compact code rather than a full URL.

## In Scope

- Generating unique 12-character alphanumeric shortcode IDs (collision-safe via retry loop).
- Creating shortcodes tied to a creator user, persisting request JSON and optional embed properties.
- Fetching a single shortcode by ID (public, no auth required at service level).
- Listing all shortcodes belonging to a specific user, with cursor-based pagination.
- Revoking (deleting) a shortcode scoped to a specific user + shortcode ID pair.
- Updating the embed properties of an existing shortcode (scoped to owner).
- Bulk-deleting all shortcodes belonging to a user (called during user account deletion).
- Fetching all shortcodes across all users for admin purposes, optionally filtered by creator email.
- Publishing real-time PubSub events (created, updated, revoked) on the per-user channel after mutations.
- Registering itself with UserService as a UserDataHandler to participate in the user deletion flow.

## Out of Scope

- Authentication and authorization — enforced at the resolver layer via guards; the service trusts the `uid` it receives.
- GraphQL schema definition — handled by the resolver and model files.
- Rate limiting — enforced at the resolver layer via GqlThrottlerGuard.
- Shortcode resolution to a URL or redirect — not implemented here; the service only stores and retrieves the encoded request data.
- Shortcode expiry or TTL — no expiration logic is present.

---

### interface.md

## Public Methods

### `getShortCode(shortcode: string): Promise<Either<SHORTCODE_NOT_FOUND, Shortcode>>`

Fetches a single shortcode record by its ID.

- **Parameters:** `shortcode` — the 12-character shortcode ID string.
- **Returns:** `E.right(Shortcode)` on success; `E.left(SHORTCODE_NOT_FOUND)` if no record exists.
- **Auth scope:** None — called by resolver without authentication guard.
- **DB operation:** `prisma.shortcode.findFirstOrThrow` with `where: { id: shortcode }`.

---

### `createShortcode(request: string, properties: string | null, userInfo: AuthUser): Promise<Either<Error, Shortcode>>`

Creates a new shortcode, generating a unique collision-safe ID.

- **Parameters:**
  - `request` — JSON string of the HTTP request to encode. Must be valid JSON and non-empty.
  - `properties` — JSON string of embed display properties, or `null` if none.
  - `userInfo` — the authenticated user creating the shortcode.
- **Returns:** `E.right(Shortcode)` on success.
- **Failure modes:**
  - `E.left(SHORTCODE_INVALID_REQUEST_JSON)` — `request` is not valid JSON or is falsy.
  - `E.left(SHORTCODE_INVALID_PROPERTIES_JSON)` — `properties` is not valid JSON (only when non-null).
- **Side effects:** Publishes `shortcode/<creatorUid>/created` event via PubSub if `creatorUid` is non-null.
- **Note:** `properties` defaults to `null`; the resolver passes it as nullable.

---

### `fetchUserShortCodes(uid: string, args: PaginationArgs): Promise<Shortcode[]>`

Returns a paginated list of shortcodes created by the specified user, ordered by `createdOn` descending.

- **Parameters:**
  - `uid` — the user's UID.
  - `args` — `{ cursor?: string; take: number }` pagination arguments.
- **Returns:** Array of `Shortcode` objects (empty array if none found). Never throws or returns Either.
- **Pagination:** Cursor-based; skips 1 record when cursor is provided to avoid re-returning the cursor item.

---

### `revokeShortCode(shortcode: string, uid: string): Promise<Either<SHORTCODE_NOT_FOUND, true>>`

Deletes a shortcode that belongs to the specified user.

- **Parameters:**
  - `shortcode` — the shortcode ID to delete.
  - `uid` — the UID of the owner; deletion is scoped to the composite unique key `(creatorUid, id)`.
- **Returns:** `E.right(true)` on success.
- **Failure modes:** `E.left(SHORTCODE_NOT_FOUND)` if no matching record for the user+shortcode pair.
- **Side effects:** Publishes `shortcode/<creatorUid>/revoked` event via PubSub unconditionally after deletion.

---

### `deleteUserShortCodes(uid: string): Promise<number>`

Bulk-deletes all shortcodes belonging to a user. Called by the user deletion lifecycle handler.

- **Parameters:** `uid` — the user's UID.
- **Returns:** Count of deleted records (number). Never throws.
- **Note:** Does not publish PubSub events per deleted shortcode. This is a silent bulk operation.

---

### `deleteShortcode(shortcodeID: string): Promise<Either<SHORTCODE_NOT_FOUND, true>>`

Deletes a shortcode by ID without ownership scope (admin-level deletion).

- **Parameters:** `shortcodeID` — the shortcode ID.
- **Returns:** `E.right(true)` on success.
- **Failure modes:** `E.left(SHORTCODE_NOT_FOUND)` if record does not exist.
- **Note:** No PubSub event is published. rationale: unknown — inferred from code, not confirmed by developer.

---

### `updateEmbedProperties(shortcodeID: string, uid: string, updatedProps: string): Promise<Either<Error, Shortcode>>`

Updates the `embedProperties` field of a shortcode owned by the specified user.

- **Parameters:**
  - `shortcodeID` — the shortcode ID to update.
  - `uid` — the UID of the owner.
  - `updatedProps` — JSON string of the new embed properties. Must be non-empty and valid JSON.
- **Returns:** `E.right(Shortcode)` on success.
- **Failure modes:**
  - `E.left(SHORTCODE_PROPERTIES_NOT_FOUND)` — `updatedProps` is falsy (empty/null/undefined).
  - `E.left(SHORTCODE_INVALID_PROPERTIES_JSON)` — `updatedProps` is not valid JSON or parses to a falsy value.
  - `E.left(SHORTCODE_NOT_FOUND)` — no matching record for user+shortcode pair.
- **Side effects:** Publishes `shortcode/<creatorUid>/updated` event via PubSub on success.

---

### `fetchAllShortcodes(args: PaginationArgs, userEmail: string | null): Promise<ShortcodeWithUserEmail[]>`

Admin-level method to fetch all shortcodes across all users, with optional filtering by creator email (case-insensitive).

- **Parameters:**
  - `args` — pagination arguments.
  - `userEmail` — if provided, restricts results to shortcodes whose creator's email matches (case-insensitive). Defaults to `null` (no filter).
- **Returns:** Array of `ShortcodeWithUserEmail` objects, including `creator` (uid + email) or `null` if no creator.
- **Never throws or returns Either.**

---

### UserDataHandler Interface (implemented)

#### `canAllowUserDeletion(user: AuthUser): TaskOption<string>`

Always returns `TO.none` — shortcode ownership never blocks user account deletion.

#### `onUserDelete(user: AuthUser): Task<void>`

Calls `deleteUserShortCodes(user.uid)` to clean up all shortcodes before user deletion completes.

---

## PubSub Event Channels

| Channel pattern                    | Triggered by            | Payload    |
|------------------------------------|-------------------------|------------|
| `shortcode/<uid>/created`          | `createShortcode`       | `Shortcode` |
| `shortcode/<uid>/updated`          | `updateEmbedProperties` | `Shortcode` |
| `shortcode/<uid>/revoked`          | `revokeShortCode`       | `Shortcode` |

---

## Data Structures

### `Shortcode` (GQL ObjectType)
```
id: string          — 12-char alphanumeric shortcode ID
request: string     — JSON string of the HTTP request payload
properties: string  — JSON string of embed properties (nullable)
createdOn: Date     — creation timestamp
```

### `ShortcodeWithUserEmail` (GQL ObjectType, admin view)
```
id, request, properties, createdOn  — same as Shortcode
creator: { uid: string, email: string } | null
```

### `PaginationArgs`
```
cursor?: string   — ID of last seen item (cursor-based pagination)
take: number      — number of records to return
```

---

### internals.md

## Logic

### ID Generation

Shortcode IDs are 12 characters drawn from the character set `[a-zA-Z0-9]` (62 characters), producing `62^12 ≈ 3.2 × 10^21` possible values.

Generation uses a `while (true)` retry loop (`generateUniqueShortCodeID`):
1. Generate a random 12-char string (`generateShortCodeID`) using `Math.random()`.
2. Call `getShortCode` to check for collision in the DB.
3. If `getShortCode` returns `E.left` (not found), the code is unique — return it.
4. If `E.right` (exists), loop and retry.

**Observation:** This uses `Math.random()` (non-cryptographic). rationale: unknown — inferred from code, not confirmed by developer.

**Observation:** The retry loop has no maximum attempt count or timeout guard. With the current ID space size, collision probability is astronomically low in practice, but the loop is theoretically unbounded. rationale: unknown — inferred from code, not confirmed by developer.

### JSON Validation Pattern

Both `request` and `properties` are stored as Prisma JSON columns. Before persistence:
- The string is parsed via `stringToJson` (fp-ts utility returning `Either<Error, unknown>`).
- `request` additionally checks that `requestData.right` is truthy (non-empty object).
- `properties` allows a `null` input (optional field); if non-null, it must parse to valid JSON.
- On `updateEmbedProperties`, `updatedProps` additionally checks for `parsedProperties.right` being truthy (disallows JSON `null` as a value).

### Ownership Scoping

Mutations that operate on user-owned shortcodes (`revokeShortCode`, `updateEmbedProperties`) use Prisma's composite unique key `creator_uid_shortcode_unique: { creatorUid, id }`. This means a user can only mutate their own shortcodes — the DB constraint enforces ownership without an explicit pre-fetch authorization check.

### PubSub Event Publishing

- `createShortcode`: publishes only when `createdShortCode.creatorUid` is non-null. This guards against anonymous or system-created shortcodes that have no user channel.
- `revokeShortCode`: publishes unconditionally after deletion (the `creatorUid` comes from the deleted record, which must have existed).
- `updateEmbedProperties`: publishes on success using `updatedShortcode.creatorUid` from the returned Prisma record.
- `deleteShortcode` (admin delete): does NOT publish a PubSub event. rationale: unknown — inferred from code, not confirmed by developer.
- `deleteUserShortCodes` (bulk): does NOT publish per-shortcode events. rationale: unknown — inferred from code, not confirmed by developer.

### User Deletion Lifecycle

`ShortcodeService` implements `UserDataHandler` and registers itself with `UserService.registerUserDataHandler` during `onModuleInit`. When a user deletion is triggered:
1. `canAllowUserDeletion` always returns `TO.none` — shortcodes never block deletion.
2. `onUserDelete` calls `deleteUserShortCodes(uid)`, which does a bulk `deleteMany`.

The `deleteMany` on user deletion does not emit per-shortcode PubSub events. This is consistent with the silent bulk operation design, but means active subscribers on `shortcode/<uid>/revoked` will not receive notifications for each deleted shortcode during account deletion.

### Type Mapping (DB to GQL)

The private `cast` method maps a Prisma `Shortcode` DB record to the GQL `Shortcode` model:
- `request` field: stored as Prisma JSON, re-serialized to string via `JSON.stringify`.
- `embedProperties` → `properties`: re-serialized to string, or `null` if the DB column is null.
- `id` and `createdOn` pass through unchanged.

For `fetchAllShortcodes`, the mapping is done inline (not via `cast`) to include the joined `User` relation and produce `ShortcodeWithUserEmail`.

## Constraints

- Shortcode IDs are always exactly 12 characters from `[a-zA-Z0-9]`.
- A shortcode's `request` field must be valid, non-empty JSON at creation time.
- `properties` is optional at creation; when provided, must be valid JSON. It cannot be set to JSON `null` on update.
- Ownership mutations are always scoped to the composite key `(creatorUid, id)` — no shortcode can be mutated on behalf of another user at the service level.
- The service does not enforce rate limits — this is the resolver's responsibility.

## Decisions

### fp-ts Either for error returns
The service returns `Either<ErrorCode, T>` from all methods that can fail, rather than throwing exceptions. The resolver layer unwraps with `throwErr` to convert to GraphQL errors.
- Chose fp-ts Either over throwing exceptions because: rationale: unknown — inferred from code, not confirmed by developer. Observed that the entire backend follows this functional-style error handling pattern.
- Rejected: raw try/catch + throw in service methods — not done here.

### Shortcode ID uniqueness via DB lookup loop vs. DB unique constraint retry
The service pre-checks uniqueness with a `getShortCode` lookup before inserting, rather than relying on a DB unique constraint violation and retrying.
- Rationale: unknown — inferred from code, not confirmed by developer.
- Note: This introduces a TOCTOU (time-of-check / time-of-use) race condition; two concurrent creation requests could both check the same generated ID as free, then both attempt to insert. The DB unique constraint on `id` would catch this at the DB level and throw an unhandled Prisma error. This edge case is not handled in the current code.

### Admin delete (`deleteShortcode`) does not publish PubSub
Unlike user-initiated `revokeShortCode`, the admin deletion path does not emit a `revoked` event.
- Rationale: unknown — inferred from code, not confirmed by developer.

### Bulk user-delete does not emit per-shortcode PubSub events
`deleteUserShortCodes` uses `deleteMany` and returns only a count.
- Rationale: unknown — inferred from code, not confirmed by developer. Likely a performance/simplicity choice — emitting N events for N shortcodes during account deletion would be expensive.
- Rejected alternative (not implemented): fetch all shortcodes, delete one by one, publish each event.
