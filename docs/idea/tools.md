# Tools

## What this document is

The [Foundation](foundation) document defines the problem and invariants. The [Graph](graph) document defines the
structure of semantic memory. The [Engine](engine) document defines deterministic mechanics.
The [Integration](integration) document defines the behavioral contract with agents. The [Materialization](materialization)
document defines how knowledge becomes an output.

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

tags: # list of strings, required (can be empty)
  - service
  - repository
  - requires-audit

node_types: # list of strings, required, non-empty (snake_case)
  - module
  - service
  - library

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
    description: "Local design decisions and rationale — choices specific to this node, not system-wide"

knowledge_categories: # list, required (can be empty) (snake_case)
  - name: decisions # string, unique
    description: "Semantic decisions and their rationale"
  - name: patterns
    description: "Implementation conventions with examples"
  - name: invariants
    description: "System truths that must never be violated"

quality: # map, optional (has default values) — all keys snake_case
  min_artifact_length: 50 # int, default 50
  max_direct_relations: 10 # int, default 10
  context_budget:
    warning: 10000 # int, default 10000 (tokens)
    error: 20000 # int, default 20000 (tokens)
  knowledge_staleness_days: 90 # int, default 90 (snake_case)
```

**Artifact requirement conditions:**

| `required` value               | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `always`                       | Every non-blackbox node must have this artifact                 |
| `never`                        | Artifact is always optional                                     |
| `when: has_incoming_relations` | Required when there is a relation from another node to this one |
| `when: has_outgoing_relations` | Required when this node has relations to others                 |
| `when: has_tag:<name>`         | Required when the node carries the specified tag (snake_case)   |

**Validation rules for config.yaml:**

- `name` must be non-empty.
- `node_types` must contain at least one element.
- `artifacts` must contain at least one element.
- Artifact filenames cannot be `node.yaml` (reserved in every node directory).
- Knowledge category names must be unique.
- Each category name must correspond to a subdirectory in `knowledge/`.
- `has_tag:<name>` conditions must refer to tags from the `tags` list.
- `quality.context_budget.error` must be ≥ `quality.context_budget.warning`.

### node.yaml

Node identity and all its outgoing connections.

```yaml
name: OrderService # string, required
type: service # string, required — from config.node_types
tags: [requires-audit, requires-auth] # list of strings, optional — from config.tags
blackbox: false # bool, optional, default false

relations: # list, optional
  - target: payments/payment-service # string, required — path relative to model/
    type: calls # string, required — relation type (see table)
    consumes: [charge, refund] # list of strings, optional
    failure: "retry 3x, then payment-failed" # string, optional
    # For event relations (emits, listens): event_name (optional) — display name, e.g. OrderPlaced

knowledge: # list of strings, optional
  - decisions/002-event-sourcing # path relative to knowledge/

mapping: # map, optional
  type: file # string, required — file | directory | files
  path: src/modules/orders/order.service.ts # string — required when type = file | directory
  # paths: [...]                        # list of strings — required when type = files
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

**Mapping variants:**

| `type`      | Required fields           | Description                  |
| ----------- | ------------------------- | ---------------------------- |
| `file`      | `path` (string)           | Single file                  |
| `directory` | `path` (string)           | Directory — all files inside |
| `files`     | `paths` (list of strings) | Explicit list of files       |

**Validation rules for node.yaml:**

- `name` must be non-empty.
- `type` must be from the `config.node_types` list.
- Each tag must be from the `config.tags` list.
- Each `relations[].target` must resolve to an existing node.
- Each `relations[].type` must be from the table above.
- Each `knowledge[]` must resolve to an existing knowledge element.
- Paths in `mapping` must be relative to the repository root.
- When `type` = `file` or `directory`, the `path` field must be present.
- When `type` = `files`, the `paths` field must be present and non-empty.
- Mappings cannot overlap with mappings of other nodes.

### aspect.yaml

Aspect metadata — a cross-cutting requirement bound by a tag.

```yaml
name: Audit logging # string, required
tag: requires-audit # string, required — from config.tags
```

All files in the aspect directory except `aspect.yaml` are content attached to the context
packages of nodes carrying the specified tag.

**Validation rules:**

- `name` must be non-empty.
- `tag` must be from the `config.tags` list.
- Each tag can be bound to at most one aspect.

### flow.yaml

End-to-end flow metadata.

```yaml
name: Checkout flow # string, required
nodes: # list of strings, required, non-empty
  - orders/order-service # path relative to model/
  - payments/payment-service
knowledge: # list of strings, optional
  - patterns/saga-pattern # path relative to knowledge/
```

All files in the flow directory except `flow.yaml` are content attached to the context
packages of the listed nodes.

**Validation rules:**

- `name` must be non-empty.
- `nodes` must be non-empty.
- Each element in `nodes[]` must resolve to an existing node.
- Each element in `knowledge[]` must resolve to an existing knowledge element.

### knowledge.yaml

Knowledge element metadata.

```yaml
name: PostgreSQL for persistence # string, required
scope: global # scope — required (see variants)
```

**Scope variants:**

```yaml
# Global scope — attached to every context package
scope: global

# Tag scope — attached when the node carries at least one of the tags
scope:
  tags: [service, controller]

# Node scope — attached only for listed nodes
scope:
  nodes:
    - orders/order-service
    - users/user-repository
```

The element's category is inferred from its subdirectory: `knowledge/decisions/001-foo/`
is a decision because `decisions` is a configured category.

All files in the knowledge element directory except `knowledge.yaml` are content attached
to the context package.

**Validation rules:**

- `name` must be non-empty.
- `scope` must be one of the three variants.
- Tags in `scope.tags` must be from the `config.tags` list.
- Paths in `scope.nodes` must resolve to existing nodes.
- The parent subdirectory must correspond to a configured knowledge category.

### templates/ schemas

The `templates/` directory contains schema files — one per graph layer. Initialization copies
`node.yaml`, `aspect.yaml`, `flow.yaml`, and `knowledge.yaml` from the CLI package. Each file
shows the expected YAML structure for its element type. The agent reads the schema before
creating or editing that element (see the [Graph](graph) document, Templates section).

| File             | Element type | Describes structure of                          |
| ---------------- | ------------ | ------------------------------------------------ |
| `node.yaml`      | Nodes        | `node.yaml` in model directories                 |
| `aspect.yaml`    | Aspects      | `aspect.yaml` in aspects directories             |
| `flow.yaml`      | Flows        | `flow.yaml` in flows directories                 |
| `knowledge.yaml` | Knowledge    | `knowledge.yaml` in knowledge element directories|

### .drift-state

Synchronization state between the graph and mapped files. Managed exclusively by tools —
agents and humans do not edit it. Stored at `.yggdrasil/.drift-state`.

Committed to the repository (shared in the team).

```yaml
orders/order-service:
  hash: "a1b2c3d4e5f6..."
  files:
    "src/modules/orders/order.service.ts": "1111..."
    "src/modules/orders/order.repository.ts": "2222..."
payments/payment-service:
  hash: "deadbeef..."
```

**Format:** map `node-path -> entry`. The key is a path relative to `model/`. Each entry is an object:

- `hash` (required) — canonical SHA-256 hash of the entire mapping (file, directory, or files list).
- `files` (optional) — map `file_path -> file_hash` for diagnostics; enables drift detection to report which specific files changed. Written by `drift-sync` for `directory`, `files`, and `file` mappings (single entry for `file`; consistent structure across all mapping types).

The mapping strategy (and thus how the hash is calculated) comes from `node.yaml` (`mapping.type`), not from `.drift-state`. The drift-state stores only the baseline.

| Strategy    | Hash algorithm                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `file`      | SHA-256 of the file content. `.gitignore` is not applied — the mapped file is always hashed.   |
| `directory` | SHA-256 of the sorted list of pairs (path, content SHA-256); path is relative to the directory. |
|             | Files matching `.gitignore` (project root) are excluded from the hash.                          |
| `files`     | SHA-256 of the sorted list of pairs (filepath, content SHA-256)                                 |

Strategies `directory` and `files` produce a single canonical hash — changing, adding, or
removing any file changes the hash. Per-file hashes in `files` enable diagnostics (which specific file changed) and are stored when available (e.g. after `drift-sync`).

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
error conditions. Operations do not modify knowledge in the graph — they only create, read,
or modify operational metadata (`.yggdrasil/.drift-state`, `.yggdrasil/.journal.yaml`). The only exception is
initialization, which creates the starting structure.

### Naming convention

Operations are invoked as tool commands with the `yg` prefix:

```text
yg init --platform cursor
yg init --platform cursor --upgrade   # refreshes rules when .yggdrasil/ exists
yg build-context --node orders/order-service
yg tree
yg status
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
   ├── knowledge/
   │   ├── decisions/
   │   ├── patterns/
   │   └── invariants/
   └── templates/
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

tags: []

node_types:
  - module
  - service
  - library

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
    description: "Local design decisions and rationale — choices specific to this node, not system-wide"

knowledge_categories:
  - name: decisions
    description: "Global semantic decisions and their rationale"
  - name: patterns
    description: "Implementation conventions with examples"
  - name: invariants
    description: "System truths that must never be violated"

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
  knowledge_staleness_days: 90
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

The 10-step algorithm defined in the [Engine](engine) document. Summary:

1. **Global** — `config.yaml` (stack, standards).
2. **Global knowledge** — knowledge elements with `scope: global`.
3. **Tag knowledge** — knowledge elements with `scope.tags` matching the node's tags.
4. **Node knowledge** — knowledge elements with `scope.nodes` listing this node.
5. **Declared knowledge** — elements from the `knowledge[]` list in `node.yaml`.
6. **Hierarchical** — ancestor artifacts (from `model/` root down to the node's parent).
7. **Own** — the node's `node.yaml` (raw) and content artifacts.
8. **Relational** — for structural relations: interface + errors of the target with consumes
   and failure annotations. For event relations: event name and type with consumes annotation.
9. **Aspects** — content of aspects matching the node's tags.
10. **Flows** — artifacts of flows listing this node as a participant + knowledge referenced by the flow.

Deduplication: each knowledge element appears at most once in the package, regardless of
the number of paths leading to it.

Token estimation: ~4 characters per token (heuristic from the [Engine](engine) document).

**Result:**

A Markdown document in the format defined in the [Engine](engine) document (Context package format section).
Includes token estimation and budget status (`ok`, `warning`, `error`).

**Errors:**

- Node does not exist at the provided path.
- The graph has structural integrity errors (broken references). Assembly requires a consistent
  graph — the tool reports errors and refuses to assemble.

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
├── auth/ [module]
│   ├── login-service/ [service] tags:requires-auth -> 1 relations
│   └── token-service/ [service] -> 0 relations
├── orders/ [module]
│   └── order-service/ [service] tags:requires-audit,requires-auth -> 2 relations
└── payments/ [module] ■ blackbox
    └── payment-service/ [service] ■ blackbox -> 0 relations
```

Format: path, type in brackets, tags (if any), blackbox flag (if true), number of outgoing relations.

**Errors:**

- The provided root does not exist.

---

### Status

Summary of the graph state: numbers, metrics, problems.

**Parameters:** none.

**Behavior:**

1. Count nodes (broken down by types and blackbox/non-blackbox).
2. Count relations (broken down by structural/event).
3. Count aspects, flows, knowledge elements.
4. Read drift state for mapped nodes.
5. Run validation (only counting errors and warnings, without full messages).

**Result:**

```text
Graph: my-project
Nodes: 12 (3 modules, 7 services, 2 libraries) + 2 blackbox
Relations: 15 structural, 4 event
Aspects: 3    Flows: 2    Knowledge: 8
Drift: 1 drift, 1 missing, 2 unmaterialized, 8 ok
Validation: 0 errors, 3 warnings
```

**Errors:**

- No `.yggdrasil/` — repository is not initialized.
- Invalid `config.yaml` — configuration cannot be parsed.

---

### Ownership resolution

Finds the owner node for a given file path.

**Parameters:**

| Parameter | Type   | Required | Description                               |
| --------- | ------ | -------- | ----------------------------------------- |
| `file`    | string | Yes      | File path relative to the repository root |

**Behavior:**

1. Traverse all nodes with a mapping.
2. For each mapping, check if the file matches:
   - `file` — path equals `mapping.path`.
   - `directory` — file lies inside `mapping.path`.
   - `files` — file is on the `mapping.paths` list.
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

Shows nodes dependent on the specified node (reverse dependencies) and optionally
simulates the impact of planned changes on context packages.

**Parameters:**

| Parameter  | Type   | Required | Description                                                       |
| ---------- | ------ | -------- | ----------------------------------------------------------------- |
| `node`     | string | Yes      | Node path relative to `model/`                                    |
| `simulate` | bool   | No       | Whether to simulate impact on context packages. Default: `false`. |

**Basic mode behavior** (`simulate: false`):

1. Find all nodes whose structural relations point to the specified node (reverse graph edge).
2. Recursively follow reverse edges (transitive reverse dependencies).
3. Find flows listing the specified node.
4. Find aspects and knowledge whose scope covers the specified node.

**Simulation mode behavior** (`simulate: true`):

1. Execute basic mode steps.
2. For each affected node, assemble a context package in the current graph state.
3. Assemble a context package in the hypothetical state (current graph + on-disk changes
   since last commit, or staged git changes).
4. Calculate differences: added/removed elements, changed dependency artifacts, budget shifts.
5. For each affected node with mapping, report drift status of mapped source files (on-disk
   changes since last `drift-sync`): ok, drift, missing, or unmaterialized.

**Basic mode result:**

```text
Impact of changes in payments/payment-service:

Directly dependent:
  <- orders/order-service (calls, you consume: charge, refund)
  <- subscriptions/billing-service (calls, you consume: charge)

Transitively dependent:
  <- orders/order-service <- checkout/checkout-controller

Flows: checkout

Total scope: 3 nodes, 1 flows
```

**Simulation mode result** (additionally):

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

- Node does not exist.

---

### Validate

Validate structural integrity and completeness signals of the entire graph or a specified node.

**Parameters:**

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `scope`   | string | No       | `all` or node path. Default: `all`. |

**Behavior:**

Two levels of severity defined in the [Engine](engine) document.

**Errors (structural integrity):**

| Code   | Message                      | Description                                            |
| ------ | ---------------------------- | ------------------------------------------------------ |
| `E001` | `invalid-node-yaml`          | `node.yaml` fails to parse or lacks required fields    |
| `E002` | `unknown-node-type`          | Node type is not in `config.node_types`                |
| `E003` | `unknown-tag`                | Tag is not in `config.tags`                            |
| `E004` | `broken-relation`            | Relation target does not resolve to an existing node   |
| `E005` | `broken-knowledge-ref`       | Knowledge reference does not resolve                   |
| `E006` | `broken-flow-ref`            | Flow participant does not resolve                      |
| `E007` | `broken-aspect-tag`          | Aspect tag does not exist in configuration             |
| `E008` | `broken-scope-ref`           | Reference in knowledge scope does not resolve          |
| `E009` | `overlapping-mapping`        | Two nodes map to the same file/directory               |
| `E010` | `structural-cycle`           | Cycle in structural relations (cycles involving blackbox are tolerated) |
| `E011` | `unknown-knowledge-category` | Subdirectory in `knowledge/` does not match a category |
| `E012` | `invalid-config`             | `config.yaml` fails to parse or is invalid             |
| `E013` | `invalid-artifact-condition` | Condition `has_tag:<name>` refers to an undefined tag  |
| `E014` | `duplicate-aspect-binding`   | Tag is bound to multiple aspects                       |
| `E015` | `missing-node-yaml`          | Directory in `model/` has content but no `node.yaml`   |
| `E017` | `missing-knowledge-category-dir` | Category in config has no corresponding `knowledge/<category>/` directory |

**Warnings (completeness signals):**

| Code   | Message                 | Description                                                                         |
| ------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `W001` | `missing-artifact`      | Missing required artifact                                                           |
| `W002` | `shallow-artifact`      | Artifact below minimum length                                                       |
| `W003` | `unreachable-knowledge` | Knowledge element does not reach any context package                                |
| `W004` | `missing-example`       | Pattern without an example file                                                     |
| `W005` | `budget-warning`        | Context package exceeds warning threshold                                           |
| `W006` | `budget-error`          | Context package exceeds error threshold (blocks materialization); severity: warning |
| `W007` | `high-fan-out`          | Node exceeds maximum number of relations                                            |
| `W008` | `stale-knowledge`       | Knowledge element is potentially stale                                              |
| `W009` | `unpaired-event`        | Event relation without complement on the other side                                 |

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

**Operation errors:**

- The specified node in `scope` does not exist.
- `config.yaml` fails to parse (reported as E012, not as an operation error — validation
  continues as much as it can).

---

### Drift

Detect divergences between the graph and mapped files.

**Parameters:**

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `scope`   | string | No       | `all` or node path. Default: `all`. |

**Behavior:**

1. For each mapped node (in scope):
   a. Check if mapped files exist on disk.
   b. Read mapping strategy from `node.yaml` (`mapping.type`). Calculate hash accordingly.
   c. Compare with the baseline hash in `.yggdrasil/.drift-state`.
   d. Assign state: `ok`, `drift`, `missing`, `unmaterialized`.

**States:**

| State            | Condition                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `ok`             | Hash matches — file has not changed since synchronization                                   |
| `drift`          | Hash does not match — file modified                                                         |
| `missing`        | Mapped file does not exist on disk, but a hash exists in `.drift-state`                     |
| `unmaterialized` | Node has a mapping, but the file was never created (no entry in `.drift-state` and no file) |

**Result:**

```text
Drift:
  drift    orders/order-service -> src/modules/orders/order.service.ts
           Changed files: src/modules/orders/order.service.ts
  missing  auth/token-service -> src/modules/auth/token.service.ts
  unmat.   notifications/email-service -> src/modules/notifications/email.service.ts
  ok       payments/payment-service -> src/modules/payments/payment.service.ts
  ok       inventory/inventory-service -> src/modules/inventory/inventory.service.ts
  ... (each mapped node listed separately)

Summary: 1 drift, 1 missing, 1 unmaterialized, 8 ok
```

For `directory` and `files` mappings, the result includes a list of specific
files that changed (calculated on the fly by comparing individual hashes, even if
`.drift-state` stores a single canonical hash).

**Errors:**

- Specified node does not exist.
- Node has no mapping (does not participate in drift detection).

---

### Drift sync

Update the remembered hash for a node after resolving a divergence.
Called after the agent resolves drift (absorption or rejection + re-materialization).

**Parameters:**

| Parameter | Type   | Required | Description                    |
| --------- | ------ | -------- | ------------------------------ |
| `node`    | string | Yes      | Node path relative to `model/` |

**Behavior:**

1. Calculate the current hash of mapped files (using `mapping.type` from `node.yaml`).
2. Write the hash (and optionally per-file hashes for diagnostics) to `.yggdrasil/.drift-state`.

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

1. If `.yggdrasil/.journal.yaml` does not exist — nothing to archive.
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

| Platform      | File                                                  |
| ------------- | ----------------------------------------------------- |
| `cursor`      | `.cursor/rules/yggdrasil.mdc`                         |
| `claude-code` | `CLAUDE.md` (imports `.yggdrasil/agent-rules.md`)     |
| `copilot`     | `.github/copilot-instructions.md` (Yggdrasil section) |
| `cline`       | Platform-specific (uses `agent-rules.md`)             |
| `roocode`     | Platform-specific (uses `agent-rules.md`)             |
| `codex`       | Platform-specific (uses `agent-rules.md`)             |
| `windsurf`    | Platform-specific (uses `agent-rules.md`)             |
| `aider`       | Platform-specific (uses `agent-rules.md`)             |
| `gemini`      | Platform-specific (uses `agent-rules.md`)             |
| `amp`         | Platform-specific (uses `agent-rules.md`)             |
| `generic`     | `.yggdrasil/agent-rules.md`                           |

The content is identical regardless of the platform — only the location and any wrapper
(frontmatter, section in an existing file, etc.) differ.

### Rules content

The canonical agent rules are delivered by the platform integration file generated from
`source/cli/src/templates/rules.ts`. The full prompt is not duplicated here — the spec
documents the behavioral contract; the implementation provides the canonical text.

**Behavioral model (no explicit "session"):**

- **Start of every conversation:** Preflight — (1) `yg journal-read` (consolidate, archive if entries exist),
  (2) `yg drift` (present states `ok`/`drift`/`missing`/`unmaterialized`, ask absorb or reject),
  (3) `yg status` (report health), (4) `yg validate` (if W008, update knowledge artifacts).
  _Exception:_ Read-only requests run only step 1.
- **User signals closing the topic** (e.g. "we're done", "wrap up", "that's enough", "done"): Consolidate journal (if used),
  archive, drift, validate, report exactly what nodes and files were changed.
- **Execution checklists:** Code-first (read spec → modify code → sync artifacts → baseline hash) and graph-first
  (read schema → edit graph → verify source → validate → baseline hash). Agent must output and execute before finishing.

The agent learns **how** from five sources: (1) rules file, (2) config.yaml, (3) templates/ (schemas),
(4) existing graph nodes, (5) validation feedback. See the [Integration](integration) document.
