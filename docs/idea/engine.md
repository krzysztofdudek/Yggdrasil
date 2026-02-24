# Engine

The [Foundation](foundation) document defines the problem and invariants.
The [Graph](graph) document defines knowledge structure.
The [Integration](integration) document defines how agents use these mechanics.
This document defines the deterministic mechanics — algorithms and tools that operate on the
graph: context assembly, validation, drift detection, and tool operations.

Everything described in this document is **deterministic**. The same graph state always produces
the same output. No heuristics. No guessing. No searching.

---

## Context Assembly

### Multi-Layered Model

A context package is not a flat list of facts. It is a multi-layered document where each
layer carries a different level of abstraction — from most general to most specific.

```
WORLD IDENTITY           (changes least often)
  You are an e-commerce system. TypeScript, NestJS, PostgreSQL.

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
  You participate in the Checkout Flow.
```

Layers operate simultaneously — the agent needs all of them at once, but with different
intensity. When implementing a method, it focuses on **Surroundings** (dependency interface)
and **Unit Identity** (own contract), while **World Identity** (stack, standards) and
**Long-term Memory** (patterns, decisions) inform _how_ to implement, not _what_.

Layer size is inversely proportional to its generality. World identity is a few sentences.
Unit identity and Surroundings are most of the content. This matches the nature of information:
general rules are concise and stable; specific contracts are detailed and changing.

### Assembly Algorithm

For node `N` at path `P` with tags `T`, context assembly executes the following steps in order.
Each step is deterministic.

```
1.  GLOBAL        config.yaml: stack, standards

2.  KNOWLEDGE     global scope
                  every knowledge element where scope = global

3.  KNOWLEDGE     tag match
                  every knowledge element where scope.tags ∩ T ≠ ∅

4.  KNOWLEDGE     node scope
                  every knowledge element where P ∈ scope.nodes

5.  KNOWLEDGE     node-declared
                  every element listed in N.knowledge

6.  HIERARCHICAL  for each ancestor from model/ root down to N's parent:
                  include all configured artifacts of that ancestor (every artifact type from config
                  that exists in the ancestor's directory)

7.  OWN           N's node.yaml (raw) and N's content artifacts (all files matching configured
                  artifact filenames)

8.  RELATIONAL
      for each structural relation of N (uses, calls, extends, implements):
        - artifacts of target with structural_context (e.g. responsibility, interface, constraints, errors)
        - consumes annotation from the relation field (if declared)
        - failure annotation from the relation field (if declared)
      for each event relation of N (emits, listens):
        - event name and type
        - consumes annotation from the relation field (if declared)

9.  ASPECTS       for each tag in T: content of the matching aspect

10. FLOWS         for each flow listing P as a participant:
                  - flow content artifacts
                  - knowledge elements referenced by the flow (flow.knowledge)
```

The result is a single document — the context package. Its size is bounded regardless of
project size because each step attaches only what is directly relevant to node `N`.

**Deduplication**: knowledge elements are deduplicated globally within the package. If a
knowledge element is reachable via multiple paths (global scope, tag scope, node scope,
node-declared in step 5, flow reference in step 10), it appears at most once regardless of
the number of paths leading to it.

### Mapping Conceptual Layers to Algorithm Steps

The output uses **section names from the algorithm** (Global, Knowledge, Hierarchy, OwnArtifacts,
Dependencies, Aspects, Flows). The table below maps these to conceptual layers for understanding:

| Conceptual Layer | Algorithm Steps                         | Section in output |
| ---------------- | --------------------------------------- | ---------------- |
| World Identity   | Step 1 (global config)                  | Global           |
| Long-term Memory | Steps 2–5 (all knowledge scopes)        | Knowledge        |
| Domain Context   | Step 6 (hierarchical ancestors)         | Hierarchy        |
| Unit Identity    | Step 7 (node.yaml + own artifacts)     | OwnArtifacts     |
| Surroundings     | Steps 8–10 (relational, aspects, flows) | Dependencies, Aspects, Flows |

Layers are the conceptual model — they describe the _kinds_ of knowledge in the package.
Steps are the mechanics — they describe _where_ knowledge comes from. One conceptual layer
can span multiple steps; long-term memory uses four scope types, and one step can contribute
to multiple layers (step 10 attaches both flow artifacts and knowledge referenced by the flow).

### Relational Annotations

Step 8 does **not** parse the content of Markdown artifacts. Tools copy the full content of
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

Constraints (full content of constraints.md / PaymentService)
...

Errors (full content of errors.md / PaymentService)
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

The context package is a Markdown document with clearly separated sections. Section headers
match the algorithm steps (Global, Knowledge, Hierarchy, OwnArtifacts, Dependencies, Aspects, Flows):

```markdown
# Context Package: OrderService
# Path: orders/order-service
# Generated: 2024-01-15T10:30:00.000Z

---

## Global

### Global Context

**Project:** my-project

**Stack:**
- language: typescript
- runtime: node
- framework: nestjs

**Standards:**
Strict TypeScript, JSDoc on public functions

---

## Knowledge

### Invariant: No direct access to other services' databases

<content>

### Decision: Event Sourcing

<content>

---

## Hierarchy

### Module Context (orders/)

### responsibility.md

<content of orders/responsibility.md>

---

## OwnArtifacts

### Node: OrderService

### node.yaml

name: OrderService
type: service
tags:
  - requires-audit
  - requires-auth
relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge, refund]
  - target: inventory/inventory-service
    type: calls
    consumes: [reserve, release]
mapping:
  type: file
  path: src/modules/orders/order.service.ts

### responsibility.md

<content>

### interface.md

<content>

### constraints.md

<content>

### state.md

<content>

---

## Dependencies

### Dependency: PaymentService (calls) — payments/payment-service

Consumes: charge, refund
On failure: retry 3x, then mark order as payment-failed

### Responsibility

<responsibility.md content>

### Interface

<interface.md content>

### Constraints

<constraints.md content>

### Errors

<errors.md content>

### Dependency: InventoryService (calls) — inventory/inventory-service

Consumes: reserve, release

### Responsibility

<responsibility.md content>

### Interface

<interface.md content>

### Constraints

<constraints.md content>

### Errors

<errors.md content>

---

## Aspects

### Audit logging (tag: requires-audit)

<content>

---

## Flows

### Flow: Checkout flow

<description.md>
<sequence.md>

### Long-term Memory (from flow): Saga Pattern

<content>

---

Context size: 3,200 tokens
Layers: global, knowledge, hierarchy, own, relational, aspects, flows
```

Markdown is the natural format for agents — they read it fluently. The format is fixed — the
same section layout regardless of project. Content is variable — depends on project config and
the specific node.

**The context package contains only graph knowledge, not source code.** The agent fetches
source files separately when it needs implementation details. If a person places code
fragments inside Markdown artifacts (e.g., in `interface.md` as an API specification),
that is their choice — tools treat artifacts as text and attach content without parsing it.

### Package Size and Budget

A typical context package is 2,000–5,000 tokens. Size is structurally bounded because each
algorithm step attaches only directly relevant context. A node with 3 dependencies attaches
3 interfaces, not 300.

Configuration defines budget thresholds:

- **Warning threshold** (default 10,000 tokens) — package is growing; the node likely has too
  many responsibilities or dependencies.
- **Error threshold** (default 20,000 tokens) — package is too large for reliable
  materialization; the node must be split.

Tools estimate tokens using the heuristic of 4 characters per token. This is accurate enough
for budget monitoring, though not precise per-model.

Context package size is a **measurable quality indicator**. A package exceeding the budget
is the same signal as a class with 2,000 lines in traditional engineering: too many
responsibilities in one place.

---

## Validation

Tools validate the entire graph for structural integrity and quality signals.
Validation has two severity levels with distinct consequences.

### Structural Integrity (Errors)

Errors represent broken references or invalid structure. They block context assembly —
a graph with errors cannot produce reliable context packages.

**Node structure**: every directory in `model/` with `node.yaml` must have required fields
(`name`, `type`). Type must be from the configured `node_types` list.

**Referential integrity**:

- Every relation target must resolve to an existing node.
- Every knowledge reference must resolve to an existing knowledge element.
- Every flow participant must resolve to an existing node.
- Every tag must be defined in `config.yaml`.

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

**Unreachable knowledge**: a knowledge element that reaches no context package — neither through
scope matching to existing nodes nor through explicit references from node `knowledge` fields.
It was written but is dead.

**Missing examples**: a pattern directory without an example file. A pattern describes a
convention but provides no reference implementation.

**Context budget**: a complex context package exceeding the configured warning threshold.
Exceeding the error threshold (W006 budget-error) is a **behavioral** block: the agent may
consciously proceed, but should warn the user about the risk and recommend splitting the node.

**High fan-out**: a node whose direct relation count exceeds the configured maximum — a signal
of excessive coupling.

**Stale knowledge** (W008): a knowledge element whose scoped nodes evolved more recently than
the element itself — the semantic memory may not have kept pace with node evolution. Detection
uses a **Proxy based on Git commit timestamps** (not file modification dates, which are not
semantic after clone). For knowledge element `K` at `knowledge/<cat>/<name>/`: `tK` = timestamp
of last commit touching `K`. For each node `P` in `K`'s scope: `tP` = timestamp of last commit
touching `.yggdrasil/model/<P>/`. If `max(tP) - tK > knowledge_staleness_days`, report W008
stale-knowledge for `K`.

**Unmatched event relations**: a node declares an `emits` relation to a target but the target
has no matching `listens`, or vice versa — event-based communication is declared unilaterally.
Tools compare declarations on both sides and signal the missing complement.

### Role of Validation

Validation serves two audiences:

**For agents** — validation is a feedback mechanism. After modifying the graph, the agent runs
validation and receives specific, actionable feedback about what needs attention. Not
"interface is missing" but "this node has three inbound relations and no interface artifact —
three other nodes depend on its public API."

**For CI pipelines** — validation is a quality gate. A project can enforce zero graph errors
before merge, ensuring structural integrity of the semantic memory base is maintained over time.

---

## Drift Detection

Drift is divergence between the graph and outputs — source files changed outside the
semantic memory cycle. Tools detect it by comparing file hashes.

### Mechanism

For each node with a mapping, tools compute a SHA-256 hash of mapped files and compare it
against the stored state. State is stored in `.yggdrasil/.drift-state` (YAML).

`.drift-state` contains the hash of each mapped file at the time of last synchronization.
The file is committed to the repository — drift state is shared across the team, not local
per-developer.

Hash computation depends on mapping strategy:

| Strategy    | Hash algorithm                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `file`      | SHA-256 of file content                                                                         |
| `directory` | SHA-256 of sorted list of (path, SHA-256-of-content) pairs; path is relative to the directory.  |
|             | Files matching `.gitignore` (project root) are excluded from the hash.                          |
| `files`     | SHA-256 of sorted list of (filepath, SHA-256-of-content) pairs                                 |

`directory` and `files` strategies produce one canonical hash — adding, removing, or changing
any file changes the group hash.

The mechanism is deliberately simple: **hash changed → something changed**. Tools do not
interpret what changed — that is creative work for the agent. Tools report the fact;
the agent assesses the significance.

### Drift States

Every mapped node has one of four states:

| State            | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `ok`             | Hash matches — file has not changed since last synchronization |
| `drift`          | Hash does not match — file was modified                        |
| `missing`        | Mapped file does not exist on disk                             |
| `unmaterialized` | Node has a mapping but the file has never been created         |

### Drift Resolution

When drift is detected, there are two resolution paths:

- **Absorption**: the agent updates the graph to reflect the changes in the file. Tools update
  the stored hash. Outputs become the truth.
- **Rejection**: the agent re-materializes the file from the graph. Hash is updated after
  materialization. The graph remains the truth.

The human decides which direction to take. The agent executes the decision. Tools record the
new state.

---

## Session Journal

### The Problem

Conversation with the agent is **volatile memory** — it is compressed (context summarization
after window fill), interruptible (the user ends the session at any point), and ephemeral
(it doesn't survive between sessions in full form).

Any semantic knowledge living only in conversation is at risk of loss.

A full graph update — creating a Markdown artifact, expanding `node.yaml`, adding a knowledge
element — requires focus and interrupts the creative flow. The agent faces a trade-off: save
to graph immediately (risk of interrupting flow) or defer until later (risk of loss on context
compression or session interruption).

### Mechanism

The session journal is a buffer between volatile conversation and persistent semantic memory.
It works as a session log — the agent records notes about what it's doing (decisions made,
logic changes, new components) at the moment they happen, quickly and without interrupting the
creative flow. Notes are later consolidated into full graph entries during session close
(reconciliation).

The journal is managed mechanically by tools. The agent provides content — what to note.
The tool handles file format, timestamps, and file operations. **The agent does not edit the
journal file directly**, just as it does not edit `.yggdrasil/.drift-state`.

The journal is stored in `.yggdrasil/.journal.yaml`. It is **local** and **gitignored** —
each developer has their own journal on their machine. This is not a shared team artifact;
it is a personal session buffer. The shared artifact is the committed graph.

The journal is not an alternative to the graph — it is a write buffer. Intent captured in the
journal survives context compression and session interruption because it is a file on disk.
But until consolidated into the graph, it does not participate in context assembly, validation,
or drift detection.

### Presence Signal

The journal's state model is deliberately simple:

- File exists with entries → pending intent.
- File absent or empty → clean state.

Tools do not track status of individual entries — all entries in the active journal are
pending. Presence of the journal at session open is an unambiguous signal: the previous session
did not close cleanly, or left unprocessed notes. The agent consolidates them into the graph
before starting new work.

### Archiving

After consolidating entries into the graph, the tool archives the journal — moves
`.yggdrasil/.journal.yaml` to `.yggdrasil/journals-archive/.journal.<datetime>.yaml`.
The active journal disappears. The next session starts with a clean state.

The archive preserves the **intent trail** — the original decision context from conversation.
Git tells who changed which file. The archived journal tells _why_ a conversation decision
led to a graph change. The archive is gitignored — it is a local reference, not a shared
team artifact.

### Session Lifecycle

The lifecycle below applies when journal mode is **explicitly enabled** by the user (e.g. "tryb
iteracyjny", "użyj journala"). By default the agent updates the graph directly; the journal is
optional.

```
Session N:
  Agent notes → .yggdrasil/.journal.yaml grows

Session N close:
  Agent consolidates → tool archives → .yggdrasil/.journal.yaml → .yggdrasil/journals-archive/.journal.<datetime>.yaml

Session N+1 open:
  No .yggdrasil/.journal.yaml → clean start
```

If session N was interrupted without closing:

```
Session N: interrupted → .yggdrasil/.journal.yaml left on disk

Session N+1 open:
  .yggdrasil/.journal.yaml exists → signal → agent consolidates → tool archives → clean start
```

The open phase always compensates for a missing close phase.

**Lifecycle symmetry:**

| Phase | Journal                      | Drift                         | Validation              |
| ----- | ---------------------------- | ----------------------------- | ----------------------- |
| Open  | Notes from previous sessions | Changes between sessions      | Consistency before work |
| Close | Notes from current session   | Manual changes during session | Consistency after work  |

Both phases execute the same checks. Both guarantee that each session starts and ends with a
consistent graph state — regardless of what happened in the gap between sessions or during
creative work.

### Journal and Subagents

The journal is a tool for the **orchestrating agent**, not for subagents. A subagent working
on its assigned node writes directly to the graph — artifacts, relations — that is its job.

If a subagent discovers something outside its scope (an observation about another node, a
potential inconsistency, a missing relation), it returns that in its output to the
orchestrating agent. The orchestrating agent decides: note in journal, write to graph, or
discard.

**One writer, zero coordination, no file contention.**

### Position in the Truth Hierarchy

The journal sits between Intent and Graph — captured intent not yet formalized in the graph.
Archiving after consolidation guarantees that intent either reaches the graph or is in the
archive for later inspection. The active journal never accumulates indefinitely.

---

## Tool Operations

Tools are the deterministic engine through which agents and humans query and validate the graph.

Read and validation operations are stateless — they read files from disk, process, and produce
output. Journal and drift operations modify operational metadata (`.journal.yaml`,
`.drift-state`) but not semantic knowledge in the graph.

### Read Operations

| Operation            | Description                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Context assembly     | Build context package for the specified node                                                               |
| Tree view            | Display graph structure as a tree with node metadata                                                       |
| Status               | Graph summary: nodes, relations, drift state                                                               |
| Ownership resolution | For a given file path, find the owning node via mapping                                                    |
| Dependency analysis  | Show node dependencies — direct and transitive                                                             |
| Impact analysis      | Show nodes that depend on the specified node; simulate impact of planned changes on their context packages |

Read operations modify nothing. They can be called as frequently as needed.

**Impact analysis** in simulation mode runs the context assembly algorithm on a hypothetical
graph state: current state with proposed changes applied. Output is a list of affected context
packages with diffs relative to current state — added or removed knowledge elements, changed
dependency artifacts, budget shifts. The assembly algorithm is the same; only the input changes.

### Validation Operations

| Operation       | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| Validate        | Check structural integrity (errors) and completeness signals (warnings) |
| Drift detection | Detect divergence between graph expectations and mapped files           |

Validation operations do not modify semantic knowledge. Drift detection updates synchronization
metadata (`.drift-state`) in absorption mode — after an explicit human decision. This is
tracking state, not semantic knowledge.

### Journal Operations

| Operation       | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| Journal add     | Add an entry to the session journal (optional target node, intent content) |
| Journal read    | List entries from the current journal                                      |
| Journal archive | Move the current journal to the archive                                    |

Journal operations manage session operational metadata. The agent provides entry content;
tools handle file format, timestamps, and file operations.

### Initialization

| Operation  | Description                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| Initialize | Create `.yggdrasil/` structure with default config and platform agent integration file |

Initialization is the only operation that creates files in the graph structure — and it does
so only once. It creates the `.yggdrasil/` directory with a default `config.yaml` and
configures integration with the agent platform.

### Responsibility Boundary

Tools do **not** write semantic knowledge to the graph. They do not create nodes, add relations,
write artifacts, or manage knowledge elements. That is creative work belonging to the agent.

Tools maintain only operational metadata:

- Drift state (`.drift-state`) — for tracking synchronization.
- The agent creates directories, writes `node.yaml`, writes Markdown artifacts. Tools validate
  the result and give feedback.

This model is analogous to the programmer–compiler relationship: the programmer writes code,
the compiler checks correctness. The only exception is initialization, which creates the
starting structure and config. After initialization, all knowledge changes in the graph are
the work of the agent or human — tools only read.

---

## Complete Assembly Example

Given graph state:

```
config.yaml                          tags: service, requires-audit, data-access
model/orders/order-service/node.yaml tags: requires-audit
                                     relations: calls payments/payment-service
                                                        consumes: charge, refund
                                     knowledge: decisions/002-event-sourcing

aspects/audit-logging/aspect.yaml    bound to tag: requires-audit

knowledge/invariants/no-cross-service-db/knowledge.yaml  scope: global
knowledge/patterns/error-handling/knowledge.yaml         scope tags: service
knowledge/decisions/002-event-sourcing/knowledge.yaml    scope nodes: orders/order-service

flows/checkout/flow.yaml             lists orders/order-service as participant
                                     references: knowledge/patterns/saga-pattern
```

Context package for `orders/order-service` contains:

```
Step 1.  config.yaml: standards and stack
Step 2.  Invariant: No direct access to other services' databases  [global scope]
Step 3.  (no tag-scoped match — node has requires-audit, not service)
Step 4.  Decision: Event Sourcing  [node scope: lists this node]
Step 5.  Decision: Event Sourcing  [node-declared reference — DEDUPLICATED with step 4]
Step 6.  Domain context of orders/ module artifacts
Step 7.  Own artifacts of OrderService: responsibility, interface, constraints, state
Step 8.  Structural-context artifacts of PaymentService: responsibility, interface, constraints, errors
         + annotation: consumes charge, refund; on failure: retry 3x, then payment-failed
Step 9.  Aspect: Audit logging  [tag requires-audit]
Step 10. Flow: Checkout flow  [description.md, sequence.md]
         Saga Pattern  [flow knowledge reference]
```

Note: `knowledge/patterns/error-handling` is **not** included — it has tag scope `service`
and this node's tags are `requires-audit`. For the pattern to reach this node, either add
the `service` tag to the node, or add the pattern to the node's `knowledge` list. The system
never guesses.

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
