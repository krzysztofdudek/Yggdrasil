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
  config.yaml
  model/
  aspects/
  flows/
  schemas/
```

- `config.yaml` — configuration and schema for the graph.
- `model/` — semantic model of the system: components and their relationships.
- `aspects/` — cross-cutting requirements.
- `flows/` — end-to-end flows spanning multiple nodes.
- `schemas/` — schemas for each graph layer (node, aspect, flow).

The graph is semantic memory, not implementation. It describes what the repository **means**.
Context assembly, validation, drift detection, and journal mechanics are defined in the
[Engine](engine) document.

### Reserved vs user-owned names

```text
.yggdrasil/
  config.yaml        # reserved
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

The configuration file in the graph root defines project identity, vocabulary, artifact
structure, and quality criteria. It is the **only** source of truth for what tools expect and
enforce.

```yaml
name: my-project

stack:
  language: typescript
  runtime: node
  framework: nestjs
  database: postgresql
  testing: jest

standards: |
  Strict TypeScript. All public functions have JSDoc.
  Errors in RFC 7807 format. Dates in ISO 8601 UTC.
```

- `stack` declares the technology context.
- `standards` describes global conventions.

Both are attached to every context package as **global context**.

### Node types

```yaml
node_types:
  - name: module
  - name: service
    required_aspects: [requires-audit]
  - name: repository
  - name: controller
  - name: gateway
  - name: library
  - name: external
```

Node types classify the architectural _role_ of each node. Each entry has `name` (the type
identifier) and optional `required_aspects` — aspects that nodes of this type must have coverage for
(directly or via aspect `implies`). Legacy format `node_types: [module, service, ...]` — a list
of strings — is supported and maps to `{ name: module }`, etc.

Templates (see below) can be bound to node types, providing structural hints for scaffolding.
Tools validate that every node declares a type from this list.

### Artifact types

```yaml
artifacts:
  responsibility.md:
    required: always
    description: What this node is responsible for, and what it is not
    structural_context: true

  interface.md:
    required:
      when: has_incoming_relations
    description: Public API — methods, parameters, return types, contracts
    structural_context: true

  logic.md:
    required: never
    description: Algorithmic flow, control flow, branching logic, decision trees — the 'how' of execution

  constraints.md:
    required: never
    description: Validation rules, business rules, invariants
    structural_context: true

  errors.md:
    required:
      when: has_incoming_relations
    description: Failure modes, edge cases, error conditions, recovery behavior
    structural_context: true

  model.md:
    required: never
    description: Data structures, schemas, entities, type definitions — the shape of data this node owns or manages

  state.md:
    required: never
    description: State machines, lifecycle, transitions

  decisions.md:
    required: never
    description: Local design decisions and rationale — choices specific to this node, not system-wide
```

Artifact types are content files that nodes may contain. Each artifact key is the **full filename**
of a file placed next to `node.yaml`. Configuration defines:

- **Key** — full filename (e.g. `responsibility.md`, `api.txt`). Any extension; content must be
  encodable as UTF-8 text for context assembly.
- **Required condition** — when this artifact must be present:
  - `always` — every non-blackbox node must have it.
  - `never` — always optional.
  - `when ...` — conditional on graph structure, such as `has_incoming_relations`,
    `has_outgoing_relations`, `has_aspect:<name>` (legacy `has_tag:<name>` also accepted).
- **Description** — what the artifact captures. This text is available to agents via tool
  feedback when creating or validating nodes.

The above list is a default configuration that covers most projects. Projects can add
domain-specific artifacts:

```yaml
artifacts:
  compliance.md:
    required:
      when: has_aspect:regulated
    description: Regulatory requirements and constraints

  performance.txt:
    required:
      when: has_aspect:high-throughput
    description: Performance budgets, SLAs, optimization constraints
```

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

Every directory inside `model/` that contains a `node.yaml` file is a **node**. Nesting creates
hierarchy. Hierarchy carries meaning: a child node inherits the domain context of its parent
during context assembly.

```text
model/
  auth/                     # module node (parent)
    node.yaml
    responsibility.md

    login-service/          # service node (child of auth)
      node.yaml
      responsibility.md

  orders/                   # module node
    node.yaml

    order-service/          # service node (child of orders)
      node.yaml
      responsibility.md
```

A module node provides **domain context** — business domain, high-level rules — that all its
children inherit. A child node can never be fully understood without its parent — the
context assembly algorithm guarantees this.

### Node metadata (`node.yaml`)

`node.yaml` defines the node's identity and all its outgoing connections:

```yaml
name: OrderService
type: service

aspects:
  - requires-audit
  - requires-auth

relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge, refund]
    failure: retry 3x, then mark order as payment-failed

  - target: inventory/inventory-service
    type: calls
    consumes: [reserve, release]

mapping:
  paths:
    - src/modules/orders/order.service.ts
```

| Field       | Required | Purpose                                                      |
| ----------- | -------- | ------------------------------------------------------------ |
| `name`      | Yes      | Display name                                                 |
| `type`      | Yes      | Node type from `config.node_types`                          |
| `aspects`   | No       | Aspect identifiers linking node to aspects                   |
| `relations` | No       | Outgoing dependencies to other nodes                         |
| `mapping`   | No       | Link to source files (see Mapping section)                   |
| `blackbox`  | No       | If `true`, node describes something existing, not controlled |

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
  receive their artifacts (`interface`, `errors`) in their own context packages.
- They are **excluded** from materialization ordering — their outputs (if mapped) are whatever
  they are; the graph does not control them.

Blackbox nodes are key for incremental adoption: describe an existing module as a blackbox,
and new nodes immediately get the semantic context of its interface, even if that context
is coarse.

### Content artifacts

Content artifacts are text files placed next to `node.yaml`. Which artifacts exist and
when they are required is defined by configuration. Each config key is the full filename
(e.g. `responsibility.md`, `api.txt`). Content must be UTF-8 encodable for context assembly.

| File                | Purpose                                                              | Default requirement                        |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `responsibility.md` | What the node is responsible for, and what it is not                 | Required always                            |
| `interface.md`      | Public API — methods, parameters, return types, contracts            | Required when someone depends on this node |
| `logic.md`          | Algorithmic flow, control flow, branching logic                      | Optional                                   |
| `constraints.md`    | Validation rules, business rules, invariants                         | Optional                                   |
| `errors.md`         | Failure modes, edge cases, error conditions, recovery behavior       | Required when someone depends on this node |
| `model.md`          | Data structures, schemas, entities, type definitions                 | Optional                                   |
| `state.md`          | State machines, lifecycle, transitions                                | Optional                                   |
| `decisions.md`      | Local design decisions and rationale — choices specific to this node  | Optional                                   |

A simple utility node might have only `responsibility.md`. A complex service may have all eight,
plus project-specific artifacts (any filename in config). The self-calibrating granularity
principle from the [Foundation](foundation) document applies: add detail where the agent
produces bad outputs without it.

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
contains `aspect.yaml` and content files.

```text
aspects/
  requires-audit/
    aspect.yaml
    content.md
  observability/
    logging/
      aspect.yaml
      requirements.md
```

```yaml
# aspects/requires-audit/aspect.yaml
name: Audit logging
description: "Short description for discovery via yg aspects"  # optional
# implies: [requires-logging]   # optional: other aspect identifiers to include automatically
```

`name` is required. `description` is optional — a short summary for discovery via `yg aspects`.
`implies` is optional. The aspect identifier is implicit — it is the relative directory path.

Nested directories under `aspects/` are organizational — they allow grouping related aspects
(e.g. `observability/logging`, `observability/tracing`). However, nesting does **not** create
automatic parent-child relationships. The `implies` field is always explicit — if
`observability/logging` should imply `observability/tracing`, it must declare so in its
`aspect.yaml`.

An aspect may declare `implies` — a list of identifiers of other aspects to include
automatically. This enables composition: a bundle aspect (e.g. `hipaa`) can include several
sub-aspects.

```yaml
# aspects/hipaa/aspect.yaml
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
`aspect.yaml`) to those nodes' context packages. Run `yg aspects` to list valid aspect
identifiers.

Aspects encode requirements that cut **horizontally** across the system: security, audit,
caching, rate limiting, logging conventions. Without aspects, these requirements would have
to be repeated in every affected node's artifacts. With aspects, they are declared once and
distributed automatically.

Each aspect is bound to a single identifier. Aspects impose **obligations** and are tied to
**need identifiers** like `requires-audit`, `requires-auth`.

If a requirement concerns multiple roles, the solution is a separate aspect
(e.g. `requires-rate-limiting`) applied to appropriate nodes, not expanding a single aspect
across many unrelated identifiers.

---

## Flows: End-to-End Processes

A **flow** describes a process spanning multiple nodes. Each flow is a directory containing
`flow.yaml` and content artifacts.

```text
flows/
  checkout/
    flow.yaml
    description.md
    sequence.md
```

```yaml
# flows/checkout/flow.yaml
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

- `nodes` lists flow participants — paths are relative to `model/`.
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
- `## Participants` — nodes involved (align with `flow.yaml` nodes)
- `## Paths` — **required**; must contain at least `### Happy path`; each other business path (cancellation, payment failure, timeout, partial fulfillment) gets its own `### [name]` subsection
- `## Invariants across all paths` — business rules and technical conditions that hold regardless of path

Example variant names: `### Payment failed`, `### User cancellation`, `### Timeout`, `### Partial fulfillment`

---

## Path Conventions

Every reference in the graph uses short, relative paths. Tools know the base directory for each
reference type.

| Location                       | Relative to        | Example value              |
| ------------------------------ | ------------------ | -------------------------- |
| `node.yaml` `relations.target` | `model/`           | `payments/payment-service` |
| `flow.yaml` `nodes`            | `model/`           | `orders/order-service`     |
| Aspect identifier             | Relative path under `aspects/` | `requires-audit`           |

No ambiguity. No absolute paths. No guessing which directory a reference points to.

---

## Mapping: Graph to Source

Nodes in the graph can be mapped to source files via declarations in `node.yaml`. Mapping enables
two things:

- Ownership lookup — which node owns a given file.
- Drift detection — did the file change since last synchronization.

### Mapping format

Mapping uses a `paths` array listing one or more file or directory paths:

**Single file:**

```yaml
mapping:
  paths:
    - src/modules/orders/order.service.ts
```

**Directory** — all files in the directory belong to the node:

```yaml
mapping:
  paths:
    - src/modules/orders
```

More robust to internal changes — adding, renaming, or deleting files inside the directory does
not break the mapping.

**Multiple files** — implementation spans multiple files in different directories:

```yaml
mapping:
  paths:
    - src/modules/orders/order.service.ts
    - src/modules/orders/order.repository.ts
    - src/shared/orders/order.types.ts
```

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

| File          | Element type | Purpose                                                |
| ------------- | ------------ | ------------------------------------------------------ |
| `node.yaml`   | Nodes        | Structure of `node.yaml` in model directories           |
| `aspect.yaml` | Aspects      | Structure of `aspect.yaml` in aspects directories       |
| `flow.yaml`   | Flows        | Structure of `flow.yaml` in flows directories           |

These are generalized schemas, not type-specific examples. The agent consults the schema for the
element type it is creating or editing. Artifact requirements and structure come from
`config.yaml`; the schema shows the YAML shape.

---

## Partial Graphs and Coverage Contract

The repository is **intended** to be fully covered by the graph. Every file (except `.yggdrasil/`)
belongs to exactly one node — directly or via a higher-level blackbox node. If an area is not yet
explored, coverage is achieved through a blackbox at a level agreed with the user — **but only for
existing code**. For greenfield (new code to be created), use proper nodes from the start; blackbox
is forbidden.

Tools operate only on declared nodes. Undeclared parts are invisible to the graph — but that is a
**temporary** state. When the agent enters an uncovered area, it must not edit code without an
explicit decision. **If greenfield:** create proper nodes (reverse engineering or upfront design);
do not offer blackbox. **If existing code:** user chooses reverse-engineer (full node), blackbox
(at chosen granularity), or abort.

Consequence for data structures:

- All higher-level mechanisms — aspects, mappings, flows — operate only on
  declared nodes.
- **Blackbox is a first-class mechanism** for "we do not explore yet, but we need an owner."
  Use it for existing code when the user chooses not to reverse-engineer. Not for greenfield.
  Granularity (directory, module, etc.) is the user's choice.
