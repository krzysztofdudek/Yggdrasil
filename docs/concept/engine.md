# Engine

The [Foundation](foundation) document defines the problem and invariants.
The [Graph](graph) document defines graph structure.
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

The context package is a plain text document with XML-like tags. Tags provide structure and
metadata; content between tags is raw text (no CDATA, no escaping).

```text
<context-package node-path="orders/order-service" node-name="OrderService" token-count="3200">

<global>
**Project:** my-project
</global>

<hierarchy path="orders/">
### responsibility.md
<content of orders/responsibility.md>
</hierarchy>

<own-artifacts>
### yg-node.yaml
name: OrderService
type: service
aspects:
  - aspect: requires-audit
  - aspect: requires-auth
relations: ...
### responsibility.md
<content>
</own-artifacts>

<aspect name="Audit logging" id="requires-audit">
### content.md
<content>
</aspect>

<dependency target="payments/payment-service" type="calls" consumes="charge, refund" failure="retry 3x">
Consumes: charge, refund
### responsibility.md
<content>
</dependency>

<flow name="Checkout flow">
### description.md
<content>
</flow>

</context-package>
```

The format is fixed — the same tag structure regardless of project. Content between tags is
variable — depends on project config and the specific node. Agents read the structured output
fluently; the XML-like tags provide clear boundaries and provenance (e.g. `source="node"` vs
`source="flow:Checkout"` for aspects).

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
Exceeding the error threshold (W006 budget-error) causes the CLI to emit a warning on stderr.
The context package is still output — the agent should warn the user about the risk and
recommend splitting the node.

**High fan-out**: a node whose direct relation count exceeds the configured maximum — a signal
of excessive coupling.

**Unmatched event relations**: a node declares an `emits` relation to a target but the target
has no matching `listens`, or vice versa — event-based communication is declared unilaterally.
Tools compare declarations on both sides and signal the missing complement.

**Missing required aspect coverage**: a node of type X has `required_aspects` in config but the node
lacks coverage (direct aspect or via implies) for one or more required aspects. Tools report this as
a warning (W011).

### Role of Validation

Validation serves two audiences:

**For agents** — validation is a feedback mechanism. After modifying the graph, the agent runs
validation and receives specific, actionable feedback about what needs attention. Not
"interface is missing" but "this node has three inbound relations and no interface artifact —
three other nodes depend on its public API."

**For CI pipelines** — validation is a quality gate. A project can enforce zero graph errors
before merge, ensuring structural integrity of the semantic memory base is maintained over time.

---

## Bidirectional Drift Detection

Drift is divergence between graph and outputs. Drift detection is **bidirectional** — it
tracks both source files (code mapped via `yg-node.yaml` mappings) and graph artifacts
(`.yggdrasil/` files that participate in a node's context package). A change on either side
is drift; a change on both sides is full drift.

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
(`build-context`) but returns file paths instead of rendered content. Six layers are
collected:

1. **Own** — `yg-node.yaml` and config-filtered artifacts of the node itself.
2. **Hierarchical** — `yg-node.yaml` and artifacts of all ancestor nodes from root to parent.
3. **Aspects** — `yg-aspect.yaml` and content files for all resolved aspects (own + ancestor +
   flow-propagated, with recursive `implies` expansion).
4. **Relational dependencies** — structural-context artifacts of structural relation targets
   (`uses`, `calls`, `extends`, `implements`).
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
  `drift-sync` to record the new baseline.
- **Graph drift** — graph artifacts changed (e.g., updated responsibility, added constraints)
  but source code was not updated to match. The agent reviews the graph changes, updates
  affected source files to align with the new specification, then runs `drift-sync`.
- **Full drift** — both sides changed independently. The agent must reconcile both: review
  source changes, review graph changes, resolve any conflicts, update both sides as needed,
  then run `drift-sync`.
- **Missing** — mapped source files were deleted. The agent determines whether to
  re-materialize from the graph or remove the mapping.
- **Unmaterialized** — files have never been created. The agent materializes from the graph.

In all cases, the human decides the resolution direction. The agent executes the decision.
Tools record the new state via `drift-sync`.

---

## Tool Operations

Tools are the deterministic engine through which agents and humans query and validate the graph.

Read and validation operations are stateless — they read files from disk, process, and produce
output. Drift operations modify operational metadata (`.drift-state/`) but not semantic
knowledge in the graph.

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
packages with diffs relative to current state — added or removed content, changed
dependency artifacts, budget shifts. The assembly algorithm is the same; only the input changes.

### Validation Operations

| Operation       | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| Validate        | Check structural integrity (errors) and completeness signals (warnings) |
| Drift detection | Detect divergence between graph expectations and mapped files           |

Validation operations do not modify semantic knowledge. Drift detection updates synchronization
metadata (`.drift-state/`) in absorption mode — after an explicit human decision. This is
tracking state, not semantic knowledge.

### Initialization

| Operation  | Description                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| Initialize | Create `.yggdrasil/` structure with default config and platform agent integration file |

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
