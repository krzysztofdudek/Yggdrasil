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

### config.yaml

The configuration file in the graph root directory. The single source of truth for what
tools expect and enforce.

```yaml
name: my-project # string, required

stack: # map, optional
  language: typescript # string, optional
  runtime: node # string, optional
  framework: nestjs # string, optional
  database: postgresql # string, optional
  testing: jest # string, optional
  # extensible — any string -> string keys

standards: | # string, optional, multiline
  Strict TypeScript. All public functions have JSDoc.
  Errors in RFC 7807 format. Dates in ISO 8601 UTC.

node_types: # list of {name, required_aspects?}, required, non-empty
  - name: module
  - name: service
  - name: library
  # With required_aspects per type:
  # - name: service
  #   required_aspects: [requires-audit]

artifacts: # map, required, non-empty — keys are full filenames (e.g. responsibility.md, api.txt)
  responsibility.md:
    required: always # always | never | {when: <condition>}
    description: "What this node is responsible for, and what it is not"
    structural_context: true # optional, default false — include in dependency context for structural relations

  interface.md:
    required:
      when: has_incoming_relations # structural condition
    description: "Public API — methods, parameters, return types, contracts"
    structural_context: true

  logic.md:
    required: never
    description: "Algorithmic flow, control flow, branching logic, decision trees — the 'how' of execution"

  constraints.md:
    required: never
    description: "Validation rules, business rules, invariants"
    structural_context: true

  errors.md:
    required:
      when: has_incoming_relations
    description: "Failure modes, edge cases, error conditions, recovery behavior"
    structural_context: true

  model.md:
    required: never
    description: "Data structures, schemas, entities, type definitions — the shape of data this node owns or manages"

  state.md:
    required: never
    description: "State machines, lifecycle, transitions"

  decisions.md:
    required: never
    description: "Local design decisions with rejected alternatives — 'Chose X over Y because Z'. Highest-value artifact for preserving intent."

quality: # map, optional (has default values) — all keys snake_case
  min_artifact_length: 50 # int, default 50
  max_direct_relations: 10 # int, default 10
  context_budget:
    warning: 10000 # int, default 10000 (tokens)
    error: 20000 # int, default 20000 (tokens)
```

**Artifact requirement conditions:**

| `required` value               | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `always`                       | Every non-blackbox node must have this artifact                 |
| `never`                        | Artifact is always optional                                     |
| `when: has_incoming_relations` | Required when there is a relation from another node to this one |
| `when: has_outgoing_relations` | Required when this node has relations to others                 |
| `when: has_aspect:<name>`      | Required when the node carries the specified aspect             |

**Validation rules for config.yaml:**

- `name` must be non-empty.
- `node_types` must contain at least one element. Format: list of `{ name, required_aspects? }`. Legacy format (list of plain strings) is also accepted. Node `type` must match a `name` (or the string itself in legacy format).
- `artifacts` must contain at least one element.
- Artifact filenames cannot be `node.yaml` (reserved in every node directory).
- `has_aspect:<name>` conditions must refer to aspect directory names (exist under `aspects/<name>/`). Legacy `has_tag:<name>` is accepted for backward compatibility.
- `quality.context_budget.error` must be ≥ `quality.context_budget.warning`.

### node.yaml

Node identity and all its outgoing connections.

```yaml
name: OrderService # string, required
type: service # string, required — from config.node_types
aspects: [requires-audit, requires-auth] # list of strings, optional — aspect identifiers (directory paths under aspects/)
blackbox: false # bool, optional, default false

relations: # list, optional
  - target: payments/payment-service # string, required — path relative to model/
    type: calls # string, required — relation type (see table)
    consumes: [charge, refund] # list of strings, optional
    failure: "retry 3x, then payment-failed" # string, optional
    # For event relations (emits, listens): event_name (optional) — display name, e.g. OrderPlaced

mapping: # map, optional
  paths: # list of strings, required when mapping is present
    - src/modules/orders/order.service.ts
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

`mapping.paths` is a list of file and/or directory paths relative to project root. Files and
directories are auto-detected at runtime. Each path in the list is hashed individually — files
are hashed directly, directories are scanned recursively (respecting `.gitignore`).

**Validation rules for node.yaml:**

- `name` must be non-empty.
- `type` must be from the `config.node_types` list.
- Each aspect identifier must correspond to a directory under `aspects/`.
- Each `relations[].target` must resolve to an existing node.
- Each `relations[].type` must be from the table above.
- Paths in `mapping.paths` must be relative to the repository root.
- `mapping.paths` must be non-empty when `mapping` is present.
- Mappings cannot overlap with mappings of other nodes.

### aspect.yaml

Aspect metadata — a cross-cutting requirement. The aspect identifier is the relative directory
path under `aspects/` (e.g. `aspects/requires-audit/` has identifier `requires-audit`;
`aspects/observability/logging/` has identifier `observability/logging`).

```yaml
name: Audit logging # string, required
description: "Short description for discovery" # string, optional
implies: [requires-logging] # list of strings, optional — ids of other aspects
```

Nested directories under `aspects/` are organizational groupings. There is no automatic
parent-child relationship from nesting — `implies` is always explicit.

All files in the aspect directory except `aspect.yaml` are content attached to the context
packages of nodes carrying the specified aspect. When `implies` is present, the aspect's content
plus all implied aspects' content is attached. Tools resolve implications recursively and detect cycles.

**Validation rules:**

- `name` must be non-empty.
- Every identifier in `implies` must have a corresponding aspect directory under `aspects/`.
- The aspect implies graph must be acyclic (no A implies B implies A).

### flow.yaml

End-to-end flow metadata.

```yaml
name: Checkout flow # string, required
nodes: # list of strings, required, non-empty
  - orders/order-service # path relative to model/
  - payments/payment-service
aspects: # list of strings, optional — aspect ids propagated to all participants
  - requires-saga
  - requires-idempotency
```

All files in the flow directory except `flow.yaml` are content attached to the context
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
- `## Participants` — nodes involved (align with `flow.yaml` nodes)
- `## Paths` — must contain at least `### Happy path`; each additional business path (exception, cancellation, timeout) gets `### [name]`
- `## Invariants across all paths` — business rules and technical conditions holding across all paths

Note: section validation is not yet enforced by `yg validate`.

One flow directory = one business process with all its paths (happy path, exceptions, cancellations).

### schemas/

The `schemas/` directory contains schema files — one per graph layer. Initialization copies
`node.yaml`, `aspect.yaml`, and `flow.yaml` from the CLI package. Each file
shows the expected YAML structure for its element type. The agent reads the schema before
creating or editing that element (see the [Graph](graph) document, Schemas section).

| File          | Element type | Describes structure of              |
| ------------- | ------------ | ----------------------------------- |
| `node.yaml`   | Nodes        | `node.yaml` in model directories    |
| `aspect.yaml` | Aspects      | `aspect.yaml` in aspects directories|
| `flow.yaml`   | Flows        | `flow.yaml` in flows directories    |

### .drift-state

Synchronization state between the graph and all tracked files (source and graph artifacts).
Managed exclusively by tools — agents and humans do not edit it. Stored at
`.yggdrasil/.drift-state`.

Committed to the repository (shared in the team).

```yaml
orders/order-service:
  hash: "a1b2c3d4e5f6..."
  files:
    "src/modules/orders/order.service.ts": "1111..."
    "src/modules/orders/order.repository.ts": "2222..."
    ".yggdrasil/model/orders/order-service/node.yaml": "3333..."
    ".yggdrasil/model/orders/order-service/responsibility.md": "4444..."
    ".yggdrasil/aspects/requires-audit/aspect.yaml": "5555..."
payments/payment-service:
  hash: "deadbeef..."
  files:
    "src/modules/payments/payment.service.ts": "6666..."
    ".yggdrasil/model/payments/payment-service/node.yaml": "7777..."
```

**Format:** map `node-path -> entry`. The key is a path relative to `model/`. Each entry is
always an object:

- `hash` (required) — canonical SHA-256 hash of all tracked files (source + graph).
- `files` (required) — map `file_path -> file_hash` for all tracked files. Includes both
  source paths (from `mapping.paths`) and `.yggdrasil/` graph paths (node artifacts,
  ancestor artifacts, aspect files, flow files, relation target artifacts — mirroring the
  context assembly traversal). Enables drift detection to report exactly which files changed
  and whether they are source or graph files.

The `files` map always contains every tracked file for the node. Source files come from the
node's mapping. Graph files come from the `collectTrackedFiles` algorithm, which mirrors
the six layers of tracked file collection (own, hierarchical, aspects, relational dependencies,
relational flows, source). See the [Engine](engine) document for details.

Each path in `mapping.paths` is checked at runtime — if it is a file, it is hashed directly
(SHA-256 of file content); if it is a directory, it is scanned recursively (respecting
`.gitignore`), each file is hashed, and a canonical hash is computed from sorted path:hash
pairs. The overall canonical `hash` combines all tracked file hashes (source + graph) into a
single value.

### .journal.yaml

Session buffer between ephemeral conversation and the persistent graph. Managed by tools —
the agent provides the content, the tool handles formatting. Stored at `.yggdrasil/.journal.yaml`.

Gitignored (local per-developer).

```yaml
entries:
  - at: "2024-01-15T10:30:00Z"
    target: orders/order-service
    note: "We decided on event sourcing for order states"
  - at: "2024-01-15T11:45:00Z"
    note: "Payment gateway requires idempotency keys on every request"
```

| Field    | Type                  | Required | Description                                      |
| -------- | --------------------- | -------- | ------------------------------------------------ |
| `at`     | string (ISO 8601 UTC) | Yes      | Entry timestamp                                  |
| `target` | string                | No       | Path to the affected node (relative to `model/`) |
| `note`   | string                | Yes      | The intent/note content                          |

The tool generates `at`. The agent provides `target` and `note`.

The existence of a file with entries means pending intents. No file or an empty file means
a clean state (see the [Engine](engine) document).

---

## Operations

Each operation is described by its purpose, parameters, step-by-step behavior, result, and
error conditions. Operations do not modify semantic content in the graph — they only create, read,
or modify operational metadata (`.yggdrasil/.drift-state`, `.yggdrasil/.journal.yaml`). The only exception is
initialization, which creates the starting structure.

### Naming convention

Operations are invoked as tool commands with the `yg` prefix:

```text
yg init --platform cursor
yg init --platform cursor --upgrade   # refreshes rules when .yggdrasil/ exists
yg build-context --node orders/order-service
yg tree
yg aspects
yg status
yg preflight
yg owner --file src/modules/orders/order.service.ts
yg deps --node orders/order-service
yg impact --node payments/payment-service --simulate
yg validate
yg drift
yg drift-sync --node orders/order-service
yg journal-add --note "..." --target orders/order-service
yg journal-read
yg journal-archive
```

Command names correspond to the section headers below. Parameters passed via flags
(`--node`, `--file`, `--simulate`, etc.) or positionally are an implementation decision,
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

1. Check if `.yggdrasil/` exists. If it exists and `upgrade` is `false` — error. If it exists and `upgrade` is `true` — go to step 5 (only rules file).
2. Create directory structure:

   ```text
   .yggdrasil/
   ├── config.yaml
   ├── .gitignore
   ├── model/
   ├── aspects/
   ├── flows/
   └── schemas/
   ```

3. Write `config.yaml` with default content (see Default configuration below).
4. Write `.yggdrasil/.gitignore`:

   ```text
   .journal.yaml
   journals-archive/
   ```

5. Generate the platform rules file in the location appropriate for the `platform` parameter
   (see Platform rules file section).

**Result:**

- Full initialization: list of created files and directories.
- Upgrade mode: path of the refreshed rules file.

**Errors:**

- `.yggdrasil/` already exists and `upgrade` was not provided — full init is a one-time operation.

**Default configuration:**

```yaml
name: ""

stack:
  language: ""
  runtime: ""

standards: ""

node_types:
  - name: module
  - name: service
  - name: library

artifacts:
  responsibility.md:
    required: always
    description: "What this node is responsible for, and what it is not"
    structural_context: true
  interface.md:
    required:
      when: has_incoming_relations
    description: "Public API — methods, parameters, return types, contracts"
    structural_context: true
  logic.md:
    required: never
    description: "Algorithmic flow, control flow, branching logic, decision trees — the 'how' of execution"
  constraints.md:
    required: never
    description: "Validation rules, business rules, invariants"
    structural_context: true
  errors.md:
    required:
      when: has_incoming_relations
    description: "Failure modes, edge cases, error conditions, recovery behavior"
    structural_context: true
  model.md:
    required: never
    description: "Data structures, schemas, entities, type definitions — the shape of data this node owns or manages"
  state.md:
    required: never
    description: "State machines, lifecycle, transitions"
  decisions.md:
    required: never
    description: "Local design decisions with rejected alternatives — 'Chose X over Y because Z'. Highest-value artifact for preserving intent."

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
```

The agent fills in `name`, `stack`, and `standards` after initialization.
The tool does not guess these values.

**Note:** Until `name` is set (non-empty), most commands that load the graph will fail
with a config parse error. The user should edit `config.yaml` before running
`yg validate`, `yg status`, `yg drift`, or other operations.

---

### Build context

Assemble a context package for the specified node. The main operation of the system.

**Parameters:**

| Parameter | Type   | Required | Description                    |
| --------- | ------ | -------- | ------------------------------ |
| `node`    | string | Yes      | Node path relative to `model/` |

**Behavior:**

The 5-step algorithm defined in the [Engine](engine) document. Summary:

1. **Global** — `config.yaml` (stack, standards).
2. **Hierarchical** — ancestor artifacts (from `model/` root down to the node's parent).
3. **Own** — the node's `node.yaml` (raw) and content artifacts.
4. **Aspects** — union of aspect identifiers from hierarchy blocks, own block, and flow blocks (each block
   declares its own; no inheritance). Expand implies recursively. Render content of each
   matching aspect. No source attribute on aspect output.
5. **Relational** — for structural relations: artifacts with `structural_context: true`
   (default: responsibility, interface, constraints, errors) of the target with consumes
   and failure annotations. If the target has no artifacts with `structural_context: true`,
   all configured artifacts are included as fallback. For event relations: event name and
   type with consumes annotation. Flow artifacts for flows listing this node or any ancestor
   as a participant.

Token estimation: ~4 characters per token (heuristic from the [Engine](engine) document).

**Result:**

Plain text with XML-like tags, as defined in the [Engine](engine) document (Context package format
section). Includes token count and budget status (`ok`, `warning`, `error`).

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
2. For each directory with a `node.yaml` — read metadata.
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
`node.yaml` and `flow.yaml`.

**Parameters:** none.

**Behavior:**

1. Resolve `.yggdrasil/` root (repository root or nearest parent).
2. Load the graph — find all aspect directories under `.yggdrasil/aspects/` (including nested).
3. Sort by aspect identifier.
4. Output YAML with `id`, `name`, `description` (if present), `implies` (if present).

**Result:**

```yaml
- id: deterministic
  name: Determinism
- id: observability/logging
  name: Audit Logging
  description: Every state-changing operation must produce an audit log entry
  implies:
    - observability/tracing
```

**Errors:**

- No `.yggdrasil/` directory — exit 1.
- If no `aspects/` directory exists, outputs an empty list.

---

### Flows

Lists flows with metadata in YAML format. Use to discover defined business processes,
their participants, and associated aspects.

**Parameters:** none.

**Behavior:**

1. Resolve `.yggdrasil/` root (repository root or nearest parent).
2. Load the graph — find all flow directories under `.yggdrasil/flows/`.
3. Sort by flow name.
4. Output YAML with `name`, `nodes` (participants), `aspects` (if present).

**Result:**

```yaml
- name: Checkout Flow
  nodes:
    - orders/order-service
    - auth/auth-api
  aspects:
    - requires-audit
```

**Errors:**

- No `.yggdrasil/` directory — exit 1.
- If no `flows/` directory exists, outputs an empty list.

---

### Status

Summary of the graph state: numbers, metrics, problems.

**Parameters:** none.

**Behavior:**

1. Count nodes (broken down by types and blackbox/non-blackbox).
2. Count relations (broken down by structural/event).
3. Count aspects and flows.
4. Read drift state for mapped nodes.
5. Run validation (only counting errors and warnings, without full messages).
6. Compute quality metrics: artifact fill rate, relation distribution, mapping coverage,
   aspect coverage.

**Result:**

```text
Graph: my-project
Nodes: 12 (3 modules, 7 services, 2 libraries) + 2 blackbox
Relations: 15 structural, 4 event
Aspects: 3    Flows: 2
Drift: 1 source-drift, 1 graph-drift, 0 full-drift, 1 missing, 2 unmaterialized, 7 ok
Validation: 0 errors, 3 warnings

Quality:
  Artifacts: 42/96 slots filled (44%) — 8 types × 12 nodes
  Relations: avg 1.6/node, max 5 (orders/order-service)
  Mapping: 10/12 nodes mapped to source
  Aspects: 8/12 nodes have aspect coverage
```

**Errors:**

- No `.yggdrasil/` — repository is not initialized.
- Invalid `config.yaml` — configuration cannot be parsed.

---

### Preflight

Unified diagnostic combining journal state, drift detection, graph status, and validation.

**Parameters:**

| Parameter | Type | Required | Description                                           |
| --------- | ---- | -------- | ----------------------------------------------------- |
| `quick`   | bool | No       | Skip drift detection for faster results. Default: `false`. |

**Behavior:**

1. Run `journal-read` — list pending journal entries (non-empty journal contributes to exit code 1).
2. Unless `--quick`: run `drift --drifted-only` — report nodes with source or graph drift (any drift contributes to exit code 1). When `--quick`, output "Drift: skipped (--quick)".
3. Run `status` — report graph health (node, aspect, flow, and mapping counts).
4. Run `validate` — report structural errors and completeness warnings (any errors contribute to exit code 1).

**Result:**

```text
Journal: 1 pending entry

Drift:
  orders/order-service source-drift

Graph: my-project
Nodes: 12 (3 modules, 7 services, 2 libraries) + 2 blackbox
Relations: 15 structural, 4 event
Aspects: 3    Flows: 2
Drift: 1 source-drift, 0 graph-drift, 0 full-drift, 0 missing, 0 unmaterialized, 11 ok
Validation: 0 errors, 3 warnings
```

**Exit codes:**

- `0` — fully clean: no journal entries, no drift, no validation errors.
- `1` — one or more of: pending journal entries, drifted nodes, validation errors.

**Errors:**

- No `.yggdrasil/` — repository is not initialized.

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

### Dependency analysis

Shows node dependencies — direct and transitive.

**Parameters:**

| Parameter | Type   | Required | Description                                                          |
| --------- | ------ | -------- | -------------------------------------------------------------------- |
| `node`    | string | Yes      | Node path relative to `model/`                                       |
| `depth`   | int    | No       | Transitive depth. Default: unlimited.                                |
| `type`    | string | No       | Relation class filter: `structural`, `event`, `all`. Default: `all`. |

**Behavior:**

1. Read node relations.
2. Recursively follow outgoing relations up to the specified depth.
3. Build a dependency tree.

**Result:**

```text
orders/order-service
├── calls payments/payment-service
│   └── calls stripe/stripe-gateway ■ blackbox
├── calls inventory/inventory-service
└── emits notifications/notification-service
```

**Errors:**

- Node does not exist.

---

### Impact analysis

Shows the blast radius of changes to a node, aspect, or flow. Supports three
mutually exclusive modes and an optional simulation pass.

**Parameters:**

| Parameter  | Type   | Required              | Description                                                       |
| ---------- | ------ | --------------------- | ----------------------------------------------------------------- |
| `node`     | string | One of three required | Node path relative to `model/`                                    |
| `aspect`   | string | One of three required | Aspect id (directory path under `aspects/`)                       |
| `flow`     | string | One of three required | Flow name (directory name under `flows/`)                         |
| `simulate` | bool   | No                    | Whether to simulate impact on context packages. Default: `false`. |

Exactly one of `node`, `aspect`, or `flow` must be provided.

#### Node mode (`--node`)

1. Find all nodes whose structural relations point to the target (reverse graph edge).
2. Recursively follow reverse edges (transitive reverse dependencies).
3. Collect descendants of the target node (hierarchy impact).
4. Find flows listing the target node.
5. Compute effective aspects (own + hierarchy + flow + implies).
6. Find co-aspect nodes sharing any aspect with the target.

```text
Impact of changes in payments/payment-service:

Directly dependent:
  <- orders/order-service (calls, you consume: charge, refund)
  <- subscriptions/billing-service (calls, you consume: charge)

Transitively dependent:
  <- orders/order-service <- checkout/checkout-controller

Descendants (hierarchy impact):
  payments/payment-service/stripe-adapter

Flows: checkout
Aspects (scope covers node): requires-saga, requires-idempotency
Nodes sharing aspects:
  orders/order-service (requires-saga, requires-idempotency)

Total scope: 4 nodes, 1 flows, 2 aspects
```

#### Aspect mode (`--aspect`)

1. For every node, compute effective aspects (own + hierarchy + flow + implies).
2. Collect all nodes where the specified aspect is effective.
3. Report source of the aspect for each node: own, hierarchy, flow, or implied.
4. List flows propagating this aspect and implies relationships.

```text
Impact of changes in aspect requires-audit:

Affected nodes (3):
  orders (own)
  orders/order-service (hierarchy from orders)
  payments/payment-service (flow: checkout)

Flows propagating this aspect: (none)
Implied by: (none)
Implies: (none)

Total scope: 3 nodes, 0 flows
```

#### Flow mode (`--flow`)

1. List all declared participants.
2. Expand each participant's descendants (hierarchy impact).
3. Report flow-level aspects.

```text
Impact of changes in flow Checkout Flow:

Participants:
  auth/auth-api
  orders/order-service
  payments/payment-service
  payments/payment-service/stripe-adapter (descendant)

Flow aspects: requires-saga

Total scope: 4 nodes
```

#### Simulation mode (`--simulate`)

Available with any mode. For each affected node:

1. Assemble a context package in the current graph state.
2. Assemble a baseline context package from the HEAD commit.
3. Report token budget shift (baseline → current) with ok/warning/error status.
4. In node mode, flag nodes with a changed dependency interface to the target.
5. Report drift status of mapped source files.

```text
Changes in context packages:

orders/order-service:
  + Changed dependency interface: payments/payment-service
  Budget: 3200 -> 3450 tokens (ok)
  Mapped files (on-disk): ok

subscriptions/billing-service:
  + Changed dependency interface: payments/payment-service
  Budget: 2800 -> 3050 tokens (ok)
  Mapped files (on-disk): drift (Changed files: src/billing/charge.ts)
```

**Errors:**

- Node / aspect / flow does not exist.
- Multiple modes specified (mutually exclusive).
- No mode specified.

---

### Validate

Validate structural integrity and completeness signals of the entire graph or a specified node.

**Parameters:**

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `scope`   | string | No       | `all` or node path. When a node path is given, includes all descendant nodes. Default: `all`. |

**Behavior:**

Two levels of severity defined in the [Engine](engine) document.

**Errors (structural integrity):**

| Code   | Message                      | Description                                            |
| ------ | ---------------------------- | ------------------------------------------------------ |
| `E001` | `invalid-node-yaml`          | `node.yaml` fails to parse or lacks required fields    |
| `E002` | `unknown-node-type`          | Node type is not in `config.node_types`                |
| `E003` | `unknown-aspect`             | Aspect identifier does not correspond to an aspect directory |
| `E004` | `broken-relation`            | Relation target does not resolve to an existing node   |
| `E006` | `broken-flow-ref`            | Flow participant does not resolve                      |
| `E007` | `broken-aspect-ref`          | Aspect reference does not resolve                      |
| `E009` | `overlapping-mapping`        | Overlapping mappings between unrelated nodes           |
| `E010` | `structural-cycle`           | Cycle in structural relations (cycles involving blackbox are tolerated) |
| `E012` | `invalid-config`             | `config.yaml` fails to parse or is invalid             |
| `E013` | `invalid-artifact-condition` | Condition `has_aspect:<name>` refers to an undefined aspect  |
| `E014` | `duplicate-aspect-binding`   | Aspect identifier is bound to multiple aspect directories |
| `E015` | `missing-node-yaml`          | Directory in `model/` has files but no `node.yaml`     |
| `E016` | `implied-aspect-missing`     | Identifier in aspect's `implies` has no corresponding aspect in `aspects/`           |
| `E017` | `aspect-implies-cycle`       | Cycle in aspect implies graph (A implies B implies A)                                |

**Warnings (completeness signals):**

| Code   | Message                 | Description                                                                         |
| ------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `W001` | `missing-artifact`      | Missing required artifact                                                           |
| `W002` | `shallow-artifact`      | Artifact below minimum length                                                       |
| `W005` | `budget-warning`        | Context package exceeds warning threshold                                           |
| `W006` | `budget-error`          | Context package exceeds error threshold (blocks materialization); severity: warning |
| `W007` | `high-fan-out`          | Node exceeds maximum number of relations                                            |
| `W009` | `unpaired-event`        | Event relation without complement on the other side                                 |
| `W010` | `missing-schema`        | Required schema (node, aspect, flow) missing from `.yggdrasil/schemas/`            |
| `W011` | `missing-required-aspect-coverage` | Node of type with `required_aspects` lacks coverage (direct aspect or via implies) for one or more |
| `W012` | `mapping-path-missing`             | Mapping path in `node.yaml` does not exist on disk — catches typos and stale mappings             |
| `W013` | `directory-without-node`           | Directory in `model/` has only subdirectories but no `node.yaml` — bare intermediate directory    |

**Message format:**

```text
E004 orders/order-service -> relation to 'payment/svc' does not resolve.
     Existing nodes in payments/: payment-service
     Did you mean 'payments/payment-service'?

W001 orders/order-service -> missing artifact 'interface'.
     Node has 3 incoming relations: auth/login-service, checkout/controller,
     subscriptions/billing-service. Define the public API in interface.md.

W005 orders/order-service -> context package: ~5800 tokens (threshold: 5000).
     Consider splitting the node or reducing dependencies.
```

Messages are **contextual and actionable** — not just "error", but what is wrong,
why, and what to do (see the [Integration](integration) document).

**Result:**

A list of messages grouped: errors first, then warnings.
Summary at the end: X errors, Y warnings.

**Exit code:** 0 if no errors, 1 if any errors found.

**Operation errors:**

- The specified node in `scope` does not exist.
- `config.yaml` fails to parse (reported as E012, not as an operation error — validation
  continues as much as it can).

---

### Drift

Detect divergences between the graph and tracked files (source + graph artifacts).
Drift detection is bidirectional — it tracks changes on both the source side (mapped files)
and the graph side (`.yggdrasil/` artifacts that contribute to the node's context package).

**Parameters:**

| Parameter      | Type   | Required | Description                                                       |
| -------------- | ------ | -------- | ----------------------------------------------------------------- |
| `scope`        | string | No       | `all` or node path. When a node path is given, includes all descendant nodes. Default: `all`. |
| `drifted-only` | bool   | No       | Hide `ok` entries; show only nodes with drift. Default: `false`.  |
| `limit`        | number | No       | Max entries per section. Truncated sections show remaining count. |

**Behavior:**

1. For each mapped node (in scope):
   a. Check if mapped source files exist on disk.
   b. Collect all tracked files for the node (source files from mapping + graph artifact
      files from context assembly traversal) via `collectTrackedFiles`.
   c. Compute hashes for all tracked files and compare with the baseline in
      `.yggdrasil/.drift-state`.
   d. Classify each changed file as `source` or `graph` based on whether its path is under
      `.yggdrasil/`.
   e. Assign state: `ok`, `source-drift`, `graph-drift`, `full-drift`, `missing`,
      `unmaterialized`.

**States:**

| State            | Condition                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `ok`             | All tracked file hashes match — nothing changed since synchronization                       |
| `source-drift`   | Source file(s) changed but graph artifacts unchanged                                        |
| `graph-drift`    | Graph artifact(s) changed but source files unchanged                                        |
| `full-drift`     | Both source and graph files changed                                                         |
| `missing`        | Mapped source files do not exist on disk, but a hash exists in `.drift-state`               |
| `unmaterialized` | Node has a mapping, but files have never been created (no entry in `.drift-state`)           |

If a node has no drift-state entry but its files exist on disk, it reports `source-drift`
with a note to run `drift-sync`.

**Result:**

Output is organized in two sections — Source drift and Graph drift. Nodes appear in the
section(s) relevant to their drift type. `full-drift` nodes appear in both sections.

```text
Source drift:
  [drift]      orders/order-service
               src/modules/orders/order.service.ts  (changed)
  [missing]    auth/token-service
  [unmat.]     notifications/email-service
  [ok]         payments/payment-service

Graph drift:
  [drift]      orders/order-service
               .yggdrasil/model/orders/order-service/responsibility.md  (changed)
  [ok]         payments/payment-service

Summary: 1 source-drift, 0 graph-drift, 1 full-drift, 1 missing, 1 unmaterialized, 1 ok
```

With `--drifted-only`, `ok` entries are hidden and the summary shows the count of hidden
entries.

Changed files are listed per-section — the Source drift section shows only changed source
files, the Graph drift section shows only changed graph files.

**Exit code:** 0 if all nodes are `ok`, 1 if any drift/missing/unmaterialized entries exist.

**Errors:**

- Specified node does not exist.
- Node has no mapping (does not participate in drift detection).

---

### Drift sync

Update the remembered hash for a node after resolving a divergence.
Called after the agent resolves drift (absorption or rejection + re-materialization).

**Parameters:**

| Parameter   | Type   | Required | Description                                                       |
| ----------- | ------ | -------- | ----------------------------------------------------------------- |
| `node`      | string | No*      | Node path relative to `model/`. Required unless `--all` is used.  |
| `recursive` | bool   | No       | Also sync all descendant nodes. Default: `false`.                 |
| `all`       | bool   | No*      | Sync all nodes with mappings. Required unless `--node` is used.   |

**Behavior:**

1. Collect all tracked files for the node via `collectTrackedFiles` — this includes both
   source files (from `mapping.paths`) and graph artifact files (from the context assembly
   traversal: own node, ancestors, aspects, relational dependencies, flows).
2. Compute hashes for all tracked files.
3. Write the canonical hash and per-file hashes to `.yggdrasil/.drift-state`.

The operation captures the complete set of tracked files (source + graph), not just mapping
files. This enables subsequent drift detection to identify changes on either side.

The operation does not check _how_ the drift was resolved (that is the agent's and human's
decision). It records the current file state as the new baseline.

**Result:**

```text
Synchronized: orders/order-service
  Hash: a1b2c3d4 -> e5f6g7h8
```

**Errors:**

- Node does not exist.
- Node has no mapping.
- Mapped files do not exist (cannot calculate hash).

---

### Journal: add

Add an entry to the session journal.

**Parameters:**

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `note`    | string | Yes      | The content of the note   |
| `target`  | string | No       | Path to the affected node |

**Behavior:**

1. If `.yggdrasil/.journal.yaml` does not exist — create it with an empty `entries` list. (Path is inside `.yggdrasil/`.)
2. Add an entry with an automatic timestamp (UTC), `target` (if provided), and `note`.

**Result:**

```text
Note added to journal (3 entries total)
```

**Errors:**

- None — operation always succeeds.

---

### Journal: read

List entries from the current journal.

**Parameters:** none.

**Behavior:**

1. If `.yggdrasil/.journal.yaml` does not exist or is empty — return an empty list. (Path is inside `.yggdrasil/`.)
2. Read and return the entries.

**Result:**

```text
Session journal (3 entries):

[2024-01-15 10:30:00] orders/order-service
  We decided on event sourcing for order states

[2024-01-15 11:45:00]
  Payment gateway requires idempotency keys on every request

[2024-01-15 14:20:00] auth/token-service
  Refresh tokens — rotation on every use, 7 day TTL
```

Or:

```text
Session journal: empty (clean state)
```

**Errors:**

- None — operation always succeeds.

---

### Journal: archive

Move the current journal to the archive.

**Parameters:** none.

**Behavior:**

1. If `.yggdrasil/.journal.yaml` does not exist or has no entries — nothing to archive.
2. Create directory `.yggdrasil/journals-archive/` if it does not exist.
3. Move `.yggdrasil/.journal.yaml` to
   `.yggdrasil/journals-archive/.journal.<datetime>.yaml`
   where `<datetime>` is a timestamp in `YYYYMMDD-HHmmss` format.
4. The active journal disappears — the next session starts clean.

**Result:**

```text
Archived journal (3 entries) -> journals-archive/.journal.20240115-143000.yaml
```

Or:

```text
No active journal - nothing to archive.
```

**Errors:**

- None — operation always succeeds.

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

**Behavioral model (no explicit "session"):**

- **Start of every conversation:** Preflight — (1) `yg journal-read` (consolidate, archive if entries exist),
  (2) `yg drift --drifted-only` (reports source and graph drift — `source-drift`/`graph-drift`/`full-drift`/`missing`/`unmaterialized`),
  (3) `yg status` (report health), (4) `yg validate` (fix any errors, address warnings).
  _Exception:_ Read-only requests run only step 1.
- **User signals closing the topic** (e.g. "we're done", "wrap up", "that's enough", "done"): Consolidate journal (if used),
  archive, drift, validate, report exactly what nodes and files were changed.
- **Execution checklists:** Code-first (read spec → modify code → sync artifacts → baseline hash) and graph-first
  (read schema → edit graph → verify source → validate → baseline hash). Agent must output and execute before finishing.

The agent learns **how** from five sources: (1) rules file, (2) config.yaml, (3) schemas/,
(4) existing graph nodes, (5) validation feedback. See the [Integration](integration) document.
