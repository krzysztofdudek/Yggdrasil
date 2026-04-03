# Engine

The [Foundation](foundation) document defines the problem and invariants.
The [Graph](graph) document defines graph structure.
The [Integration](integration) document defines how agents use these mechanics.
This document defines the deterministic mechanics — algorithms and tools that operate on the
graph: context assembly, check (unified gate), and tool operations.

Everything described in this document is **deterministic**. The same graph state always produces
the same output. No heuristics. No guessing. No searching.

---

## Context Assembly

### Multi-Layered Model

A context package is not a flat list of facts. It is a multi-layered document where each
layer carries a different level of abstraction — from most general to most specific.

```
WORLD IDENTITY           (changes least often)
  You are an e-commerce system.

LONG-TERM MEMORY         (changes rarely)
  Never connect to another service's database.
  Event sourcing is the pattern for state transitions.

DOMAIN CONTEXT           (changes on reorganization)
  You are in the Orders domain.
  Orders have lifecycle states and transitions.

UNIT IDENTITY            (changes on node evolution)
  You are OrderService.
  You create orders, validate them, manage state transitions.

SURROUNDINGS             (changes on neighbor evolution)
  You depend on PaymentService: charge, refund.
  PaymentService lives in the Payments domain (dependency hierarchy).
  You participate in the Checkout Flow.
```

Layers operate simultaneously — the agent needs all of them at once, but with different
intensity. When implementing a method, it focuses on **Surroundings** (dependency interface)
and **Unit Identity** (own contract), while **World Identity** (project name) and
**Long-term Memory** (patterns, decisions) inform _how_ to implement, not _what_.

Layer size is inversely proportional to its generality. World identity is a few sentences.
Unit identity and Surroundings are most of the content. This matches the nature of information:
general rules are concise and stable; specific contracts are detailed and changing.

### Assembly Algorithm

For node `N` at path `P` with aspects `A`, context assembly executes the following steps in order.
Each step is deterministic.

```
1.  GLOBAL        yg-config.yaml: project name

2.  HIERARCHICAL  for each ancestor from model/ root down to N's parent:
                  include all configured artifacts of that ancestor (every artifact type from config
                  that exists in the ancestor's directory)

3.  OWN           N's yg-node.yaml (raw) and N's content artifacts (all files matching configured
                  artifact filenames)

4.  ASPECTS       Each block (hierarchy, own, flow) declares its own aspects. No inheritance —
                  each block has an `aspects` field (comma-separated aspect identifiers; omit if empty).
                  Hierarchy block: each ancestor may have `aspects="id1,id2"` in its metadata.
                  Own block: yg-node.yaml has `aspects` as a list of entries, each with an `aspect`
                  field identifying the aspect (e.g. `- aspect: requires-audit`). Entries may
                  also include embedded `exceptions` and `anchors`.
                  Flow block: yg-flow.yaml has `aspects: [id1, id2]` for flows where N or an
                  ancestor participates. Effective aspects = union of all identifiers from these blocks.
                  The `aspects` attribute on each block shows the resolved set (including implied
                  aspects), not just the raw declared identifiers.
                  For each aspect identifier: content of the matching aspect (aspects/<id>/) plus any
                  aspects implied by that aspect (recursive). Implies are resolved with cycle detection;
                  a cycle (A implies B implies A) is an error. No source attribute on aspect
                  output — aspects are rendered without provenance. Aspects section = union of
                  aspect identifiers from hierarchy + own + flow blocks, expand implies, render content.
                  If an aspect entry declares `exceptions`, the exception notes are appended to
                  that aspect's layer as warnings.

5.  RELATIONAL
      for each structural relation of N (uses, calls, extends, implements):
        - artifacts of target with included_in_relations (e.g. responsibility, interface)
        - dependency hierarchy: ancestors of the target (from model/ root to target's parent)
          with their metadata and aspects, providing domain context for the dependency
        - consumes annotation from the relation field (if declared)
        - failure annotation from the relation field (if declared)
      for each event relation of N (emits, listens):
        - event name and type
        - consumes annotation from the relation field (if declared)
      for each flow listing N or any of N's ancestors as a participant:
        - flow content artifacts
```

The result is a single document — the context package. Its size is bounded regardless of
project size because each step attaches only what is directly relevant to node `N`.

> **Implementation note:** The implementation may build layers in a different internal order
> (e.g. relational and flows before aspects, so that flow-propagated aspect ids can be
> collected). The rendered output is always reordered to match the sequence above.

### Mapping Conceptual Layers to Algorithm Steps

The output uses **section names from the algorithm** (Global, Hierarchy, OwnArtifacts,
Aspects, Relational). The table below maps these to conceptual layers for understanding:

| Conceptual Layer | Algorithm Steps                         | Section in output |
| ---------------- | --------------------------------------- | ---------------- |
| World Identity   | Step 1 (global config)                  | Global           |
| Domain Context   | Step 2 (hierarchical ancestors)         | Hierarchy        |
| Unit Identity    | Step 3 (yg-node.yaml + own artifacts)   | OwnArtifacts     |
| Cross-cutting    | Step 4 (aspects from all blocks)        | Aspects          |
| Surroundings     | Step 5 (relations, events, flows)       | Relational       |

Layers are the conceptual model — they describe the _kinds_ of content in the package.
Steps are the mechanics — they describe _where_ content comes from.

### Relational Annotations

Step 5 does **not** parse the content of Markdown artifacts. Tools copy the full content of
each structural-context artifact of the target and then append annotations from the YAML
relation fields.

**Structural relations** (`uses`, `calls`, `extends`, `implements`):

```markdown
── Dependency: PaymentService [calls]
Consumes: charge, refund
On failure: retry 3x, then mark order as payment-failed

Responsibility (full content of responsibility.md / PaymentService)
...

Interface (full content of interface.md / PaymentService)
...
```

**Event relations** (`emits`, `listens`):

```markdown
── Event: OrderPlaced [emits]
Target: notifications/notification-service
You publish OrderPlaced.

── Event: PaymentCompleted [listens]
Source: payments/payment-service
You listen for PaymentCompleted.
Consumes: orderId, amount, status
```

The `consumes` and `failure` fields come from YAML declarations — tools understand them.
Artifact content is copied verbatim — tools treat it as text. The agent interprets which
methods or events are relevant and focuses accordingly.

**Fundamental principle**: tools never interpret Markdown content. They copy content and
annotate it with metadata from YAML. The agent interprets.

### Context Package Format

The context package is a YAML document with two modes:

- **Default (paths-only):** outputs a structural map with artifact file paths. The agent
  reads artifact files separately as needed. This is the primary mode — lightweight and
  fast.
- **Full (`--full`):** embeds artifact content inline. Useful when the agent needs
  everything in a single payload.

The structural map includes the node's metadata, its ancestor hierarchy, dependency hierarchy
(each dependency includes its own ancestor chain for domain context), aspects, and flows.

```yaml
project: MyProject

# Glossary: definitions of all aspects and flows referenced in this context.
# Read this first — IDs below (in node, hierarchy, dependencies) refer to entries here.
glossary:
  aspects:
    requires-audit:
      name: Audit Logging
      description: "Every state-changing operation must produce an audit log entry"
      files:
        - aspects/requires-audit/content.md
    requires-saga:
      name: Saga Pattern
      description: "Multi-step operations must be coordinated via saga with compensating actions"
      files:
        - aspects/requires-saga/content.md
  flows:
    checkout:
      name: Checkout Flow
      description: "End-to-end purchase flow from cart to payment confirmation"
      participants:
        - orders/order-service
        - auth/auth-api
        - payments/payment-service
      aspects:
        - requires-saga
      files:
        - flows/checkout/description.md

# Target node: the component you are working on.
node:
  path: orders/order-service
  name: OrderService
  type: service
  description: "Manages order lifecycle from placement to fulfilment"
  mappings:
    - src/orders/order.service.ts
  aspects:
    - id: requires-audit
  flows:
    - path: checkout
      aspects:
        - requires-saga
  files:
    - model/orders/order-service/responsibility.md
    - model/orders/order-service/interface.md

# Hierarchy: ancestor modules from root to parent. Context is inherited top-down.
hierarchy:
  - path: orders
    name: Orders
    type: module
    aspects:
      - deterministic
    files:
      - model/orders/responsibility.md

# Dependencies: components this node directly depends on.
dependencies:
  - path: auth/auth-api
    name: Auth API
    type: service
    description: "Validates tokens and resolves caller identity"
    relation: uses
    consumes:
      - validateToken
    aspects:
      - deterministic
    hierarchy:
      - path: auth
        name: Auth
        type: module
        aspects: []
        files:
          - model/auth/responsibility.md
    files:
      - model/auth/auth-api/responsibility.md
      - model/auth/auth-api/interface.md

meta:
  token-count: 1234
  budget-status: ok
  breakdown:
    own: 420
    hierarchy: 180
    aspects: 310
    flows: 195
    dependencies: 129
    total: 1234
```

The format is fixed — the same YAML structure regardless of project. Content within the
structure is variable — depends on project config and the specific node. Each dependency
entry includes its own `hierarchy` list, providing ancestor context for that dependency
without requiring the agent to traverse the graph manually.

**The context package contains only graph content, not source code.** The agent fetches
source files separately when it needs implementation details. If a person places code
fragments inside Markdown artifacts (e.g., in `interface.md` as an API specification),
that is their choice — tools treat artifacts as text and attach content without parsing it.

### Package Size and Budget

A typical context package is 5,000–10,000 tokens. Size is structurally bounded because each
algorithm step attaches only directly relevant context. A node with 3 dependencies attaches
3 interfaces, not 300.

Configuration defines budget thresholds:

- **Warning threshold** (default 10,000 tokens) — package is growing; the node likely has too
  many responsibilities or dependencies.
- **Error threshold** (default 20,000 tokens) — package is large; the node should be split.
  The error threshold no longer blocks — `budgetStatus` is `'severe'` instead of `'error'`,
  and the context package is always output.
- **Own-artifact warning** (`own_warning`, optional) — fires when the node's own artifacts
  alone exceed this threshold (W002). This is the most actionable budget signal because own
  artifacts are the only part the node author controls directly.

Tools estimate tokens using the heuristic of 4 characters per token. This is accurate enough
for budget monitoring, though not precise per-model. Token counting includes the full
dependency hierarchy cost — each dependency's ancestor chain contributes to the total.

The context package meta section includes a `budget-breakdown` with per-category token counts
and percentages (own, hierarchy, aspects, flows, dependencies), giving agents diagnostic
visibility into what drives package size.

Context package size is a **measurable quality indicator**. A package exceeding the budget
is the same signal as a class with 2,000 lines in traditional engineering: too many
responsibilities in one place.

---

## Validation (part of check)

The `yg check` command validates the entire graph for structural integrity, drift, coverage,
and completeness. Validation has two severity levels with distinct consequences.

### Structural Integrity (Errors)

Errors represent broken references or invalid structure. They block context assembly —
a graph with errors cannot produce reliable context packages.

**Node structure**: every directory in `model/` with `yg-node.yaml` must have required fields
(`name`, `type`). Type must be a key in the configured `node_types` object.

**Referential integrity**:

- Every relation target must resolve to an existing node.
- Every flow participant must resolve to an existing node.
- Every aspect identifier must correspond to a directory under `aspects/`.
- Every identifier in an aspect's `implies` must have a corresponding aspect in `aspects/`.
- The aspect implies graph must be acyclic (no A implies B implies A).
- Every aspect entry's `exceptions` field, if present, must be a list of non-empty strings.

**Mapping uniqueness**: no two nodes may map to the same file or have overlapping directory
mappings.

**Acyclicity**: structural relations (`uses`, `calls`, `extends`, `implements`) must not
form cycles. Event relations (`emits`, `listens`) may form cycles — they do not create true
dependencies. **Exception**: cycles involving at least one blackbox node are tolerated
(no error) — blackbox nodes are not materialized, so the cycle does not block context
assembly or adoption of Yggdrasil to legacy codebases.

### Completeness Signals (Warnings)

Warnings flag quality issues that don't break the graph but reduce context package value.

**Missing artifacts**: a non-blackbox node without required artifacts
(e.g., a node with incoming relations but no `interface` artifact).

**Shallow content**: artifacts that exist but are shorter than the configured minimum length.

**Context budget**: a complex context package exceeding the configured warning threshold.
W001 includes a diagnostic breakdown (own/hierarchy/aspects/flows/dependencies) with
percentages. Exceeding the error threshold produces E032 (`budget-exceeded`) — the node
must be split. W002 fires when own artifacts alone exceed the
`own_warning` threshold — the most actionable budget signal.

**High fan-out**: a node whose direct relation count exceeds the configured maximum — a signal
of excessive coupling.

**Unmatched event relations**: a node declares an `emits` relation to a target but the target
has no matching `listens`, or vice versa — event-based communication is declared unilaterally.
Tools compare declarations on both sides and signal the missing complement.

**Missing required aspect coverage**: a node of type X has `required_aspects` in config but the node
lacks coverage (direct aspect or via implies) for one or more required aspects. Tools report this as
an error (E035).

### Role of Validation

Validation serves two audiences:

**For agents** — validation is a feedback mechanism. After modifying the graph, the agent runs
validation and receives specific, actionable feedback about what needs attention. Not
"interface is missing" but "this node has three inbound relations and no interface artifact —
three other nodes depend on its public API."

**For CI pipelines** — validation is a quality gate. A project can enforce zero graph errors
before merge, ensuring structural integrity of the semantic memory base is maintained over time.

---

## Effective Aspect Resolution

Aspects propagate to nodes and files from multiple sources. The engine computes the
**effective set** of aspects that a node must prove, then validates that every mapping
group declares all of them.

### Aspect sources

Aspects arrive at a node through five channels:

| Source | How it propagates | Example |
| --- | --- | --- |
| Architecture type | Required on every file of nodes of this type | `service` type requires `requires-auth` |
| Architecture integration | Required on consumers of a target type | If `service` has `integration_aspects: [correlation-tracking]`, callers must prove it |
| Flow aspects | Required on all flow participants | All `checkout` flow participants get `requires-saga` |
| Aspect implies | Recursive expansion of aspect references | `requires-hipaa` implies `requires-audit`, `requires-encryption` |
| Parent inheritance | Children inherit parent's effective aspects | Child service inherits parent module's aspects |
| Node own aspects | Custom aspects declared directly on the node | Extra aspects beyond inherited requirements |

### Effective set computation

```text
effective_aspects(node) =
  node.aspects                              # own extras
  ∪ architecture[node.type].aspects         # type requirement
  ∪ flow.aspects for each participating flow  # flow propagation
  ∪ parent.effective_aspects                # parent inheritance (recursive)
  ∪ recursive_implies(all above)            # aspect implies expansion
```

When node A has a structural relation (calls, uses, extends, implements) to node B:

- A must prove `effective_integration_aspects(B)` on its mapping groups

```text
effective_integration_aspects(node) =
  node.integration_aspects                  # own extras
  ∪ architecture[node.type].integration_aspects  # type requirement
  ∪ parent.effective_integration_aspects    # parent inheritance (recursive)
  ∪ recursive_implies(all above)            # aspect implies expansion
```

### Validation during check

For each node with mapping:

1. **Compute effective aspects**
   - Collect aspects from architecture type, parent inheritance, flow participation, and own declarations
   - Recursively expand all `implies` references
   - Result: a set of aspect IDs that this node must prove

2. **For each mapping group**
   - Must declare ALL effective aspects → E050 if missing
   - Must NOT declare aspects outside the allowed set → E054 if extra
   - For each declared aspect, all anchor IDs from `yg-aspect.yaml` must be realized → E040 if missing
   - For each anchor regex, pattern must match in EVERY file in the group → E037 if not found

3. **For each structural relation to target B**
   - Compute `effective_integration_aspects(B)`
   - Consumer's mapping groups must declare all integration aspects → E053 if missing

### Context output

Context packages include the resolved aspect list under `node:`:

```yaml
node:
  path: cli/core/validator
  name: Validator
  type: library
  required_aspects:
    - id: deterministic
      source: architecture (type: library)
    - id: posix-paths
      source: own declaration
  integration_aspects:
    - id: error-handling
      source: architecture (type: library)
```

The agent sees what must be proven and why — making the requirement explicit without
exposing per-file implementation details.

---

## Bidirectional Drift Detection (part of check)

Drift is divergence between graph and outputs. Drift detection runs as part of `yg check`
and is **bidirectional** — it tracks both source files (code mapped via `yg-node.yaml`
mappings) and graph artifacts (`.yggdrasil/` files that participate in a node's context
package). A change on either side is drift (E020); a change triggered by upstream changes
is cascade drift (E021).

### Mechanism

For each node with a mapping, tools collect all **tracked files** — both source files from
the mapping and graph artifact files that contribute to the node's context package. Tools
compute a SHA-256 hash of the tracked file set and compare it against the stored state.
State is stored in `.yggdrasil/.drift-state/` as per-node JSON files (one file per node,
e.g. `.drift-state/orders/order-service.json`).

Each drift state file contains the hash of each tracked file at the time of last
synchronization. These files are committed to the repository — drift state is shared across
the team, not local per-developer.

#### Tracked file collection (`collectTrackedFiles`)

The set of tracked files for a node mirrors the traversal of context assembly
(`context`) but returns file paths instead of rendered content. Six layers are
collected:

1. **Own** — `yg-node.yaml` and config-filtered artifacts of the node itself.
2. **Hierarchical** — `yg-node.yaml` and artifacts of all ancestor nodes from root to parent.
3. **Aspects** — `yg-aspect.yaml` and content files for all resolved aspects (own + ancestor +
   flow-propagated, with recursive `implies` expansion).
4. **Relational dependencies** — structural-context artifacts of structural relation targets
   (`uses`, `calls`, `extends`, `implements`). Also tracks a hash of the `integration_anchors`
   field from each target's `yg-node.yaml` (scoped — only changes to `integration_anchors`
   cascade, not other target metadata).
5. **Relational flows** — `yg-flow.yaml` and content artifacts of all flows listing this node or
   an ancestor as a participant.
6. **Source** — files from the node's `mapping.paths`.

Layers 1--5 produce graph-category files (paths under `.yggdrasil/`). Layer 6 produces
source-category files. Each file is tracked exactly once (deduplicated by path).

#### Hash computation

Each path in `mapping.paths` is checked at runtime — if it is a file, its content is hashed
directly (SHA-256). If it is a directory, it is scanned recursively (respecting `.gitignore`),
each file is hashed individually, and a canonical hash is computed from sorted
(relative-path, SHA-256-of-content) pairs. Adding, removing, or changing any file in a
directory changes the canonical hash.

The overall drift state for a node combines both source and graph file hashes into a single
canonical hash. Per-file hashes are also stored for diagnostics — enabling tools to report
exactly which files changed and whether they are source or graph files.

The mechanism is deliberately simple: **hash changed → something changed**. Tools classify
the change by checking which files differ and whether they are source or graph files. The
agent assesses the significance and decides on resolution.

### Drift States

Every mapped node has one of six states:

| State            | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `ok`             | All tracked file hashes match — nothing changed since last synchronization           |
| `source-drift`   | Source file(s) changed but graph artifacts unchanged                                 |
| `graph-drift`    | Graph artifact(s) changed but source files unchanged                                 |
| `full-drift`     | Both source and graph files changed                                                  |
| `missing`        | Mapped source files do not exist on disk                                             |
| `unmaterialized` | Node has a mapping but files have never been created (no entry in `.drift-state/`)   |

### Drift Resolution

Resolution depends on the type of drift detected:

- **Source drift** — source files changed outside the semantic memory cycle. The agent
  reviews the changes, updates graph artifacts to reflect the new source state, then runs
  `approve` to record the new baseline.
- **Graph drift** — graph artifacts changed (e.g., updated responsibility, added constraints)
  but source code was not updated to match. The agent reviews the graph changes, updates
  affected source files to align with the new specification, then runs `approve`.
- **Full drift** — both sides changed independently. The agent must reconcile both: review
  source changes, review graph changes, resolve any conflicts, update both sides as needed,
  then run `approve`.
- **Missing** — mapped source files were deleted. The agent determines whether to
  re-materialize from the graph or remove the mapping.
- **Unmaterialized** — files have never been created. The agent materializes from the graph.

In all cases, the human decides the resolution direction. The agent executes the decision.
Tools record the new state via `approve`.

---

## Tool Operations

Tools are the deterministic engine through which agents and humans query and validate the graph.

Read and validation operations are stateless — they read files from disk, process, and produce
output. Drift operations modify operational metadata (`.drift-state/`) but not semantic
knowledge in the graph.

### Core Workflow (4)

| Operation        | Command                                | Description                                              |
| ---------------- | -------------------------------------- | -------------------------------------------------------- |
| Context assembly | `yg context --file/--node [--full]`    | Assemble context package for a node                      |
| Impact analysis  | `yg impact --file/--node/--aspect/--flow` | Blast radius analysis                                 |
| Check            | `yg check`                             | Unified gate — structural integrity, drift, coverage, completeness |
| Approve          | `yg approve --node [--acknowledge]`    | Record baseline after review                             |

Read operations (`context`, `impact`) modify nothing. `check` is read-only.
`approve` updates synchronization metadata (`.drift-state/`) after an explicit review
decision — tracking state, not semantic knowledge.

### Navigation (5)

| Operation            | Command                      | Description                            |
| -------------------- | ---------------------------- | -------------------------------------- |
| Node selection       | `yg select --task`           | Find relevant nodes for a task         |
| Tree view            | `yg tree [--root] [--depth]` | Graph structure visualization          |
| Aspects              | `yg aspects`                 | List aspects with metadata             |
| Flows                | `yg flows`                   | List flows with metadata               |
| Ownership resolution | `yg owner --file`            | Quick ownership lookup                 |

Navigation operations are read-only.

### Setup (1)

| Operation  | Command                           | Description                                                       |
| ---------- | --------------------------------- | ----------------------------------------------------------------- |
| Initialize | `yg init [--platform] [--upgrade]` | Create `.yggdrasil/` structure or refresh rules file              |

Initialization is the only operation that creates files in the graph structure — and it does
so only once. It creates the `.yggdrasil/` directory with a default `yg-config.yaml` and
configures integration with the agent platform.

### Responsibility Boundary

Tools do **not** write semantic content to the graph. They do not create nodes, add relations,
write artifacts, or manage aspects and flows. That is creative work belonging to the agent.

Tools maintain only operational metadata:

- Drift state (`.drift-state/`) — for tracking synchronization.

The agent creates directories, writes `yg-node.yaml`, writes Markdown artifacts. Tools validate
the result and give feedback.

This model is analogous to the programmer–compiler relationship: the programmer writes code,
the compiler checks correctness. The only exception is initialization, which creates the
starting structure and config. After initialization, all content changes in the graph are
the work of the agent or human — tools only read.

---

## Complete Assembly Example

Given graph state:

```
yg-config.yaml
model/orders/order-service/yg-node.yaml aspects:
                                          - aspect: requires-audit
                                        relations: calls payments/payment-service
                                                           consumes: charge, refund

aspects/requires-audit/                 aspect id = directory path
  yg-aspect.yaml                        name, optional description, optional implies

flows/checkout/yg-flow.yaml             lists orders/order-service as participant
```

Context package for `orders/order-service` contains:

```
Step 1.  yg-config.yaml: project name
Step 2.  Domain context of orders/ module artifacts
Step 3.  Own artifacts of OrderService: responsibility, interface, internals
Step 4.  Aspect: Audit logging  [aspect requires-audit]
Step 5.  Structural-context artifacts of PaymentService: responsibility, interface
         + annotation: consumes charge, refund; on failure: retry 3x, then payment-failed
         Flow: Checkout flow  [description.md, sequence.md]
```

---

## Dependency Resolution Order

Structural relations are acyclic. Therefore the dependency graph has a topological order —
nodes can be unambiguously ordered such that each node follows all its dependencies.

This order has consequences for materialization mechanics.

A context package for node A (which calls B) contains B's interface. The interface is described
in the graph — so A's context package is complete regardless of whether B is already
implemented. However, when the agent materializes A, A's output imports, calls, or extends B's
output. If B's output doesn't exist, A's output cannot compile — even if A's context package
was correct.

Materialization stages follow from this:

```
Stage 1: nodes with no structural dependencies (graph leaves)
Stage 2: nodes that depend only on Stage 1 nodes
Stage N: nodes that depend only on Stage 1..N-1 nodes
```

Within one stage, nodes are independent of each other — they can be materialized in parallel
(e.g., by subagents). Stages are sequential — stage N requires that Stage 1..N-1 outputs exist.

Tools compute this order deterministically from the structural relation graph.

Event relations (`emits`, `listens`) do not participate in ordering — they do not create
implementation dependencies.

Ordering concerns materialization of outputs. Context package assembly itself requires no order
— it uses graph artifacts, not materialized outputs.

---

## Task-Based Node Selection

Context assembly requires a node path. But the agent's starting point is often a task
description, not a node path — "fix the authentication bypass in token refresh" rather than
"build context for `auth/token-service`."

The bridge between task description and node selection is the graph's own content. Graph
artifacts — responsibility, interface, aspect content — are written in the same natural-language
vocabulary developers use in task descriptions. This makes simple keyword matching against
artifact content an effective selection mechanism:

1. Tokenize the task description and remove stop words
2. Search all node artifacts with weights (responsibility highest, internals lowest)
3. Score nodes by weighted keyword hit count
4. Select top-K nodes above a score threshold

This approach works because the graph is already optimized for intent matching — by design.
Responsibility files describe what a node does in the same terms a developer would use to
describe a task involving that node. No embeddings, no ML infrastructure, no semantic search
engine required.

When keyword signal is weak (ambiguous or indirect task descriptions), falling back to
flow-based selection — matching against flow descriptions and selecting flow participants —
provides broader coverage at the cost of precision.

The selection output feeds directly into context assembly: for each selected node, build
a context package using the standard algorithm. The agent receives pre-assembled context
for all relevant areas without needing to know the graph structure.

---

## Generator Independence

A context package is a Markdown document readable by any AI agent. Switching agents (Cursor →
Claude Code → Copilot → any future agent) requires no changes to the graph or tools. The agent
reads the same context package and produces output in the same format. Tools do not know and do
not need to know which agent consumes the packages.

---

## Success Metric

Yggdrasil works when **an agent can correctly implement a node using only its context package
— without reading other parts of the repository to understand the system**.

If the agent must explore the repository to understand what the node should do, the context
package — and therefore the graph — is incomplete. The self-calibrating granularity feedback
loop from the [Foundation](foundation) document applies directly: bad output → identify what was missing in
the context package → improve the graph → better package → better output.
