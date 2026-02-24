# Graph

This document defines the structure of the semantic memory graph.

Every piece of knowledge that reaches an agent's context must arrive there through an explicit,
declared, tool-verifiable connection. The agent never "goes hunting" for knowledge on its own —
tools mechanically assemble it from declarations. If a piece of knowledge has no declared path
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
  knowledge/
    decisions/
    patterns/
    invariants/
  templates/
```

- `config.yaml` — configuration and schema for the graph.
- `model/` — semantic model of the system: components and their relationships.
- `aspects/` — cross-cutting requirements bound to tags.
- `flows/` — end-to-end flows spanning multiple nodes.
- `knowledge/` — semantic knowledge that lives outside individual components.
- `templates/` — schemas for each graph layer (node, aspect, flow, knowledge).

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
  knowledge/         # reserved
  templates/         # reserved
```

User-defined node names live only inside `model/`. There is no risk of name collisions with
reserved top-level directories.

| Directory    | Contains                                 | Collides with user names? |
| ------------ | ---------------------------------------- | ------------------------- |
| `model/`     | Graph components: the semantic structure | No — user names live here |
| `aspects/`   | Cross-cutting requirements bound by tags | Reserved                  |
| `flows/`     | End-to-end flows across nodes            | Reserved                  |
| `knowledge/` | Decisions, patterns, invariants, etc.    | Reserved                  |
| `templates/` | Schemas for graph layers (node, aspect, flow, knowledge) | Reserved                  |

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

### Tags

```yaml
tags:
  - service
  - repository
  - controller
  - gateway
  - requires-audit
  - requires-auth
  - data-access
  - high-throughput
```

Tags are the project's classification vocabulary. Any tag used anywhere in the graph — on nodes,
within aspect bindings, within knowledge scopes — must be defined here. Tools reject undefined
tags. This prevents vocabulary drift and guarantees that tag-based mechanisms (aspects, scoped
knowledge) are always valid.

### Node types

```yaml
node_types:
  - module
  - service
  - repository
  - controller
  - gateway
  - library
  - external
```

Node types classify the architectural _role_ of each node. Templates (see below) can be bound to
node types, providing structural hints for scaffolding. Tools validate that every node declares
a type from this list.

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
    `has_outgoing_relations`, `has_tag:<name>`.
- **Description** — what the artifact captures. This text is available to agents via tool
  feedback when creating or validating nodes.

The above list is a default configuration that covers most projects. Projects can add
domain-specific artifacts:

```yaml
artifacts:
  compliance.md:
    required:
      when: has_tag:regulated
    description: Regulatory requirements and constraints

  performance.txt:
    required:
      when: has_tag:high-throughput
    description: Performance budgets, SLAs, optimization constraints
```

Tools validate artifact presence based on these rules and attach artifact content to context
packages.

### Knowledge categories

```yaml
knowledge_categories:
  - name: decisions
    description: Decisions and their rationale

  - name: patterns
    description: Implementation conventions with examples

  - name: invariants
    description: System truths that must never be violated
```

Knowledge categories classify elements under `knowledge/`. Each category corresponds to a
subdirectory in `knowledge/`. Tools validate consistency between configuration and directory
structure:

- `knowledge/decisions` is valid if `decisions` is configured as a category.
- A subdirectory under `knowledge/` that doesn't match any configured category is an error.

Category is inferred from directory name — no `category` field in YAML is needed. Categories
are configurable; projects can add their own:

```yaml
knowledge_categories:
  - name: regulations
    description: External regulatory requirements

  - name: conventions
    description: Team agreements on style and process
```

Adding a category requires simultaneously creating the corresponding subdirectory. Category is an
organizational label — it tells the agent and the human _what kind_ of semantic memory this is.
It does not change mechanics: each knowledge element has a scope, scope resolves, content goes
into context packages. Category appears as a label in the package ("Decision", "Pattern"), helping
interpret the content.

### Quality thresholds

```yaml
quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000
  knowledge_staleness_days: 90
```

Quality thresholds are measurable limits enforced by tools:

- **Minimum artifact length** — artifacts shorter than the threshold trigger a warning
  (likely shallow content).
- **Maximum direct relations** — nodes exceeding the threshold trigger a warning
  (likely too many responsibilities).
- **Context budget** — token limits for context packages:
  - `warning` signals growing complexity.
  - `error` blocks materialization: the node must be split.
- **Knowledge staleness** — number of days of divergence between a knowledge element's
  last Git commit timestamp and the last Git commit timestamps of nodes in its scope,
  after which tools signal potential staleness. Detection uses Git commit timestamps
  (not file modification dates), which remain meaningful after clone.

Configuration controls **what** material the engine works with. The engine itself — the context
assembly algorithm, scope resolution, referential integrity — is fixed. The system is predictable:
the same algorithm over different material produces different packages, but the algorithm is
always the same.

#### What is not configurable

- The context assembly algorithm — ordered steps that collect knowledge layers into a package.
  Only the material those steps operate on is configurable.
- The scope system — global, tag, node, and explicit references always behave the same.
  The project controls which knowledge elements exist and how they are scoped, not how
  scope resolution works.
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

tags:
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

knowledge:
  - decisions/002-event-sourcing

mapping:
  type: file
  path: src/modules/orders/order.service.ts
```

| Field       | Required | Purpose                                                      |
| ----------- | -------- | ------------------------------------------------------------ |
| `name`      | Yes      | Display name                                                 |
| `type`      | Yes      | Node type from `config.node_types`                          |
| `tags`      | No       | Tags that link node to aspects and scoped knowledge          |
| `relations` | No       | Outgoing dependencies to other nodes                         |
| `knowledge` | No       | Explicit references to knowledge elements                    |
| `mapping`   | No       | Link to source files (see Mapping section)                   |
| `blackbox`  | No       | If `true`, node describes something existing, not controlled |

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

The `failure` field captures knowledge about what the node does when the dependency is
unavailable — critical information that cannot be inferred from code or interface alone.

---

## Aspects: Cross-Cutting Requirements Bound by Tags

An **aspect** is a requirement that applies to every node carrying a given tag. Each aspect is a
directory containing `aspect.yaml` and content files.

```text
aspects/
  audit-logging/
    aspect.yaml
    content.md
```

```yaml
# aspects/audit-logging/aspect.yaml
name: Audit logging
tag: requires-audit
```

```markdown
<!-- aspects/audit-logging/content.md -->

Every operation that modifies data must emit an audit event containing:

- actor (user ID or system identifier)
- action (create, update, delete)
- entity type and ID
- timestamp (ISO 8601 UTC)
- diff of changed fields

Audit events are published to the event bus, never written directly to the application database.
```

Binding happens through the `tag` field in `aspect.yaml`. Tools resolve which nodes carry
that tag and attach all aspect content files (except `aspect.yaml`) to those nodes' context
packages.

Aspects encode requirements that cut **horizontally** across the system: security, audit,
caching, rate limiting, logging conventions. Without aspects, these requirements would have
to be repeated in every affected node's artifacts. With aspects, they are declared once and
distributed automatically.

Each aspect is bound to a single tag. This deliberate asymmetry (compared to knowledge elements,
which may have broader scopes) reflects their nature:

- Aspects impose **obligations** and are tied to **need tags** like `requires-audit`,
  `requires-auth`.
- Knowledge elements provide **understanding** and may be scoped by role tags like `service`,
  `controller`, where broader reach is natural.

If a requirement concerns multiple roles, the solution is a separate need tag
(e.g. `requires-rate-limiting`) applied to appropriate nodes, not expanding a single aspect
across many unrelated tags.

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

knowledge:
  - patterns/saga-pattern
```

Content artifacts in the flow directory (`description.md`, `sequence.md`, etc.) describe
flow behavior, sequence, error handling, and edge cases.

- `nodes` lists flow participants — paths are relative to `model/`.
- `knowledge` lists knowledge elements relevant to the flow.

When assembling a context package for any participant node, tools attach the flow's content
artifacts as context. They also attach knowledge elements referenced by the flow.

Flows capture semantic knowledge that belongs to **no single node**: orchestration logic,
end-to-end sequences, what happens when one participant fails. This knowledge is essential for
implementation but lives above the component level.

---

## Knowledge: Semantic Wisdom Beyond Components

Knowledge elements live under `knowledge/`, grouped into subdirectories that correspond to
configured categories. Each knowledge element is a directory containing `knowledge.yaml` and
content files.

```text
knowledge/
  decisions/
    001-postgresql/
      knowledge.yaml
      content.md

  patterns/
    error-handling/
      knowledge.yaml
      description.md
      example.ts

  invariants/
    no-cross-service-db/
      knowledge.yaml
      content.md
```

### Structure of a knowledge element

```text
knowledge/<category>/<name>/
  knowledge.yaml
  content.md
  ... (optional extra files: examples, diagrams, references)
```

`knowledge.yaml` defines identity and scope:

```yaml
name: PostgreSQL for persistence
scope:
  nodes:
    - orders/order-service
    - users/user-repository
    - inventory/inventory-repository
```

Category is determined by the parent directory (`decisions`, `patterns`, `invariants`). The
`category` field is implicit and does not exist in YAML.

All files in the knowledge directory **except** `knowledge.yaml` are treated as content and
attached to context packages.

### Decision records

Architectural decision records capture **why** choices were made.

**Critical rule: never invent decisions.** Files that imply human judgment (e.g. `decisions.md`,
`decisions.md`) or knowledge categories like `invariants` and `decisions` must reflect _actual_
human choices. The agent may extract decisions explicitly stated in code comments or previous
context. The agent must never invent, infer, or hallucinate a rationale, an architectural
decision, or a business rule. If the "why" or the specific invariant is unclear, the agent
must stop and ask the user.

```text
knowledge/decisions/001-postgresql/
  knowledge.yaml
  content.md
```

```yaml
# knowledge/decisions/001-postgresql/knowledge.yaml
name: PostgreSQL for persistence
scope:
  nodes:
    - orders/order-service
    - users/user-repository
    - inventory/inventory-repository
```

```markdown
<!-- knowledge/decisions/001-postgresql/content.md -->

We chose PostgreSQL instead of MongoDB because:

- order data is inherently relational (order, line items, payments)
- JSONB covers semi-structured needs without losing transactions
- the team has deep PostgreSQL expertise
```

Decision records stop teams from re-deciding resolved questions and ensure that future changes
understand original constraints.

### Patterns

Patterns encode "how we do things here" with reference code.

```text
knowledge/patterns/error-handling/
  knowledge.yaml
  description.md
  example.ts
```

```yaml
# knowledge/patterns/error-handling/knowledge.yaml
name: Error handling in services
scope:
  tags: [service]
```

The description explains the pattern. The example file in the project's language provides
reference code the agent can follow during materialization.

All files in a pattern's directory except `knowledge.yaml` are attached to context packages.
Patterns are the strongest mechanism for repo-wide consistency — an agent implementing a new
service reads the error-handling pattern and follows the established convention instead of
inventing its own.

### Invariants

Invariants are system truths that must never be violated.

```text
knowledge/invariants/no-cross-service-db/
  knowledge.yaml
  content.md
```

```yaml
# knowledge/invariants/no-cross-service-db/knowledge.yaml
name: No direct access to other services' databases
scope: global
```

```markdown
<!-- knowledge/invariants/no-cross-service-db/content.md -->

Services must never directly access database tables owned by another service.
All cross-service data access goes through declared interfaces.
Violating this invariant creates hidden coupling that the graph cannot track.
```

A global invariant appears in every context package, ensuring no implementation can break it
unknowingly.

### Custom categories

Projects define categories in `config.yaml` and create matching subdirectories. Mechanics
are identical for all categories: a knowledge element has a scope and content. Directory
location determines category; scope determines distribution. All knowledge exists to end up in
context packages.

---

## Scope System

The scope system makes knowledge deterministically discoverable. Each knowledge element declares
its scope — the set of nodes it applies to. Tools validate scopes and the context assembly
algorithm uses them.

### Global scope

```yaml
scope: global
```

Applied to every context package. Use sparingly — global elements consume budget in every
package.

### Tag scope

```yaml
scope:
  tags: [service, controller]
```

Applied to nodes carrying at least one of the listed tags. This is the same mechanism aspects
use. Tags must be defined in `config.yaml`.

### Node scope

```yaml
scope:
  nodes:
    - orders/order-service
    - users/user-repository
```

Applied only to listed nodes. Paths are relative to `model/`. Each path must resolve to an
existing node.

### Node-declared references

In addition to scopes declared on knowledge elements, nodes can explicitly reference knowledge
in `node.yaml`:

```yaml
knowledge:
  - decisions/002-event-sourcing
  - patterns/repository-pattern
```

Paths are relative to `knowledge/`. This creates a bidirectional discovery mechanism:

- Knowledge finds nodes through scopes.
- Nodes find knowledge through explicit references.

Both directions are validated by tools.

### Scope interaction

A knowledge element may reach a node through multiple paths: global scope, tag scope, node scope,
node-declared reference, or flow reference. The assembly algorithm deduplicates knowledge:

- Each knowledge element appears at most once in a context package, regardless of how many
  paths lead to it.

---

## Path Conventions

Every reference in the graph uses short, relative paths. Tools know the base directory for each
reference type.

| Location                       | Relative to        | Example value              |
| ------------------------------ | ------------------ | -------------------------- |
| `node.yaml` `relations.target` | `model/`           | `payments/payment-service` |
| `node.yaml` `knowledge`        | `knowledge/`       | `decisions/001-postgresql` |
| `flow.yaml` `nodes`            | `model/`           | `orders/order-service`     |
| `flow.yaml` `knowledge`        | `knowledge/`       | `patterns/saga-pattern`    |
| `aspect.yaml` `tag`            | `config.yaml:tags` | `requires-audit`           |
| `knowledge.yaml` `scope.tags`  | `config.yaml:tags` | `service`                  |
| `knowledge.yaml` `scope.nodes` | `model/`           | `orders/order-service`     |

No ambiguity. No absolute paths. No guessing which directory a reference points to.

---

## Mapping: Graph to Source

Nodes in the graph can be mapped to source files via declarations in `node.yaml`. Mapping enables
two things:

- Ownership lookup — which node owns a given file.
- Drift detection — did the file change since last synchronization.

### Mapping strategies

**File mapping** — node maps to a single file:

```yaml
mapping:
  type: file
  path: src/modules/orders/order.service.ts
```

Precise but brittle — renaming or moving the file breaks the mapping.

**Directory mapping** — node maps to a directory; all files in that directory belong to the node:

```yaml
mapping:
  type: directory
  path: src/modules/orders
```

More robust to internal changes — adding, renaming, or deleting files inside the directory does
not break the mapping.

**Multi-file mapping** — node maps to an explicit list of files. Useful when implementation
spans multiple files in different directories:

```yaml
mapping:
  type: files
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

## Templates: Schemas for Graph Layers

The `templates/` directory contains schema files — one per graph layer. Each file shows the
expected structure of its element type. The agent reads the appropriate schema before creating
or editing that element.

| File            | Element type | Purpose                                                |
| --------------- | ------------ | ------------------------------------------------------ |
| `node.yaml`     | Nodes        | Structure of `node.yaml` in model directories           |
| `aspect.yaml`   | Aspects      | Structure of `aspect.yaml` in aspects directories       |
| `flow.yaml`     | Flows        | Structure of `flow.yaml` in flows directories           |
| `knowledge.yaml`| Knowledge    | Structure of `knowledge.yaml` in knowledge elements      |

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

- All higher-level mechanisms — knowledge scopes, aspects, mappings, flows — operate only on
  declared nodes.
- **Blackbox is a first-class mechanism** for "we do not explore yet, but we need an owner."
  Use it for existing code when the user chooses not to reverse-engineer. Not for greenfield.
  Granularity (directory, module, etc.) is the user's choice.
