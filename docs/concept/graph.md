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
  yg-secrets.yaml          # gitignored — API keys and provider overrides
  model/
  aspects/
  flows/
  schemas/
```

- `yg-config.yaml` — configuration and schema for the graph.
- `yg-secrets.yaml` — gitignored file that overrides `yg-config.yaml` reviewer fields (API keys,
  provider, endpoint). Never committed.
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
  yg-secrets.yaml    # reserved (gitignored)
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

### Node types

Node types are defined in the **architecture file** (`.yggdrasil/yg-architecture.yaml`), not in
`yg-config.yaml`. Each type classifies the architectural _role_ of a node. See the
[Architecture File](#architecture-file) section for the full format, including `aspects`,
`parents`, and `relations` constraints.

Tools validate that every node declares a type that is a key in the architecture file's
`node_types` object.

### Reviewer configuration

```yaml
reviewer:
  verify_aspects: true
  consensus: 1
  ollama:
    model: qwen3.5:9b
    endpoint: http://localhost:11434
    temperature: 0.0
    max_tokens: auto
```

The `reviewer` section configures the semantic verifier used for aspect verification at
approve time. General keys (`verify_aspects`, `consensus`) sit at the `reviewer:` level.
Provider-specific keys sit under the provider name (`ollama:`, `claude-code:`).

| Field            | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `verify_aspects` | Run aspect verification — default true                               |
| `consensus`      | Number of agreeing verification passes required (default 1)          |
| `active`         | Required when multiple providers configured — selects the active one |

Provider keys (`ollama:`, `claude-code:`) contain provider-specific settings (model, endpoint,
temperature, max_tokens). See the [Configuration](../configuration.md) page for full details.

#### Secrets (`yg-secrets.yaml`)

Sensitive fields — API keys, endpoint overrides — belong in `yg-secrets.yaml`, which lives
alongside `yg-config.yaml` but is **gitignored**. Fields in `yg-secrets.yaml` override the
corresponding provider-specific fields at runtime.

```yaml
# .yggdrasil/yg-secrets.yaml (gitignored)
reviewer:
  ollama:
    endpoint: http://localhost:11434
    model: qwen3.5:9b
```

This separation keeps configuration declarative and committable while secrets stay local.

### Quality thresholds

```yaml
quality:
  max_direct_relations: 10
```

Quality thresholds are measurable limits enforced by tools:

- **Maximum direct relations** — nodes exceeding the threshold trigger a warning
  (likely too many responsibilities).

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

    login-service/          # service node (child of auth)
      yg-node.yaml

  orders/                   # module node
    yg-node.yaml

    order-service/          # service node (child of orders)
      yg-node.yaml
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

aspects: [requires-audit, requires-auth]

ports:                    # optional — typed contracts this node exposes for consumers
  correlation-id:
    description: "Caller must propagate a correlation ID on every request"
    aspects: [correlation-tracking]
  retry-policy:
    description: "Caller must implement retry with backoff on transient failures"
    aspects: [retry-backoff]

relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge, refund, correlation-id]  # includes port names from the target

  - target: inventory/inventory-service
    type: calls
    consumes: [reserve, release]

mapping:
  - src/modules/orders/order.service.ts
```

| Field         | Required | Purpose                                                      |
| ------------- | -------- | ------------------------------------------------------------ |
| `name`        | Yes      | Display name                                                 |
| `type`        | Yes      | Node type from `config.node_types`                           |
| `description` | No       | Short summary shown in context maps for quick orientation    |
| `aspects`     | No       | Aspect entries (list of aspect identifiers)                  |
| `ports`       | No       | Typed contracts consumers must satisfy (replaces integration_anchors) |
| `relations`   | No       | Outgoing dependencies to other nodes                         |
| `mapping`     | No       | Flat list of source file/directory paths (see Mapping section) |
| `blackbox`    | No       | If `true`, node describes something existing, not controlled |

#### Blackbox nodes

```yaml
blackbox: true
```

A node with `blackbox: true` describes something that **exists** but is not fully explored by the
graph: existing code, external APIs, infrastructure, legacy modules. Information about a
blackbox node can be incomplete or coarse — this is expected, not an error.

**Blackbox is for existing code only.** Do not use blackbox for greenfield (empty directory,
new project, code not yet written). For new code, create proper nodes from the start.

- Blackbox nodes skip LLM aspect verification at approve time.
- They **do** participate in the relation graph — other nodes can depend on them.
- Source changes under a blackbox node cause approve to refuse — decompose to a proper node.

Blackbox nodes are key for incremental adoption: describe an existing module as a blackbox,
and new nodes immediately get the semantic context of its interface, even if that context
is coarse.

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
    consumes: [charge, refund, correlation-id]
```

| Field      | Required | Purpose                                                     |
| ---------- | -------- | ----------------------------------------------------------- |
| `target`   | Yes      | Path to target node, relative to `model/`                   |
| `type`     | Yes      | Relation type from tables above                             |
| `consumes` | No       | Port names on the target (only valid when target has ports) |

The `consumes` field references **port names** on the target node. It is only valid when the
target declares ports — `consumes-without-ports` fires if `consumes` is declared on a relation
to a target without ports. The relation itself (`target` + `type`) is sufficient to express the
dependency; `consumes` adds port-level specificity.

When a port name appears in `consumes`, the caller declares that it uses that port's
contract. Tools attach full interface content along with annotations indicating which ports
are consumed. The `consumes` field is not used on event relations (`emits`, `listens`).

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
```

`name` is required. `description` is optional — a short summary for discovery via `yg aspects`.
`implies` is optional. The aspect identifier is implicit — it is the relative directory path.
Aspect content lives in `.md` files alongside the YAML — these describe the requirements that
source files must satisfy. Verification is performed by the reviewer at approve time.

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
to be repeated in every affected node. With aspects, they are declared once and
distributed automatically.

Each aspect is bound to a single identifier. Aspects impose **obligations** and are tied to
**need identifiers** like `requires-audit`, `requires-auth`.

If a requirement concerns multiple roles, the solution is a separate aspect
(e.g. `requires-rate-limiting`) applied to appropriate nodes, not expanding a single aspect
across many unrelated identifiers.

---

## Flows: End-to-End Processes

A **flow** describes a process spanning multiple nodes. Each flow is a directory containing
`yg-flow.yaml`.

```text
flows/
  checkout/
    yg-flow.yaml
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

- `nodes` lists flow participants — paths are relative to `model/`. `participants` is accepted as an alias.
- `aspects` (optional) lists aspect identifiers; those aspects propagate to all participants.
  Every participant receives these aspects in its context package (with `source="flow:Name"`)
  even if the node itself does not carry the aspect.

Flows capture process-level requirements that belong to **no single node**. Flow-level aspects
propagate enforceable rules to all participants. The `description` field in `yg-flow.yaml`
provides a brief summary of the business process for orientation.

---

## Architecture File

The architecture file (`.yggdrasil/yg-architecture.yaml`) defines node type constraints and
requirements. It is **separate from** `yg-config.yaml`.

### Purpose

The architecture file enforces architectural guardrails at the graph level:

- **Node type constraints** — what kinds of nodes can relate to each other, which parent types
  are allowed, what aspects every node of a type must carry.
- **Propagating requirements** — aspects required at the type level automatically apply to
  every node of that type.

Integration contracts (what consumers must prove) are defined per-node via `ports`, not at
the architecture level. See the Node metadata section.

### Architecture file format

```yaml
node_types:
  service:
    description: "Request-handling module with external contracts"
    aspects: [requires-auth, error-format]          # required on every node of this type
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

| Field             | Purpose                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `description`     | Required. What this type of node is for (agent guidance)                               |
| `aspects`         | Optional. Aspect IDs required on every node of this type                               |
| `parents`         | Optional. Whitelist of allowed parent node types                                       |
| `relations`       | Optional. Allowed target types by relation type (calls, uses, etc.)                    |

Integration contracts are no longer defined at the architecture level. Instead, each node
declares its own `ports` — typed contracts that consumers must satisfy. This moves integration
requirements closer to the nodes that define them. See the Node metadata section for the
`ports` field.

**Semantics:**

- When a node has `type: service` and the architecture declares `aspects: [requires-auth]`,
  the node must carry the `requires-auth` aspect.
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
any target type. If `relations.calls` IS defined (as a whitelist), the target type must be in
the list.

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
two things:

- Ownership lookup — which node owns a given file.
- Drift detection — did the file change since last synchronization.

Aspect verification is handled separately by the reviewer at approve time (see Aspects section).

### Mapping format

Mapping is a **flat list of paths** — files or directories relative to the repository root.

```yaml
mapping:
  - src/routes/expenses.ts
  - src/services/expenses.ts
```

**Single file:**

```yaml
mapping:
  - src/modules/orders/order.service.ts
```

**Directory** — all files recursively:

```yaml
mapping:
  - src/modules/orders
```

More robust to internal changes — adding or deleting files inside the directory automatically
includes/excludes them from the mapping without updating the declaration.

**Multiple paths:**

```yaml
mapping:
  - src/routes/orders.ts
  - src/routes/payments.ts
```

**No mapping** — node exists purely for semantic memory and is not mapped to any file. Module
nodes, abstract concepts, and planning nodes may be unmapped. The `mapping` field is simply
absent. Drift detection does not apply to unmapped nodes.

The previous group-based mapping (with per-group aspects and regex anchors) has been replaced
by this flat structure. Aspect compliance is no longer proven through regex patterns in mapping
groups. Instead, aspect requirements are verified by the reviewer during `yg approve`, which reads the
aspect content files and evaluates them against source code. This moves complexity from the mapping
declaration to the verification layer.

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
description, aspects, relations — remains intact. Semantic memory survives refactoring
even when mapping temporarily does not.

---

## Schemas for Graph Layers

The `schemas/` directory contains schema files — one per graph layer. Each file shows the
expected structure of its element type. The agent reads the appropriate schema before creating
or editing that element.

| File                | Element type   | Purpose                                                     |
| ------------------- | -------------- | ----------------------------------------------------------- |
| `yg-node.yaml`     | Nodes          | Structure of `yg-node.yaml` in model directories            |
| `yg-aspect.yaml`   | Aspects        | Structure of `yg-aspect.yaml` in aspects directories        |
| `yg-flow.yaml`     | Flows          | Structure of `yg-flow.yaml` in flows directories            |
| `yg-config.yaml`   | Configuration  | Structure of the project configuration file                 |
| `yg-secrets.yaml`  | Secrets        | Structure of the gitignored secrets override file            |

These are generalized schemas, not type-specific examples. The agent consults the schema for the
element type it is creating or editing.

---

## Coverage Contract

The repository **must** be fully covered by the graph. Every git-tracked file (except
`.yggdrasil/`) belongs to exactly one node — directly or via a higher-level blackbox node.
`yg check` enforces this through `unmapped-files` — any uncovered file is an error.

**Blackbox-first adoption:** On day one, the agent establishes full coverage by blackboxing the
entire repository at coarse granularity (a few large directory mappings). This clears
`unmapped-files` immediately. As work touches specific areas, blackbox nodes are decomposed
into proper nodes. The blackbox blocker enforces decomposition: when source files change
inside a blackbox, `yg approve` refuses until the agent creates proper nodes for those files.

For greenfield (new code to be created), use proper nodes from the start; blackbox
is forbidden.

Consequence for data structures:

- All higher-level mechanisms — aspects, mappings, flows — operate only on
  declared nodes.
- **Blackbox is a first-class mechanism** for "we do not explore yet, but we need an owner."
  Use it for existing code when the user chooses not to reverse-engineer. Not for greenfield.
  Granularity (directory, module, etc.) is the user's choice.
