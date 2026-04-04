# Engine

The [Foundation](foundation) document defines the problem and invariants.
The [Graph](graph) document defines graph structure.
The [Integration](integration) document defines how agents use these mechanics.
This document defines the deterministic mechanics — algorithms and tools that operate on the
graph: context assembly, check (unified gate), and tool operations.

Most of this document describes **deterministic** mechanics — the same graph state always
produces the same output. No heuristics. No guessing. No searching. The exception is
[LLM-based verification](#llm-based-verification-approve-only), which runs at approve time
and provides semantic checks that structural validation cannot.

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
                  also include embedded `exceptions`.
                  Flow block: yg-flow.yaml has `aspects: [id1, id2]` for flows where N or an
                  ancestor participates.
                  Port block: when N has a relation that consumes a port on a target, the port's
                  required aspects are included with provenance (port name + target node).
                  Effective aspects = union of all identifiers from these blocks.
                  The `aspects` attribute on each block shows the resolved set (including implied
                  aspects), not just the raw declared identifiers.
                  For each aspect identifier: content of the matching aspect (aspects/<id>/) plus any
                  aspects implied by that aspect (recursive). Implies are resolved with cycle detection;
                  a cycle (A implies B implies A) is an error. No source attribute on aspect
                  output — aspects are rendered without provenance. Aspects section = union of
                  aspect identifiers from hierarchy + own + flow + port blocks, expand implies,
                  render content.
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

The context package uses **two-level progressive disclosure** in structured text format:

- **Node overview (default):** a compact structural map showing node metadata, hierarchy,
  dependencies, aspects, and flows — with artifact file paths but not their content. The
  agent reads artifact files separately as needed. This is the primary mode — lightweight
  and fast for orientation.
- **File details (`--full`):** embeds artifact content inline beneath each entry. Useful
  when the agent needs everything in a single payload or cannot read files individually.

The output is structured text (not YAML) — readable by any agent without a parser.

```text
# Context: orders/order-service

## Glossary

Aspects and flows referenced in this context. Read first — IDs below refer to entries here.

### Aspect: requires-audit
  Name: Audit Logging
  Description: Every state-changing operation must produce an audit log entry
  Files:
    - aspects/requires-audit/content.md

### Aspect: requires-saga
  Name: Saga Pattern
  Description: Multi-step operations must be coordinated via saga with compensating actions
  Files:
    - aspects/requires-saga/content.md

### Flow: checkout
  Name: Checkout Flow
  Description: End-to-end purchase flow from cart to payment confirmation
  Participants: orders/order-service, auth/auth-api, payments/payment-service
  Aspects: requires-saga
  Files:
    - flows/checkout/description.md

## Node

  Path: orders/order-service
  Name: OrderService
  Type: service
  Description: Manages order lifecycle from placement to fulfilment
  Mappings: src/orders/order.service.ts
  Aspects: requires-audit
  Flows: checkout (aspects: requires-saga)
  Files:
    - model/orders/order-service/responsibility.md
    - model/orders/order-service/interface.md

## Hierarchy

  orders
    Name: Orders
    Type: module
    Aspects: deterministic
    Files:
      - model/orders/responsibility.md

## Dependencies

  auth/auth-api [uses]
    Name: Auth API
    Type: service
    Description: Validates tokens and resolves caller identity
    Consumes: validateToken
    Aspects: deterministic
    Hierarchy: auth (module)
    Files:
      - model/auth/auth-api/responsibility.md
      - model/auth/auth-api/interface.md

## Meta

  Tokens: 1234 (ok)
  Breakdown: own=420 hierarchy=180 aspects=310 flows=195 dependencies=129
```

The format is fixed — the same structure regardless of project. Content within the
structure is variable — depends on project config and the specific node. Each dependency
entry includes its own hierarchy summary, providing domain context for that dependency
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

**Architecture constraint violations**: enforced per node and relation from
`yg-architecture.yaml`. E050 fires when an aspect identifier referenced by a node, port,
architecture type, or flow has no corresponding directory in `aspects/`. E051 fires when
a relation target's type is not in the architecture allowed list. E052 fires when a parent
type is not in the allowed `parents` list. E053 fires when a node consumes a port and that
port's required aspect is not defined in `aspects/`.

### Role of Validation

Validation serves two audiences:

**For agents** — validation is a feedback mechanism. After modifying the graph, the agent runs
validation and receives specific, actionable feedback about what needs attention. Not
"interface is missing" but "this node has three inbound relations and no interface artifact —
three other nodes depend on its public API."

**For CI pipelines** — validation is a quality gate. A project can enforce zero graph errors
before merge, ensuring structural integrity of the semantic memory base is maintained over time.

---

## Aspect and Architecture Validation

### Aspect reference integrity

All aspect identifiers must resolve to an existing directory under `aspects/`. E050
(dangling-aspect-ref) fires when any identifier — in a node's `aspects` list, a port's
`aspects` list, an architecture type's `aspects` list, or a flow's `aspects` list — has
no corresponding aspect directory.

### Aspect implies

The `implies` field on an aspect causes all nodes that carry the aspect to also carry the
implied aspect. The implies graph must be acyclic (E013) and all implied identifiers must
resolve (E012).

### Port-based aspect propagation

Ports replace the previous `integration_aspects` mechanism. When node A relates to node B
and consumes port X:

1. Port X declares required `aspects` (a list of aspect identifiers).
2. Node A must satisfy those aspects in its source code.
3. `yg check` validates the structure: E057 fires when a relation target has ports but the
   consumer relation has no `consumes` field. E058 fires when `consumes` names a port that
   does not exist on the target.
4. E053 fires if any port aspect identifier is not defined in `aspects/`.
5. Semantic verification happens at approve time via LLM — E055 fires when the LLM
   determines a port's required aspect is not satisfied in the consumer's source code (see
   [LLM-based verification](#llm-based-verification-approve-only)).

This two-phase approach separates fast structural checks (check) from expensive semantic
checks (approve). Structural checks catch missing declarations immediately; semantic checks
confirm actual compliance when the agent records a baseline.

### Structural architecture constraints

Validated from `yg-architecture.yaml`:

1. **Relation target types** — relation target type must be in the architecture allowed list → E051 if not
2. **Parent types** — parent type must be in the architecture allowed `parents` list → E052 if not

### Context output

Context packages include the resolved aspect list under the node section:

```text
## Node

  Path: cli/core/validator
  Name: Validator
  Type: library
  Aspects: deterministic (architecture: library), posix-paths (own declaration)
  Port aspects: error-handling (port: cli-errors on cli/core/engine)
```

The agent sees what must be satisfied and why — making the requirement explicit without
exposing per-file implementation details. Port aspects show which port and target node
introduced the requirement.

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
   (`uses`, `calls`, `extends`, `implements`). Also tracks a hash of the `ports` field from
   each target's `yg-node.yaml` (scoped — only changes to `ports` cascade, not other target
   metadata).
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

#### LLM result caching

LLM verification results (claim verification and artifact review — see
[LLM-based verification](#llm-based-verification-approve-only)) are cached in the drift
state alongside file hashes. When E020 (direct drift) or E021 (cascade drift) fires for a
node, all cached LLM results for that node are invalidated — the next approve re-runs
verification from scratch. This ensures LLM judgments are never stale: any change to source
files, artifacts, or upstream dependencies forces re-evaluation.

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

## LLM-Based Verification (Approve Only)

Approve runs two LLM checks on drifted nodes:

**Claim verification.** For each aspect on the node, the LLM receives the aspect
description, claim text, and concatenated source files. It responds with
`satisfied: true|false` and a reason. If unsatisfied, E055 fires. For large nodes,
source is chunked by file boundaries — all chunks must pass.

**Artifact review.** The LLM receives artifact content (responsibility.md, interface.md,
internals.md) and current source code. It responds with `current: true|false` and a
reason. If outdated, E056 fires.

**Consensus.** Configurable via `llm.consensus` in yg-config.yaml (positive odd integer,
default 1). When set to 3+, the LLM runs multiple times and majority vote decides.

**Caching.** Verification results are cached in drift state. When a node drifts (E020/E021),
cached results are invalidated and the next approve re-runs verification from scratch.

**Graceful degradation.** When no LLM provider is configured, approve works as before
(three-axis detection only, no E055/E056). A notice informs the user.

---

## Complete Assembly Example

Given graph state:

```text
yg-config.yaml
model/orders/order-service/yg-node.yaml aspects:
                                          - aspect: requires-audit
                                        relations: calls payments/payment-service
                                                           consumes: [charge, refund]

model/payments/payment-service/yg-node.yaml ports:
                                              - name: charge
                                                aspects: [requires-idempotency]

aspects/requires-audit/                 aspect id = directory path
  yg-aspect.yaml                        name, description, claims (anchors)

flows/checkout/yg-flow.yaml             lists orders/order-service as participant
```

Context package for `orders/order-service` contains:

```text
Step 1.  yg-config.yaml: project name
Step 2.  Domain context of orders/ module artifacts
Step 3.  Own artifacts of OrderService: responsibility, interface, internals
Step 4.  Aspect: Audit logging  [aspect requires-audit]
         Aspect: Idempotency   [port: charge on payments/payment-service]
Step 5.  Structural-context artifacts of PaymentService: responsibility, interface
         + annotation: consumes charge, refund; on failure: retry 3x, then payment-failed
         Flow: Checkout flow  [description.md]
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
