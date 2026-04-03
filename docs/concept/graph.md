# Graph

This document defines the structure of the semantic memory graph.

Every piece of context that reaches an agent must arrive there through an explicit,
declared, tool-verifiable connection. The agent never "goes hunting" for context on its own —
tools mechanically assemble it from declarations. If content has no declared path
to a node, it does not exist for that node's context. This is the fundamental contract of the
graph: **deterministic discoverability**.

---

## Top-Level Directory Structure

Semantic memory lives under `.yggdrasil/`.

```text
.yggdrasil/
  yg-config.yaml
  model/
  aspects/
  flows/
  schemas/
```

- `yg-config.yaml` — configuration and schema for the graph.
- `model/` — semantic model of the system: components and their relationships.
- `aspects/` — cross-cutting requirements.
- `flows/` — end-to-end flows spanning multiple nodes.
- `schemas/` — schemas for each graph layer (node, aspect, flow).

The graph is semantic memory, not implementation. It describes what the repository **means**.
Context assembly, validation, and drift detection are defined in the
[Engine](engine) document.

### Reserved vs user-owned names

```text
.yggdrasil/
  yg-config.yaml     # reserved
  model/             # reserved
  aspects/           # reserved
  flows/             # reserved
  schemas/           # reserved
```

User-defined node names live only inside `model/`. There is no risk of name collisions with
reserved top-level directories.

| Directory    | Contains                                 | Collides with user names? |
| ------------ | ---------------------------------------- | ------------------------- |
| `model/`     | Graph components: the semantic structure | No — user names live here |
| `aspects/`   | Cross-cutting requirements               | Reserved                  |
| `flows/`     | End-to-end flows across nodes            | Reserved                  |
| `schemas/`   | Schemas for graph layers (node, aspect, flow) | Reserved                  |

---

## Configuration

The configuration file in the graph root defines project identity, vocabulary, and quality
criteria. It is the **only** source of truth for what tools expect and enforce.

```yaml
name: my-project
```

Technology stack and coding standards are described in node artifacts at the appropriate hierarchy level — not in yg-config.yaml.

### Node types

```yaml
node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
    required_aspects: [requires-audit]
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors — invisible in call graphs but affect blast radius"
```

Node types classify the architectural _role_ of each node. Each entry is keyed by type name
and must have a `description` (agent guidance for when to use this type) and optional
`required_aspects` — aspects that nodes of this type must have coverage for (directly or via
aspect `implies`).

Templates (see below) can be bound to node types, providing structural hints for scaffolding.
Tools validate that every node declares a type that is a key in this object.

### Artifact types

The three standard artifacts (`responsibility.md`, `interface.md`, `internals.md`) are built
into the CLI. They are not configurable — the CLI defines their required conditions and
descriptions internally.

- **`responsibility.md`** — always required. What this node is responsible for, and what it is not.
- **`interface.md`** — required when the node has incoming relations. Public API: methods,
  parameters, return types, contracts, failure modes, exposed data structures.
- **`internals.md`** — always optional. How the node works and why: algorithms, business rules,
  state machines, design decisions with rejected alternatives.

Tools validate artifact presence based on these rules and attach artifact content to context
packages.

### Quality thresholds

```yaml
quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
```

Quality thresholds are measurable limits enforced by tools:

- **Minimum artifact length** — artifacts shorter than the threshold trigger a warning
  (likely shallow content).
- **Maximum direct relations** — nodes exceeding the threshold trigger a warning
  (likely too many responsibilities).
- **Context budget** — token limits for context packages:
  - `warning` signals growing complexity.
  - `error` blocks materialization: the node must be split.

Configuration controls **what** material the engine works with. The engine itself — the context
assembly algorithm, referential integrity — is fixed. The system is predictable:
the same algorithm over different material produces different packages, but the algorithm is
always the same.

#### What is not configurable

- The context assembly algorithm — ordered steps that collect content into a package.
  Only the material those steps operate on is configurable.
- Referential integrity — every reference in the graph must resolve. Broken references are
  always errors.

---

## Component Model

Every directory inside `model/` that contains a `yg-node.yaml` file is a **node**. Nesting creates
hierarchy. Hierarchy carries meaning: a child node inherits the domain context of its parent
during context assembly.

```text
model/
  auth/                     # module node (parent)
    yg-node.yaml
    responsibility.md

    login-service/          # service node (child of auth)
      yg-node.yaml
      responsibility.md

  orders/                   # module node
    yg-node.yaml

    order-service/          # service node (child of orders)
      yg-node.yaml
      responsibility.md
```

A module node provides **domain context** — business domain, high-level rules — that all its
children inherit. A child node can never be fully understood without its parent — the
context assembly algorithm guarantees this.

### Node metadata (`yg-node.yaml`)

`yg-node.yaml` defines the node's identity and all its outgoing connections:

```yaml
name: OrderService
type: service
description: "Manages order lifecycle from placement to fulfilment"  # optional

aspects:
  - aspect: requires-audit
    exceptions:
      - "Batch import skips per-record audit — emits single summary event instead"
    anchors:  # map: anchor ID → typed realization object
      audit-entry:
        regex: "createAuditLog|auditLog\\.create"
      audit-actor:
        regex: "userId|currentUser|actor"
  - aspect: requires-auth

integration_anchors:  # optional — anchor IDs that consumers must realize
  - correlation-id
  - retry-policy

relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge, refund]
    failure: retry 3x, then mark order as payment-failed
    anchors:  # realizes integration anchors from the target
      correlation-id:
        regex: "correlationId|correlation_id"
      retry-policy:
        regex: "retry|retryPolicy|withRetry"

  - target: inventory/inventory-service
    type: calls
    consumes: [reserve, release]

mapping:
  paths:
    - src/modules/orders/order.service.ts
```

| Field                  | Required | Purpose                                                      |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `name`                 | Yes      | Display name                                                 |
| `type`                 | Yes      | Node type from `config.node_types`                           |
| `description`          | No       | Short summary shown in context maps for quick orientation    |
| `aspects`              | No       | Aspect entries with exceptions and typed anchor realizations |
| `integration_anchors`  | No       | Anchor IDs that consumers (relation sources) must realize    |
| `relations`            | No       | Outgoing dependencies to other nodes, with anchor realizations |
| `mapping`              | No       | Link to source files (see Mapping section)                   |
| `blackbox`             | No       | If `true`, node describes something existing, not controlled |

Each block (hierarchy, own, flow) declares its own aspects. No inheritance — a node receives
aspects only from blocks that explicitly list aspect identifiers. See the [Engine](engine) document for the
assembly algorithm.

#### Blackbox nodes

```yaml
blackbox: true
```

A node with `blackbox: true` describes something that **exists** but is not fully explored by the
graph: existing code, external APIs, infrastructure, legacy modules. Information about a
blackbox node can be incomplete or coarse — this is expected, not an error.

**Blackbox is for existing code only.** Do not use blackbox for greenfield (empty directory,
new project, code not yet written). For new code, create proper nodes from the start.

- Blackbox nodes do **not** participate in materialization — they are not generated from
  the graph.
- They are **not** checked for context budget — they do not produce a package for generation.
- They **do** participate in the relation graph — other nodes can depend on them and will
  receive their artifacts (those with `included_in_relations: true`) in their own context packages.
- They are **excluded** from materialization ordering — their outputs (if mapped) are whatever
  they are; the graph does not control them.

Blackbox nodes are key for incremental adoption: describe an existing module as a blackbox,
and new nodes immediately get the semantic context of its interface, even if that context
is coarse.

### Content artifacts

Content artifacts are text files placed next to `yg-node.yaml`. The three standard artifacts
are built into the CLI. Content must be UTF-8 encodable for context assembly.

| File                | Purpose                                                                                              | Requirement                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `responsibility.md` | What the node is responsible for, and what it is not                                                  | Required always                            |
| `interface.md`      | Public API — methods, parameters, return types, contracts, failure modes, exposed data structures     | Required when someone depends on this node |
| `internals.md`      | How the node works and why — algorithms, business rules, state machines, design decisions with rejected alternatives | Optional                                   |

A simple utility node might have only `responsibility.md`. A complex service may have all three.
The self-calibrating granularity principle from the [Foundation](foundation) document applies:
add detail where the agent produces bad outputs without it.

### Relations

Relations declare dependencies between nodes. There are two classes with different properties:
**structural** and **event**.

#### Structural relations

Structural relations represent true implementation dependencies — a node cannot function
without its target.

| Type         | Meaning                                       |
| ------------ | --------------------------------------------- |
| `uses`       | Uses functionality provided by the target     |
| `calls`      | Calls the target's interface                  |
| `extends`    | Extends the target (inheritance, composition) |
| `implements` | Implements a contract defined by the target   |

Structural relations must be **acyclic**. A cycle in structural relations makes dependency
resolution and context assembly non-deterministic.

#### Event relations

Event relations describe asynchronous communication. They do **not** create implementation
dependencies.

| Type      | Meaning            |
| --------- | ------------------ |
| `emits`   | Produces an event  |
| `listens` | Reacts to an event |

Event relations may form cycles — an emitter does not know who listens and does not depend
on listeners. A node A emitting an event and a node B listening to it while also calling A is
not a real dependency cycle: A does not depend on B.

In context assembly, event relations provide information: _this node produces/listens to these
events_. They do not contribute edges to topological sorting.

#### Relation fields

```yaml
relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge, refund]
    failure: retry 3x, then mark order as payment-failed
```

| Field      | Required | Purpose                                   |
| ---------- | -------- | ----------------------------------------- |
| `target`   | Yes      | Path to target node, relative to `model/` |
| `type`     | Yes      | Relation type from tables above           |
| `consumes` | No       | What is consumed from the target          |
| `failure`  | No       | Behavior when dependency is unavailable   |

The `consumes` field annotates the context package. Its meaning depends on relation class:

- For structural relations (`uses`, `calls`, `extends`, `implements`) — concrete methods
  consumed from the target's interface (e.g. `charge`, `refund`). Tools attach full interface
  content along with annotations indicating which methods are used.
- For event relations (`emits`, `listens`) — specific data consumed from the event
  (e.g. `orderId`, `amount`, `status`). Tools attach event information with annotations
  describing consumed data.

The `failure` field captures what the node does when the dependency is
unavailable — critical information that cannot be inferred from code or interface alone.

---

## Aspects: Cross-Cutting Requirements

An **aspect** is a requirement that applies to every node carrying a given aspect identifier.
Each aspect is a directory under `aspects/`. The **aspect identifier equals the relative directory
path** under `aspects/` — e.g. `aspects/requires-audit/` has identifier `requires-audit`;
`aspects/observability/logging/` has identifier `observability/logging`. Each aspect directory
contains `yg-aspect.yaml` and content files.

```text
aspects/
  requires-audit/
    yg-aspect.yaml
    content.md
  observability/
    logging/
      yg-aspect.yaml
      requirements.md
```

```yaml
# aspects/requires-audit/yg-aspect.yaml
name: Audit logging
description: "Short description for discovery via yg aspects"  # optional
# implies: [requires-logging]   # optional: other aspect identifiers to include automatically
anchors:                         # required — abstract proof points nodes must realize
  - audit-entry
  - audit-actor
  - audit-timestamp
```

`name` is required. `description` is optional — a short summary for discovery via `yg aspects`.
`implies` is optional. `anchors` is required — a list of abstract anchor IDs that describe
what must be proven (E039 if missing). The aspect identifier is implicit — it is the relative
directory path.

Nested directories under `aspects/` are organizational — they allow grouping related aspects
(e.g. `observability/logging`, `observability/tracing`). However, nesting does **not** create
automatic parent-child relationships. The `implies` field is always explicit — if
`observability/logging` should imply `observability/tracing`, it must declare so in its
`yg-aspect.yaml`.

An aspect may declare `implies` — a list of identifiers of other aspects to include
automatically. This enables composition: a bundle aspect (e.g. `hipaa`) can include several
sub-aspects.

```yaml
# aspects/hipaa/yg-aspect.yaml
name: HIPAA Compliance
implies:
  - requires-audit
  - requires-encryption
  - requires-access-control
```

A node with aspect `hipaa` receives the HIPAA aspect content plus all implied aspects.
Tools resolve implications recursively and detect cycles (A implies B implies A = error).

```markdown
<!-- aspects/requires-audit/content.md -->

Every operation that modifies data must emit an audit event containing:

- actor (user ID or system identifier)
- action (create, update, delete)
- entity type and ID
- timestamp (ISO 8601 UTC)
- diff of changed fields

Audit events are published to the event bus, never written directly to the application database.
```

Binding happens through the directory path: `aspects/<id>/` defines the aspect for that
identifier. Tools resolve which nodes carry that aspect and attach all content files (except
`yg-aspect.yaml`) to those nodes' context packages. Run `yg aspects` to list valid aspect
identifiers.

Aspects encode requirements that cut **horizontally** across the system: security, audit,
caching, rate limiting, logging conventions. Without aspects, these requirements would have
to be repeated in every affected node's artifacts. With aspects, they are declared once and
distributed automatically.

Each aspect is bound to a single identifier. Aspects impose **obligations** and are tied to
**need identifiers** like `requires-audit`, `requires-auth`.

When a node follows an aspect's general pattern but has specific deviations, these are recorded
as `exceptions` within the aspect entry in `yg-node.yaml`. Each exception is a string explaining
the deviation. Exceptions appear in context packages alongside the aspect content,
preventing aspect-level abstractions from masking implementation details. See the Node metadata
section above for the YAML format.

If a requirement concerns multiple roles, the solution is a separate aspect
(e.g. `requires-rate-limiting`) applied to appropriate nodes, not expanding a single aspect
across many unrelated identifiers.

---

## Flows: End-to-End Processes

A **flow** describes a process spanning multiple nodes. Each flow is a directory containing
`yg-flow.yaml` and content artifacts.

```text
flows/
  checkout/
    yg-flow.yaml
    description.md
    sequence.md
```

```yaml
# flows/checkout/yg-flow.yaml
name: Checkout flow

nodes:
  - orders/order-service
  - payments/payment-service
  - inventory/inventory-service
  - notifications/email-service

aspects:                    # optional — aspect ids propagated to all participants
  - requires-saga
  - requires-idempotency
```

Content artifacts in the flow directory (`description.md`, `sequence.md`, etc.) describe
flow behavior, sequence, error handling, and edge cases. One flow directory represents
one business process with all its paths — happy path, exceptions, cancellations. The
`description.md` describes the full scope of that process, not just the success path.

- `nodes` lists flow participants — paths are relative to `model/`. `participants` is accepted as an alias.
- `aspects` (optional) lists aspect identifiers; those aspects propagate to all participants.
  Every participant receives these aspects in its context package (with `source="flow:Name"`)
  even if the node itself does not carry the aspect.

When assembling a context package for a node, tools attach the flow's content artifacts as
context if the node or any of its ancestors is listed as a participant.

Flows capture semantic content that belongs to **no single node**: orchestration logic,
end-to-end sequences, what happens when one participant fails. This content is essential for
implementation but lives above the component level.

### Flow description.md format

Every flow's `description.md` must include these sections:

- `## Business context` — why this process exists
- `## Trigger` — what initiates the process
- `## Goal` — what success looks like
- `## Participants` — nodes involved (align with `yg-flow.yaml` nodes)
- `## Paths` — **required**; must contain at least `### Happy path`; each other business path (cancellation, payment failure, timeout, partial fulfillment) gets its own `### [name]` subsection
- `## Invariants across all paths` — business rules and technical conditions that hold regardless of path

Example variant names: `### Payment failed`, `### User cancellation`, `### Timeout`, `### Partial fulfillment`

---

## Architecture File

The architecture file (`.yggdrasil/yg-architecture.yaml`) defines node type constraints and
requirements. It is **separate from** `yg-config.yaml`.

### Purpose

The architecture file enforces architectural guardrails at the graph level:

- **Node type constraints** — what kinds of nodes can relate to each other, which parent types
  are allowed, what aspects every node of a type must prove.
- **Integration contracts** — what aspects consumers must prove when depending on a node type.
- **Propagating requirements** — aspects required at the type level automatically flow to
  every file in nodes of that type.

### Architecture file format

```yaml
node_types:
  service:
    description: "Request-handling module with external contracts"
    aspects: [requires-auth, error-format]          # required on every file
    integration_aspects: [correlation-tracking]      # required on consumers
    parents: [module, domain]                        # allowed parent types
    relations:                                       # allowed target types
      calls: [service, library]
      uses: [library]

  library:
    description: "Shared utility with no domain knowledge"
    aspects: [deterministic]
    parents: [module]
    relations:
      uses: [library]

  module:
    description: "Business logic unit with clear domain responsibility"
```

| Field                   | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `description`           | Required. What this type of node is for (agent guidance)              |
| `aspects`               | Optional. Aspect IDs that every file of this type must prove          |
| `integration_aspects`   | Optional. Aspect IDs that consumers of this type must prove           |
| `parents`               | Optional. Whitelist of allowed parent node types                      |
| `relations`             | Optional. Allowed target types by relation type (calls, uses, etc.)   |

**Semantics:**

- When a node has `type: service` and the architecture declares `aspects: [requires-auth]`,
  every file in that node's `mapping` must prove the `requires-auth` aspect via mapping groups.
- When a node depends on a `service` node via a relation, the consumer must prove any
  `integration_aspects` declared for the `service` type.
- Absence of any field means no constraint — e.g. no `parents` field means any node type can
  be a parent.

### Relation constraints

```yaml
node_types:
  api:
    relations:
      calls: [service, library]      # api can call service or library
      uses: [library]                 # api can use library
```

If a node has `type: api` and `relations.calls` is not in the architecture, that node can call
any target type. If `relations.calls` IS defined (as a whitelist), the target type must be
in the list.

---

## Path Conventions

Every reference in the graph uses short, relative paths. Tools know the base directory for each
reference type.

| Location                           | Relative to                    | Example value              |
| ---------------------------------- | ------------------------------ | -------------------------- |
| `yg-node.yaml` `relations.target`  | `model/`                       | `payments/payment-service` |
| `yg-flow.yaml` `nodes`             | `model/`                       | `orders/order-service`     |
| Aspect identifier                  | Relative path under `aspects/` | `requires-audit`           |

No ambiguity. No absolute paths. No guessing which directory a reference points to.

---

## Mapping: Graph to Source

Nodes in the graph can be mapped to source files via declarations in `yg-node.yaml`. Mapping enables
three things:

- Ownership lookup — which node owns a given file.
- Drift detection — did the file change since last synchronization.
- Aspect proof — which files implement which aspects, and how.

### Mapping Groups

Mapping is organized into **groups**. Each group is a set of files that share the same
aspect proof profile. Different groups in the same node can prove the same aspect using
different implementations.

```yaml
mapping:
  - paths:
      - src/routes/expenses.ts
    aspects:
      - aspect: requires-auth
        anchors:
          auth-guard:
            regex: "requireAuth\\("
            rationale: "Middleware at router level before handlers."
      - aspect: error-format
        anchors:
          error-shape:
            regex: "formatError"
            rationale: "Shared error formatter in catch blocks."

  - paths:
      - src/services/expenses.ts
    aspects:
      - aspect: requires-auth
        anchors:
          auth-context:
            regex: "ctx\\.userId"
            rationale: "Receives authenticated user from route context."
      - aspect: error-format
        anchors:
          error-throw:
            regex: "AppError|throw.*Error"
            rationale: "Throws typed errors caught by route handler."
```

**Key properties:**

- Each group declares one or more file paths and the aspects that group proves.
- **Different groups, same aspect, different proof:** The first group proves `requires-auth`
  via the `requireAuth()` middleware call. The second group proves it by accessing `ctx.userId`.
  Both proofs are valid — they show different implementations of the same requirement.
- **Every file in a group must match every anchor:** If a group declares `requires-auth` with
  an anchor regex `"requireAuth\\("`, every file in that group must contain the pattern.
- **All effective aspects must be proven:** The union of aspects from all mapping groups must
  cover all effective aspects (from architecture, parent, flow, and own declarations). Missing
  aspects trigger error E050.

### Mapping group fields

```yaml
mapping:
  - paths:                       # required — list of files/directories in this group
      - src/routes/expenses.ts
      - src/routes/invoices.ts
    aspects:                     # required when effective aspects > 0
      - aspect: requires-auth    # required — aspect identifier
        anchors:                 # required — anchor ID → proof object
          auth-guard:
            regex: "requireAuth\\("   # required — regex pattern
            rationale: "..."           # required — max 2 sentences
```

**Semantics:**

- `paths` — files or directories (globs reserved for future). Every file in a directory is
  resolved at check time. All resolved files must match all anchor regexes.
- `aspects` — list of aspects this group proves. Required unless effective aspects = 0.
- `aspect` — aspect identifier from the graph.
- `anchors` — map from anchor ID to typed proof object. Every anchor ID defined in the aspect's
  `yg-aspect.yaml` must be realized. Anchor IDs are matched exactly; typos are errors (E040).
- `regex` — pattern to search for in source files. Must match in every file in the group.
- `rationale` — why this pattern proves the aspect (max 2 sentences). Helps maintainers
  understand the proof and guides agents when updating implementations.

### Paths in mapping groups

**Single file:**

```yaml
mapping:
  - paths:
      - src/modules/orders/order.service.ts
```

**Directory** — all files recursively:

```yaml
mapping:
  - paths:
      - src/modules/orders
```

More robust to internal changes — adding or deleting files inside the directory automatically
includes/excludes them from the mapping without updating the declaration.

**Multiple paths in one group:**

```yaml
mapping:
  - paths:
      - src/routes/orders.ts
      - src/routes/payments.ts
    aspects:
      - aspect: requires-auth
        anchors:
          guard:
            regex: "requireAuth\\("
            rationale: "Both route files are protected by middleware."
```

All files in the group share the same aspect proof profile.

**No mapping** — node exists purely for semantic memory and is not mapped to any file. Module
nodes, abstract concepts, and planning nodes may be unmapped. The `mapping` field is simply
absent. Drift detection does not apply to unmapped nodes.

### Mapping constraints

- **No overlaps.** No two nodes may map to the same file or overlapping directories
  (e.g. one node maps to a directory and another maps to a file inside that directory).
  Tools enforce this — overlapping mappings are errors because ownership must be unambiguous.
- **Mapping is metadata, not identity.** Moving a file does not move the node — it breaks the
  mapping. Tools detect and report broken mappings. The agent updates the mapping to reflect
  the new location.

### Mapping and refactoring

During routine refactors (rename, move), cost is low — tools report broken mappings and the agent
fixes them. During large restructurings, tools report all broken mappings at once, and the agent
fixes them in one pass.

Crucial property: refactoring never damages semantic memory. A broken mapping means tools
cannot detect drift for that node until mapping is fixed. But the node's semantic memory —
responsibility, interface, constraints — remains intact. Semantic memory survives refactoring
even when mapping temporarily does not.

---

## Schemas for Graph Layers

The `schemas/` directory contains schema files — one per graph layer. Each file shows the
expected structure of its element type. The agent reads the appropriate schema before creating
or editing that element.

| File              | Element type | Purpose                                                    |
| ----------------- | ------------ | ---------------------------------------------------------- |
| `yg-node.yaml`   | Nodes        | Structure of `yg-node.yaml` in model directories            |
| `yg-aspect.yaml` | Aspects      | Structure of `yg-aspect.yaml` in aspects directories        |
| `yg-flow.yaml`   | Flows        | Structure of `yg-flow.yaml` in flows directories            |

These are generalized schemas, not type-specific examples. The agent consults the schema for the
element type it is creating or editing. Artifact requirements and structure come from
`yg-config.yaml`; the schema shows the YAML shape.

---

## Coverage Contract

The repository **must** be fully covered by the graph. Every git-tracked file (except
`.yggdrasil/`) belongs to exactly one node — directly or via a higher-level blackbox node.
`yg check` enforces this through E022 (`unmapped-file`) — any uncovered file is an error.

**Blackbox-first adoption:** On day one, the agent establishes full coverage by blackboxing the
entire repository at coarse granularity (a few large directory mappings). This clears E022
immediately. As work touches specific areas, blackbox nodes are decomposed into proper nodes
with real artifacts. The blackbox blocker enforces decomposition: when source files change
inside a blackbox, `yg approve` refuses until the agent creates proper nodes for those files.

For greenfield (new code to be created), use proper nodes from the start; blackbox
is forbidden.

Consequence for data structures:

- All higher-level mechanisms — aspects, mappings, flows — operate only on
  declared nodes.
- **Blackbox is a first-class mechanism** for "we do not explore yet, but we need an owner."
  Use it for existing code when the user chooses not to reverse-engineer. Not for greenfield.
  Granularity (directory, module, etc.) is the user's choice.
