# Tools

## What this document is

The [Foundation](foundation) document defines the problem and invariants. The [Graph](graph) document defines the
structure of semantic memory. The [Engine](engine) document defines deterministic mechanics.
The [Integration](integration) document defines the behavioral contract with agents. The [Materialization](materialization)
document defines how context becomes output.

This document defines **formal contracts** — graph file schemas and tool operation
specifications.

Everything described here is implementable literally. Schemas define what files exist and
what they contain. Operations define what parameters they take, what they do, and what they
return. Two sides of the same system: schemas are data, operations are functions on that data.

## File schemas

### yg-config.yaml

The configuration file in the graph root directory. The single source of truth for what
tools expect and enforce.

```yaml
name: my-project # string, required

node_types: # object, required, non-empty — keys are type names
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors — invisible in call graphs but affect blast radius"
    # required_aspects: [requires-audit]  # optional — aspects every node of this type must have

quality: # map, optional (has default values) — all keys snake_case
  min_artifact_length: 50 # int, default 50
  max_direct_relations: 10 # int, default 10
  context_budget:
    warning: 10000 # int, default 10000 (tokens)
    error: 20000 # int, default 20000 (tokens)
    own_warning: 5000 # int, optional (tokens) — warn when own artifacts alone exceed this
```

Artifacts (`responsibility.md`, `interface.md`, `internals.md`) are built into the
CLI and are not configurable. See the [Graph](graph) document for artifact descriptions
and required conditions.

**Validation rules for yg-config.yaml:**

- `name` must be non-empty.
- `node_types` must be a non-empty object. Each entry must have a `description` string. Optional `required_aspects` list. Node `type` must match a key in `node_types`.
- `quality.context_budget.error` must be >= `quality.context_budget.warning`.

### yg-node.yaml

Node identity and all its outgoing connections.

```yaml
name: OrderService                          # string, required
type: service                               # string, required — from architecture.node_types
description: "Manages order lifecycle"      # string, optional — short summary for context maps

aspects: [requires-audit, error-format]     # optional — own extras beyond inherited

integration_aspects: [correlation-tracking] # optional — required on consumers

relations:                                  # optional
  - target: payments/payment-service        # string, required — path relative to model/
    type: calls                             # string, required — relation type (see table)
    consumes: [charge, refund]              # list of strings, optional
    failure: "retry 3x, then payment-failed" # string, optional

mapping:                                    # optional — groups with aspect proofs
  - paths:
      - src/routes/orders.ts
    aspects:
      - aspect: requires-audit
        anchors:
          audit-log:
            regex: "createAuditLog"
            rationale: "Audit events logged on order creation, state changes."
      - aspect: error-format
        anchors:
          error-handler:
            regex: "formatError"
            rationale: "Uses shared error formatter in route handler."

  - paths:
      - src/services/orders.ts
    aspects:
      - aspect: requires-audit
        anchors:
          audit-context:
            regex: "auditCtx"
            rationale: "Receives audit context from route caller."
      - aspect: error-format
        anchors:
          error-throw:
            regex: "AppError"
            rationale: "Throws typed errors caught by route handler."
```

**Relation types:**

| Type         | Class      | Acyclicity | Meaning                                   |
| ------------ | ---------- | ---------- | ----------------------------------------- |
| `uses`       | structural | required   | Uses functionality provided by the target |
| `calls`      | structural | required   | Calls the target's interface              |
| `extends`    | structural | required   | Extends the target                        |
| `implements` | structural | required   | Implements the target's contract          |
| `emits`      | event      | no         | Produces an event                         |
| `listens`    | event      | no         | Reacts to an event                        |

**Mapping groups:**

Each mapping entry is a group — a set of file paths sharing the same aspect proof profile.
Different groups can prove the same aspect using different implementations. Every file in
a group must match every anchor regex in that group.

- `paths` — list of files and/or directories (relative to project root). Directories are
  expanded recursively at check time, respecting `.gitignore`.
- `aspects` — list of aspects this group proves. Required unless the node has zero effective aspects.
- `aspect` — aspect identifier from `aspects/`.
- `anchors` — map from anchor ID to proof object. Every anchor ID defined in the aspect's
  `yg-aspect.yaml` must be realized in the group.
- `regex` — pattern to match in source files. Must match in every file in the group.
- `rationale` — why this pattern proves the aspect (max 2 sentences).

**Aspect inheritance:**

Aspects on a node come from multiple sources:

- Architecture (`node_types.<type>.aspects`) — required on every file of this type
- Parent node — children inherit parent's effective aspects
- Flow aspects — flow participants inherit flow-level aspects
- Own declarations — extra aspects declared on the node
- Aspect implies — recursive expansion

**Validation rules for yg-node.yaml:**

- `name` must be non-empty.
- `type` must be a key in `architecture.node_types`.
- Each aspect identifier must correspond to a directory under `aspects/` (E050 if missing).
- Each port aspect identifier must correspond to a directory under `aspects/` (E050 if missing).
- Each `relations[].target` must resolve to an existing node.
- Each `relations[].type` must be from the table above.
- Paths in `mapping` must be relative to the repository root. Can be files or directories.
- Mappings cannot overlap with mappings of other nodes.
- When a relation has a `consumes` field, all referenced port aspects must be defined in `aspects/` (E053).

### yg-aspect.yaml

Aspect metadata — a cross-cutting requirement. The aspect identifier is the relative directory
path under `aspects/` (e.g. `aspects/requires-audit/` has identifier `requires-audit`;
`aspects/observability/logging/` has identifier `observability/logging`).

```yaml
name: Audit logging # string, required
description: "Short description for discovery" # string, optional
implies: [requires-logging] # list of strings, optional — ids of other aspects
anchors: # list of strings, required — abstract anchor IDs that nodes must realize
  - audit-entry
  - audit-actor
  - audit-timestamp
```

Nested directories under `aspects/` are organizational groupings. There is no automatic
parent-child relationship from nesting — `implies` is always explicit.

All files in the aspect directory except `yg-aspect.yaml` are content attached to the context
packages of nodes carrying the specified aspect. When `implies` is present, the aspect's content
plus all implied aspects' content is attached. Tools resolve implications recursively and detect cycles.

**Anchors:**

Every aspect must define at least one claim in the `anchors` field (E039 if empty or missing).
Anchor IDs are abstract names — they describe WHAT must be proven (e.g. "audit-entry",
"audit-actor"), not HOW.

**Validation rules:**

- `name` must be non-empty.
- Every identifier in `implies` must have a corresponding aspect directory under `aspects/`.
- The aspect implies graph must be acyclic (no A implies B implies A).
- `anchors` must be a non-empty list of claim objects (`id` + `claim`).

### yg-flow.yaml

End-to-end flow metadata.

```yaml
name: Checkout flow # string, required
description: "End-to-end purchase flow from cart to payment confirmation" # string, optional — short summary for context maps
nodes: # list of strings, required, non-empty (alias: participants)
  - orders/order-service # path relative to model/
  - payments/payment-service
aspects: # list of strings, optional — aspect ids propagated to all participants
  - requires-saga
  - requires-idempotency
```

All files in the flow directory except `yg-flow.yaml` are content attached to the context
packages of the listed nodes and their descendants (flows propagate down the hierarchy).
Aspects declared in `aspects` propagate to all participants.

**Validation rules:**

- `name` must be non-empty.
- `nodes` must be non-empty.
- Each element in `nodes[]` must resolve to an existing node.
- Each aspect identifier in `aspects[]` (if present) must correspond to an aspect directory under `aspects/`.

### description.md

Primary flow content artifact — describes the business process. Required for every flow.

**Required sections (H2):**

- `## Business context` — why this process exists
- `## Trigger` — what initiates the process
- `## Goal` — what success looks like
- `## Participants` — nodes involved (align with `yg-flow.yaml` nodes)
- `## Paths` — must contain at least `### Happy path`; each additional business path (exception, cancellation, timeout) gets `### [name]`
- `## Invariants across all paths` — business rules and technical conditions holding across all paths

Note: section validation is not yet enforced by `yg check`.

One flow directory = one business process with all its paths (happy path, exceptions, cancellations).

### schemas/

The `schemas/` directory contains schema files — one per graph layer. Initialization copies
`yg-node.yaml`, `yg-aspect.yaml`, and `yg-flow.yaml` from the CLI package. Each file
shows the expected YAML structure for its element type. The agent reads the schema before
creating or editing that element (see the [Graph](graph) document, Schemas section).

| File              | Element type | Describes structure of                    |
| ----------------- | ------------ | ----------------------------------------- |
| `yg-node.yaml`   | Nodes        | `yg-node.yaml` in model directories        |
| `yg-aspect.yaml` | Aspects      | `yg-aspect.yaml` in aspects directories    |
| `yg-flow.yaml`   | Flows        | `yg-flow.yaml` in flows directories        |

### .drift-state/

Synchronization state between the graph and all tracked files (source and graph artifacts).
Managed exclusively by tools — agents and humans do not edit it. Stored as a directory of
per-node JSON files at `.yggdrasil/.drift-state/`.

Committed to the repository (shared in the team, usable in CI pipelines).

Each node gets its own file at `.drift-state/<node-path>.json`. For example, a node at
`model/cli/commands/aspects/` stores its drift state at
`.drift-state/cli/commands/aspects.json`.

```json
{
  "hash": "a1b2c3d4e5f6...",
  "files": {
    "src/modules/orders/order.service.ts": "1111...",
    "src/modules/orders/order.repository.ts": "2222...",
    ".yggdrasil/model/orders/order-service/yg-node.yaml": "3333...",
    ".yggdrasil/model/orders/order-service/responsibility.md": "4444...",
    ".yggdrasil/aspects/requires-audit/yg-aspect.yaml": "5555..."
  },
  "mtimes": {
    "src/modules/orders/order.service.ts": 1709731200000,
    "src/modules/orders/order.repository.ts": 1709731200000
  }
}
```

**Format per file:** a JSON object with:

- `hash` (required) — canonical SHA-256 hash of all tracked files (source + graph).
- `files` (required) — map `file_path -> file_hash` for all tracked files. Includes both
  source paths (from `mapping.paths`) and `.yggdrasil/` graph paths (node artifacts,
  ancestor artifacts, aspect files, flow files, relation target artifacts — mirroring the
  context assembly traversal). Enables drift detection to report exactly which files changed
  and whether they are source or graph files.
- `mtimes` (optional) — map `file_path -> timestamp` for mtime-based optimization. When
  present, drift detection can skip re-hashing files whose mtime has not changed.

The `files` map always contains every tracked file for the node. Source files come from the
node's mapping. Graph files come from the `collectTrackedFiles` algorithm, which mirrors
the six layers of tracked file collection (own, hierarchical, aspects, relational dependencies,
relational flows, source). See the [Engine](engine) document for details.

Each path in `mapping.paths` is checked at runtime — if it is a file, it is hashed directly
(SHA-256 of file content); if it is a directory, it is scanned recursively (respecting
`.gitignore`), each file is hashed, and a canonical hash is computed from sorted path:hash
pairs. The overall canonical `hash` combines all tracked file hashes (source + graph) into a
single value.

**Legacy migration:** If a single `.drift-state` file (the previous format) is found instead
of the `.drift-state/` directory, it is migrated automatically on first read — each node
entry is written to its own JSON file under `.drift-state/`.

**Garbage collection:** When `yg approve` runs, orphaned drift state files (files
under `.drift-state/` that no longer correspond to a mapped node) are removed.

---

## Operations

Each operation is described by its purpose, parameters, step-by-step behavior, result, and
error conditions. Operations do not modify semantic content in the graph — they only create, read,
or modify operational metadata (`.yggdrasil/.drift-state/`). The only exception is
initialization, which creates the starting structure.

### Naming convention

Operations are invoked as tool commands with the `yg` prefix:

```text
yg init --platform cursor
yg init --platform cursor --upgrade   # refreshes rules when .yggdrasil/ exists
yg context --node orders/order-service       # structural overview
yg context --file src/modules/orders/order.service.ts  # resolves owner + full details
yg select --task "add payment retry logic"   # find relevant nodes for a task
yg tree
yg aspects
yg flows
yg check
yg owner --file src/modules/orders/order.service.ts          # quick ownership check
yg impact --node payments/payment-service
yg impact --file src/modules/payments/payment.service.ts     # resolves owner + impact
yg approve --node orders/order-service
```

Command names correspond to the section headers below. Parameters passed via flags
(`--node`, `--file`, etc.) or positionally are an implementation decision,
not a specification. The examples above illustrate intent, not syntax.

---

### Init

Creates the `.yggdrasil/` structure with default configuration and agent platform integration.
Full initialization — once per repository.
Upgrade mode — refreshes only the rules file (when `.yggdrasil/` already exists).

**Parameters:**

| Parameter  | Type   | Required | Description                                                                                                                                           |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform` | string | No       | Agent platform: `cursor`, `claude-code`, `copilot`, `cline`, `roocode`, `codex`, `windsurf`, `aider`, `gemini`, `amp`, `generic`. Default: `generic`. |
| `upgrade`  | bool   | No       | If `true` and `.yggdrasil/` exists — overwrite only the rules file. Do not modify config or graph. Use after CLI update.                              |

**Behavior:**

1. Check if `.yggdrasil/` exists. If it exists and `upgrade` is `false` — error. If it exists and `upgrade` is `true` — go to step 5.
2. Create directory structure:

   ```text
   .yggdrasil/
   ├── yg-config.yaml
   ├── yg-architecture.yaml
   ├── .gitignore
   ├── model/
   ├── aspects/
   ├── flows/
   └── schemas/
   ```

3. Write `yg-config.yaml` with default content (see Default configuration below).
4. Write `yg-architecture.yaml` with default node types (see Architecture file below).
5. Write `.yggdrasil/.gitignore` (with entries for local operational files).
6. Run migrations (upgrade mode only):

   a. Read `version` from `yg-config.yaml`. If absent, treat as `1.0.0`.

   b. If project version equals CLI version — skip migrations, proceed to step 7.

   c. If project version is newer than CLI version — print a warning and exit without
      modifying any files.

   d. For each applicable migration (project version < migration version <= CLI version),
      run in order. Each action prints with a checkmark prefix on success or a warning prefix on
      warning/skip.

   e. After all migrations complete, write the updated `version` to `yg-config.yaml`.

7. Generate the platform rules file in the location appropriate for the `platform` parameter
   (see Platform rules file section).

**Result:**

- Full initialization: list of created files and directories.
- Upgrade mode: path of the refreshed rules file and list of migration actions applied.

**Errors:**

- `.yggdrasil/` already exists and `upgrade` was not provided — full init is a one-time operation.
- Project version is newer than CLI version — user must upgrade the CLI before running `--upgrade`.

**Default configuration:**

`yg-config.yaml`:

```yaml
name: ""

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
    # own_warning: 5000  # optional — warn when own artifacts alone exceed this
```

`yg-architecture.yaml`:

```yaml
node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors — invisible in call graphs but affect blast radius"
```

The tool auto-detects the project name from `package.json` (if present) or the
directory name. The agent can override by editing `yg-config.yaml`. Node types
are defined in `yg-architecture.yaml` and can be customized with architectural
constraints (`aspects`, `integration_aspects`, `parents`, `relations`).

---

### Context

Assemble a context package for the specified node. The main operation of the system.
Alias: `build-context`.

Two levels of context are available: `--node` for a structural overview (node metadata,
hierarchy, dependency map) and `--file` for full file-level details (resolves owner,
includes artifact content). Both produce structured text output.

**Parameters:**

| Parameter | Type   | Required            | Description                                                        |
| --------- | ------ | ------------------- | ------------------------------------------------------------------ |
| `file`    | string | One of two required | File path — resolves owner node, then assembles full details       |
| `node`    | string | One of two required | Node path relative to `model/` — assembles structural overview     |

Exactly one of `file` or `node` must be provided.

**Behavior:**

The 5-step algorithm defined in the [Engine](engine) document. Summary:

1. **Global** — `yg-config.yaml` (project name).
2. **Hierarchical** — ancestor artifacts (from `model/` root down to the node's parent).
3. **Own** — the node's `yg-node.yaml` (raw) and content artifacts.
4. **Aspects** — union of aspect identifiers from hierarchy blocks, own block, and flow blocks (each block
   declares its own; no inheritance). Expand implies recursively. Render content of each
   matching aspect. No source attribute on aspect output.
5. **Relational** — for structural relations: artifacts with `included_in_relations: true`
   (default: responsibility, interface) of the target with consumes
   and failure annotations. If the target has no artifacts with `included_in_relations: true`,
   all configured artifacts are included as fallback. For each dependency, ancestors of the
   target node are included (dependency hierarchy) to provide domain context. For event
   relations: event name and type with consumes annotation. Flow artifacts for flows listing
   this node or any ancestor as a participant.

Token estimation: ~4 characters per token (heuristic from the [Engine](engine) document).

**Result:**

Structured text output with the context package. The two modes differ in detail level:

- `--node` — structural overview: node metadata, hierarchy, dependency map with artifact
  paths listed but not inlined. Suitable for orientation and navigation.
- `--file` — full details: resolves the owner node, then assembles the complete context
  package with artifact content. Suitable for implementation work on the file.

Both modes include:

- `glossary` — definitions of all aspects and flows referenced in this context, each with
  name, description, and `files` listing their artifact paths.
- `node` — target node metadata with inline `files` listing its own artifact paths.
- `hierarchy` — ancestor modules from root to parent, each with inline `files`.
- `dependencies` — structural dependencies with inline `files` and their own `hierarchy` chains.
- `meta` — at the bottom: token count, budget status (`ok`, `warning`, `severe`), and a
  `breakdown` with per-category token counts (own, hierarchy, aspects, flows, dependencies).

All artifact file paths are relative to `.yggdrasil/`.

**Errors:**

- Node does not exist at the provided path.
- The graph has any validation errors. Assembly requires a consistent graph — the tool
  reports errors and refuses to assemble.

---

### Tree view

Displays the graph structure as a tree with node metadata.

**Parameters:**

| Parameter | Type   | Required | Description                                                 |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `root`    | string | No       | Root path (relative to `model/`). Default: entire `model/`. |
| `depth`   | int    | No       | Maximum depth. Default: unlimited.                          |

**Behavior:**

1. Traverse the directory tree from the root.
2. For each directory with a `yg-node.yaml` — read metadata.
3. Build a tree representation.

**Result:**

```text
model/
├── auth/ [module] -> 0 relations
│   ├── login-service/ [service] aspects:requires-auth -> 1 relations
│   └── token-service/ [service] -> 0 relations
├── orders/ [module] -> 0 relations
│   └── order-service/ [service] aspects:requires-audit,requires-auth -> 2 relations
└── payments/ [module] ■ blackbox -> 0 relations
    └── payment-service/ [service] ■ blackbox -> 0 relations
```

Format: path, type in brackets, aspects (if any), blackbox flag (if true), number of outgoing relations.

**Errors:**

- The provided root does not exist.

---

### Aspects

Lists aspects with metadata in YAML format. Use to discover valid aspect identifiers for
`yg-node.yaml` and `yg-flow.yaml`.

**Parameters:** none.

**Behavior:**

1. Resolve `.yggdrasil/` root (repository root or nearest parent).
2. Load the graph — find all aspect directories under `.yggdrasil/aspects/` (including nested).
3. For each aspect, compute usage stats: count of nodes carrying the aspect (directly or
   via inheritance/flows/implies), and count of claims (anchors) defined.
4. Detect orphaned aspects — aspects not referenced by any node, architecture type, or flow.
5. Sort by aspect identifier.
6. Output YAML with `id`, `name`, `description` (if present), `implies` (if present),
   `anchors`, `claims` (count), `nodes` (usage count), and `orphan` flag (if true).

**Result:**

```yaml
- id: deterministic
  name: Determinism
  claims: 1
  nodes: 4
  anchors:
    - deterministic-output
- id: observability/logging
  name: Audit Logging
  description: Every state-changing operation must produce an audit log entry
  claims: 3
  nodes: 7
  implies:
    - observability/tracing
  anchors:
    - audit-entry
    - audit-actor
- id: legacy-format
  name: Legacy Format
  claims: 1
  nodes: 0
  orphan: true
  anchors:
    - legacy-output
```

Orphan detection surfaces aspects that are defined but unused (same condition as W006).
The `nodes` count and `orphan` flag help agents identify aspects that may need cleanup
or broader adoption.

**Errors:**

- No `.yggdrasil/` directory — exit 1.
- If no `aspects/` directory exists, outputs an empty list.

---

### Flows

Lists flows with metadata in YAML format. Use to discover defined business processes,
their participants, and associated aspects. Enriched with participant count and flow
aspects for quick overview.

**Parameters:** none.

**Behavior:**

1. Resolve `.yggdrasil/` root (repository root or nearest parent).
2. Load the graph — find all flow directories under `.yggdrasil/flows/`.
3. For each flow, compute participant count from the `nodes` list.
4. Sort by flow name.
5. Output YAML with `name`, `participants` (count), `nodes` (participant list),
   `description` (if present), `aspects` (if present).

**Result:**

```yaml
- name: Checkout Flow
  participants: 2
  nodes:
    - orders/order-service
    - auth/auth-api
  description: "End-to-end purchase flow from cart to confirmation"
  aspects:
    - requires-audit
- name: Onboarding Flow
  participants: 3
  nodes:
    - users/user-service
    - auth/auth-api
    - notifications/email-service
  description: "New user registration and welcome sequence"
```

The `participants` count provides a quick signal of flow complexity without requiring
the agent to count the `nodes` list.

**Errors:**

- No `.yggdrasil/` directory — exit 1.
- If no `flows/` directory exists, outputs an empty list.

---

### Node selection

Finds graph nodes relevant to a natural-language task description.

**Parameters:**

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `task`        | string | Yes      | Natural-language task description               |
| `limit`       | number | No       | Maximum nodes to return. Default: `5`.          |

**Behavior:**

1. Tokenize the task description: lowercase, split on non-alphanumeric, remove stop words.
2. **S1 (keyword matching):** For each node, score keyword hits against artifact content with
   weights: `responsibility.md` x3, `interface.md` x2, aspect content x2, other artifacts x1.
3. If any node scores above 0: sort by score descending, return top-K.
4. **S2 (flow-based fallback):** If no node matched via S1, match tokens against flow
   descriptions and names. Return participants of matching flows.

**Result:**

YAML list of `{ node, score, name }` sorted by relevance. Empty list when nothing matches.

```yaml
- node: orders/order-service
  score: 12
  name: OrderService
- node: orders
  score: 6
  name: Orders
```

**Errors:**

- No `.yggdrasil/` — repository is not initialized.
- Empty `--task` — missing required option.

---

### Ownership resolution

Finds the owner node for a given file path.

**Parameters:**

| Parameter | Type   | Required | Description                               |
| --------- | ------ | -------- | ----------------------------------------- |
| `file`    | string | Yes      | File path relative to the repository root |

**Behavior:**

1. Traverse all nodes with a mapping.
2. For each mapping, check if the file matches any entry in `mapping.paths` — either the
   path equals a file entry, or the file lies inside a directory entry.
3. Return the first matching node (uniqueness is guaranteed by validation — mapping overlaps
   are errors).

**Result:**

Owner node path or information about missing coverage.

```text
src/modules/orders/order.service.ts -> orders/order-service
```

When the file has no direct mapping but lies inside a mapped directory, the output includes an
additional line explaining that context comes from the nearest ancestor directory and suggests
how to obtain it:

```text
src/modules/orders/subdir/helper.ts -> orders/order-service
  File has no direct mapping; context comes from ancestor directory src/modules/orders. Use: yg context --node orders/order-service
```

```text
src/utils/helpers.ts -> no graph coverage
```

**Uncovered file (no owner):** The tool returns "no graph coverage". For the agent: STOP. First determine whether the area is **greenfield**, **partially mapped**, or **existing code**.

- **If GREENFIELD** (empty directory, new project): Do NOT offer blackbox. Create proper nodes (reverse engineering or upfront design) before implementing. Blackbox is forbidden for new code.
- **If PARTIALLY MAPPED** (file unmapped but lives inside a mapped module): Stop and ask the user if this file should be added to the existing node or if a new node is required.
- **If EXISTING CODE** (legacy, third-party, shipped-but-unmapped): Present three options and wait for the user to choose:
  - **Option A — Reverse engineering (full coverage):** Create or extend nodes so the file becomes owned. Then continue.
  - **Option B — Blackbox coverage:** Create a blackbox node at user-chosen granularity (often a higher-level directory/module). Ensure the file becomes owned by that blackbox mapping. Then continue.
  - **Option C — Abort/Change plan:** Do not touch the file until coverage is decided.

If the file path does not exist on disk, the output includes a `(file not found)` hint to
distinguish from files that exist but lack graph coverage.

**Errors:**

- None — the operation always returns a result (a node or no coverage).

---

### Impact analysis

Shows the blast radius of changes to a node, aspect, or flow. Supports three
mutually exclusive modes.

**Parameters:**

| Parameter  | Type   | Required              | Description                                                       |
| ---------- | ------ | --------------------- | ----------------------------------------------------------------- |
| `node`     | string | One of four required  | Node path relative to `model/`                                    |
| `file`     | string | One of four required  | File path — resolves owner, then proceeds as `--node`             |
| `aspect`   | string | One of four required  | Aspect id (directory path under `aspects/`)                       |
| `flow`     | string | One of four required  | Flow name (directory name under `flows/`)                         |

Exactly one of `node`, `file`, `aspect`, or `flow` must be provided.

#### Node mode (`--node` or `--file`)

1. Find all nodes whose structural relations point to the target (reverse graph edge).
2. Recursively follow reverse edges (transitive reverse dependencies).
3. Collect descendants of the target node (hierarchy impact).
4. Collect indirect structural dependents of descendants — nodes that depend on descendants via structural or event relations (uses/calls/extends/implements/emits/listens) but are not already shown.
5. Find flows listing the target node.
6. Compute effective aspects (own + hierarchy + flow + implies).
7. Find co-aspect nodes sharing any aspect with the target.
8. Find event-related nodes: nodes with `emits`/`listens` relations targeting the node, and listeners of events the target node emits.

```text
Impact of changes in payments/payment-service:

Directly dependent:
  <- orders/order-service (calls, you consume: charge, refund)
  <- subscriptions/billing-service (calls, you consume: charge)

Transitively dependent:
  <- orders/order-service <- checkout/checkout-controller

Event-dependent:
  <- notifications/email-service (listens: PaymentCompleted)

Descendants (hierarchy impact):
  payments/payment-service/stripe-adapter

Indirectly affected (structural dependents of descendants):
  <- reports/adapter-monitor <- payments/payment-service/stripe-adapter

Flows: checkout
Aspects (scope covers node): requires-saga, requires-idempotency
Nodes sharing aspects:
  orders/order-service (requires-saga, requires-idempotency)

Total scope: 6 nodes, 1 flows, 2 aspects
```

#### Aspect mode (`--aspect`)

1. For every node, compute effective aspects (own + hierarchy + flow + implies).
2. Collect all nodes where the specified aspect is effective (directly affected).
3. Report source of the aspect for each node: own, hierarchy, flow, or implied.
4. Collect indirect structural dependents — nodes that depend on directly affected nodes via structural or event relations (uses/calls/extends/implements/emits/listens) but are not themselves directly affected.
5. List flows propagating this aspect and implies relationships.

```text
Impact of changes in aspect requires-audit:

Directly affected (3):
  orders (own)
  orders/order-service (hierarchy from orders)
  payments/payment-service (flow: checkout)

Indirectly affected (structural dependents):
  <- checkout/checkout-controller <- orders/order-service

Flows propagating this aspect: (none)
Implied by: (none)
Implies: (none)

Total scope: 4 nodes, 0 flows
```

#### Flow mode (`--flow`)

1. List all declared participants.
2. Expand each participant's descendants (hierarchy impact).
3. Collect indirect structural dependents — nodes that depend on participants via structural or event relations (uses/calls/extends/implements/emits/listens) but are not themselves participants.
4. Report flow-level aspects.

```text
Impact of changes in flow Checkout Flow:

Participants:
  auth/auth-api
  orders/order-service
  payments/payment-service

Descendants (hierarchy impact):
  payments/payment-service/stripe-adapter (descendant)

Indirectly affected (structural dependents):
  <- checkout/checkout-controller <- orders/order-service

Flow aspects: requires-saga

Total scope: 5 nodes
```

**Errors:**

- Node / aspect / flow does not exist.
- Multiple modes specified (mutually exclusive).
- No mode specified.

---

### Check

Unified gate — validates structural integrity, drift detection, coverage, and completeness
for the entire graph.

**Parameters:** none. Check is always global scope.

**Behavior:**

1. Load the graph and run all validation passes.
2. Detect drift for all mapped nodes (compare tracked file hashes against baselines).
3. Scan all git-tracked files for coverage (E022).
4. Report all errors and warnings in a single output.

**Errors (block commit):**

**Structural integrity (E001-E013):**

| Code   | Name                       | Description                                                         |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| `E001` | `invalid-node-yaml`        | `yg-node.yaml` fails to parse or lacks required fields              |
| `E002` | `unknown-node-type`        | Node type is not in `config.node_types`                             |
| `E050` | `dangling-aspect-ref`      | Aspect identifier referenced by node, port, architecture type, or flow has no corresponding aspect directory |
| `E004` | `broken-relation`          | Relation target does not resolve to an existing node                |
| `E005` | `broken-flow-ref`          | Flow participant does not resolve                                   |
| `E006` | `broken-aspect-ref`        | Flow aspect does not resolve                                        |
| `E007` | `overlapping-mapping`      | Overlapping mappings between unrelated nodes                        |
| `E008` | `structural-cycle`         | Cycle in structural relations (blackbox cycles tolerated)           |
| `E009` | `invalid-config`           | `yg-config.yaml` fails to parse or is invalid                      |
| `E010` | `duplicate-aspect-binding` | Aspect identifier is bound to multiple aspect directories           |
| `E011` | `missing-node-yaml`        | Directory in `model/` has files but no `yg-node.yaml`              |
| `E012` | `implied-aspect-missing`   | Identifier in aspect's `implies` has no corresponding aspect        |
| `E013` | `aspect-implies-cycle`     | Cycle in aspect implies graph (A implies B implies A)               |

**Drift (E020-E021):**

| Code   | Name              | Description                                                                |
| ------ | ----------------- | -------------------------------------------------------------------------- |
| `E020` | `direct-drift`    | Node's own source or graph files changed since last approve                |
| `E021` | `cascade-drift`   | Node affected by upstream change (dependency/aspect/flow)                  |

**Coverage (E022):**

| Code   | Name              | Description                                                                |
| ------ | ----------------- | -------------------------------------------------------------------------- |
| `E022` | `unmapped-file`   | Git-tracked file not covered by any node (proper or blackbox)              |

E022 aggregates into a single error with a count, guidance text, and a sample of
uncovered files — not one error per file.

When graph coverage is below 50%, E022 includes additional guidance about blackboxing
strategy. This guidance disappears as coverage grows.

In monorepos with multiple `.yggdrasil/` directories, E022 scopes to files under the
nearest parent directory of `.yggdrasil/`, not the entire git repository.

**Completeness (E030-E039):**

| Code   | Name                        | Description                                                                     |
| ------ | --------------------------- | ------------------------------------------------------------------------------- |
| `E030` | `missing-artifact`          | Required artifact missing (blackbox nodes exempt — only `description` required) |
| `E031` | `shallow-artifact`          | Artifact below minimum length (content too shallow to be useful)                |
| `E032` | `budget-exceeded`           | Context package exceeds error threshold — node must be split                    |
| `E033` | `unpaired-event`            | Event relation without complement (broken event contract)                       |
| `E034` | `missing-schema`            | Schema file missing from `schemas/`                                             |
| `E036` | `mapping-path-missing`      | Mapped path does not exist on disk (stale/broken mapping)                       |
| `E038` | `missing-description`       | Node, aspect, or flow has no `description` in YAML                              |
| `E039` | `aspect-missing-claims`     | Aspect has no `anchors` field — every aspect must define at least one claim     |

**Architecture Enforcement (E051-E053):**

| Code   | Name                        | Description                                                               |
| ------ | --------------------------- | ------------------------------------------------------------------------- |
| `E051` | `invalid-relation-target`   | Relation target type not in architecture allowed list                     |
| `E052` | `invalid-parent-type`       | Parent type not in architecture allowed `parents` list                    |
| `E053` | `integration-aspect-missing`| Consumer uses a port whose required aspect is not defined in aspects/     |

**Architecture validation:** E050 (dangling-aspect-ref) fires when any aspect identifier
referenced by a node, port, architecture type definition, or flow has no corresponding
directory in `aspects/`. E051 and E052 validate structural constraints from
`yg-architecture.yaml`: relation target types (E051) and parent types (E052). E053 fires
when a node consumes a port and that port's required aspect is not defined in `aspects/`.

**Semantic (E055-E056) — approve only:**

| Code   | Name                  | Description                                                                       |
| ------ | --------------------- | --------------------------------------------------------------------------------- |
| `E055` | `claim-not-satisfied` | Source file does not satisfy a claim declared in the node's aspect anchors         |
| `E056` | `artifact-stale`      | Node artifact content does not reflect the current state of source files           |

Semantic errors are produced by `yg approve` during its LLM verification gate (see
Approve section). They do not appear in `yg check` output — they are reported only
when approve runs its verification pass. E055 fires when the LLM determines that a
claimed aspect anchor is not actually satisfied by the source code. E056 fires when
the LLM determines that artifact content (responsibility, interface, or internals) is
stale relative to the current source files.

**Port consumption (E057-E058):**

| Code   | Name               | Description                                                                              |
| ------ | ------------------ | ---------------------------------------------------------------------------------------- |
| `E057` | `missing-consumes` | Relation target has ports but the consumer relation has no `consumes` field              |
| `E058` | `unknown-port`     | `consumes` references a port name that does not exist on the target node                 |

**Port consumption validation:** E057 fires when a node has a relation to a target that
exposes named ports but the relation declaration does not include a `consumes` field. This
enforces explicit port selection — callers must declare which ports they use. E058 fires
when `consumes` names a port that does not exist on the target. Both checks are skipped
for `emits` and `listens` event relations, which do not consume ports.

**Blackbox exemption:** Blackbox nodes are exempt from E030 (missing artifact) and
E051-E053 (architecture enforcement).

**Warnings (informational, do not block):**

| Code   | Name                   | Description                                                                  |
| ------ | ---------------------- | ---------------------------------------------------------------------------- |
| `W001` | `budget-warning`       | Context package exceeds warning threshold (getting big)                      |
| `W002` | `own-budget-warning`   | Own artifacts exceed threshold (node might need splitting)                   |
| `W003` | `wide-node`            | Too many source files mapped (node might need splitting)                     |
| `W004` | `high-fan-out`         | Too many direct relations (design signal, not blocking)                      |
| `W005` | `orphaned-drift-state` | Drift state file exists for a node that no longer exists in the graph        |
| `W006` | `orphaned-aspect`      | Aspect is defined but not referenced by any node, architecture type, or flow |

**Message format:**

```text
E004 orders/order-service -> relation to 'payment/svc' does not resolve.
     Existing nodes in payments/: payment-service
     Did you mean 'payments/payment-service'?

E030 orders/order-service -> missing artifact 'interface'.
     Node has 3 incoming relations: auth/login-service, checkout/controller,
     subscriptions/billing-service. Define the public API in interface.md.

W001 orders/order-service -> context: ~15,200 tokens (warning: 10,000)
     own: 3,100 (20%) | hierarchy: 4,800 (32%) | aspects: 4,200 (28%) |
     flows: 1,600 (10%) | dependencies: 1,500 (10%)
```

Messages are **contextual and actionable** — not just "error", but what is wrong,
why, and what to do (see the [Integration](integration) document).

**Result:**

Output is organized with a header (project name, node/aspect/flow counts, coverage
percentage), then errors grouped by category (drift, cascade, structural,
coverage, completeness), then warnings grouped by category (budget, structure).
Summary at the end: PASS or FAIL with category counts.

**Grouping order:** Errors are grouped in this order: Drift (E020), Cascade (E021),
Structural (E001-E013, E050), Coverage (E022), Completeness (E030-E039),
Architecture (E051-E053), Port consumption (E057-E058). Semantic errors (E055-E056) are
reported only by `yg approve`, not by `yg check`. Warnings are grouped:
Budget (W001-W002), Structure (W003-W004), orphaned state (W005), orphaned aspects (W006).

**Warnings hidden when errors exist:** When `yg check` reports any errors, warnings are
suppressed from the output. This keeps the agent focused on blocking issues. Warnings
appear only when the check passes with zero errors.

**LLM provider notice:** When no LLM provider is configured, `yg check` includes an
informational notice that LLM-based verification (used by `yg approve`) is unavailable.
This is not an error — it does not affect the exit code.

**Stable ordering:** Errors within each category are sorted deterministically: first
by cascade cause (grouping related cascades), then alphabetically by node path.

**Cascade tree summary:** When multiple E021 errors share the same upstream cause,
they are grouped into a cascade summary showing the number of upstream changes and
affected nodes.

**Anchor-pass annotation:** Each E021 error is annotated with anchor compliance
status: `(anchors-pass)` if the node's anchor patterns still match source,
`(anchors-fail)` if not. This helps agents prioritize which cascaded nodes need
code changes.

**Category counts:** The Result line includes per-category counts:
`FAIL (1 drift, 2 cascade, 1 completeness — 4 errors, 2 warnings)`

**Suggested next command:** After the Result line, a suggested next command maps the
highest-priority error to an actionable command.

**Exit code:** 0 if no errors (PASS), 1 if any errors found (FAIL).

**Operation errors:**

- `yg-config.yaml` fails to parse (reported as E009, not as an operation error — check
  continues as much as it can).

---

### Approve

Record the current file state as the new baseline after the agent has reviewed and
resolved drift. Alias: `drift-sync`.

**Parameters:**

| Parameter     | Type   | Required | Description                                                       |
| ------------- | ------ | -------- | ----------------------------------------------------------------- |
| `node`        | string | Yes      | Node path relative to `model/`.                                   |
| `acknowledge` | string | No       | Reason for overriding. Bypasses both the three-axis gate and the LLM verification gate. Stored for audit trail. |

Per-node only — no `--all`, no `--recursive`. One node at a time.

**Behavior:**

1. Collect all tracked files for the node via `collectTrackedFiles` — this includes both
   source files (from `mapping.paths`) and graph artifact files (from the context assembly
   traversal: own node, ancestors, aspects, relational dependencies, flows).
2. Perform three-axis change detection:
   - **Own artifacts** (`.md` files in the node directory) — changed since last approve?
   - **Source files** (`mapping.paths`) — changed since last approve?
   - **Other tracked files** (aspects, deps, flows, ancestors) — changed since last approve?
3. Apply enforcement rules (see table below).
4. **LLM verification gate** (when a provider is configured):
   - **Claim verification:** For each aspect anchor claimed by the node, the LLM checks
     whether the source files actually satisfy the claim. Failures produce E055
     (claim-not-satisfied).
   - **Artifact review:** The LLM compares artifact content (responsibility, interface,
     internals) against current source files to detect staleness. Failures produce E056
     (artifact-stale).
   - **Caching:** Verification results are cached per file hash. Unchanged files skip
     re-verification on subsequent approvals.
   - If E055 or E056 errors are found, approve refuses.
   - When no LLM provider is configured, approve prints a notice and skips the
     verification gate (the three-axis gate still applies).
5. If accepted: compute hashes for all tracked files and write to
   `.yggdrasil/.drift-state/<node-path>.json`.
6. Garbage collection: remove orphaned drift state files for nodes that no longer exist.

**Three-axis enforcement:**

| Own artifacts | Source | Other tracked | Result                                          |
| ------------- | ------ | ------------- | ----------------------------------------------- |
| changed       | changed | any          | ACCEPTS                                         |
| changed       | unchanged | any        | REFUSES (or `--acknowledge`)                    |
| unchanged     | changed | any          | REFUSES (or `--acknowledge`)                    |
| unchanged     | unchanged | changed    | REFUSES — requires `--acknowledge`              |
| unchanged     | unchanged | unchanged  | ACCEPTS (no-op, records baseline)               |

**Blackbox blocker:** Approve always refuses when source files changed on blackbox nodes.
No `--acknowledge` for source changes on blackbox. The only path is to decompose the
blackbox into a proper node for the modified files.

**Anti-laundering:** A new blackbox node cannot inherit files that were previously
tracked by any other node. Approve refuses first-approve on a blackbox node if any
of its mapped files appear in the drift-state of any other node — regardless of
whether that other node currently has pending E020. Decomposition must produce a
proper node for files with prior tracking history.

**First approve:** If node has no stored baseline (no drift state file), approve accepts
and records the initial baseline.

**Compound drift:** A node can have E020 (direct) and E021 (cascade) simultaneously.
A single approve recalculates the full hash across all tracked file layers and clears
both.

**Approve always records:** Approve always records the new baseline hash when it
accepts, including on no-op. This ensures structural metadata changes (`yg-node.yaml`)
are captured even when no axis registers them as a change.

**Artifact scope:** `yg-node.yaml` is not counted as an artifact for the three-axis
check — only `.md` content files count as own artifacts.

**Result:**

```text
Approved: orders/order-service
  Hash: a1b2c3d4 -> e5f6g7h8
```

**Errors:**

- Node does not exist.
- Node has no mapping.
- Enforcement rules refuse the approve (see table above).
- Blackbox source change — must decompose.

---

## Platform rules file

Initialization generates a rules file delivered via the agent platform's integration
mechanism. The location depends on the platform:

| Platform      | File                                                  | Delivery                       |
| ------------- | ----------------------------------------------------- | ------------------------------ |
| `cursor`      | `.cursor/rules/yggdrasil.mdc`                         | Embeds full rules content      |
| `claude-code` | `CLAUDE.md` (imports `.yggdrasil/agent-rules.md`)     | References `agent-rules.md`    |
| `copilot`     | `.github/copilot-instructions.md` (Yggdrasil section) | Embeds full rules content      |
| `cline`       | `.clinerules/yggdrasil.md`                            | Embeds full rules content      |
| `roocode`     | `.roo/rules/yggdrasil.md`                             | Embeds full rules content      |
| `codex`       | `AGENTS.md` (Yggdrasil section)                       | Embeds full rules content      |
| `windsurf`    | `.windsurf/rules/yggdrasil.md`                        | Embeds full rules content      |
| `aider`       | `.aider.conf.yml` (adds `read:` entry)                | References `agent-rules.md`    |
| `gemini`      | `GEMINI.md` (imports `.yggdrasil/agent-rules.md`)     | References `agent-rules.md`    |
| `amp`         | `AGENTS.md` (imports `.yggdrasil/agent-rules.md`)     | References `agent-rules.md`    |
| `generic`     | `.yggdrasil/agent-rules.md`                           | Direct file                    |

The content is identical regardless of the platform — only the location and any wrapper
(frontmatter, section in an existing file, etc.) differ.

### Rules content

The canonical agent rules are delivered by the platform integration file generated from
`source/cli/src/templates/rules.ts`. The full prompt is not duplicated here — the spec
documents the behavioral contract; the implementation provides the canonical text.

**Behavioral model:**

- **Start of every conversation:** Run `yg check` — see full picture (drift, errors, coverage).
  Fix any issues before starting work.
  *Exception:* Read-only requests skip check.
- **User signals closing the topic** (e.g. "end", "wrap up", "that's enough", "done"):
  check, report exactly what nodes and files were changed.
- **Execution checklists:** Code-first (read spec, modify code, sync artifacts, `yg approve`)
  and graph-first (read schema, edit graph, verify source, `yg check`, `yg approve`).
  Agent must output and execute before finishing.

The agent learns **how** from five sources: (1) rules file, (2) yg-config.yaml, (3) schemas/,
(4) existing graph nodes, (5) check feedback. See the [Integration](integration) document.
