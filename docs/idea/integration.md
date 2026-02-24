# Integration

## What this document is

The [Foundation](foundation) document defines the problem and invariants. The [Graph](graph) document defines the
structure of semantic memory. The [Engine](engine) document defines deterministic mechanics.

This document defines **how agents interact with a repository that uses Yggdrasil** — the
behavioral contract between the system and the agents that use it.

## The main idea

Yggdrasil does not give agents a new workflow. It gives them a **better source of knowledge**
within the existing workflow.

Today an agent reads files, makes changes, and verifies outputs. With Yggdrasil the same agent
reads the semantic memory graph for semantic context, makes changes in both the graph and the
outputs, and verifies consistency between them.

The primary value is not in explicit user-triggered operations. It is in the fact that the agent
**naturally uses the graph in every interaction** — it loads semantic context before modifying
files, updates semantic memory after decisions, and checks consistency after changes.
This ambient, always-on integration is most of Yggdrasil’s value.

A repository with Yggdrasil becomes self-aware: it has persistent semantic memory about what it is,
what rules apply, and what must not be broken.

---

## Two layers of integration

### Layer 1: Ambient integration

The agent is graph-aware in every interaction without the user having to ask for it.
This is achieved through behavioral directives that the agent follows as part of normal work:

- **Before modifying a file**, the agent identifies which graph node owns that file,
  loads the node’s context package, and uses it to understand the semantic intent behind the code.
- **After semantic decisions** (new components, changed interfaces, new dependencies),
  the agent updates the graph to reflect the new state.
- **When it notices files without graph coverage**, the agent stops. If greenfield (new code to be
  created): create proper nodes from the start; blackbox is forbidden. If existing code: ask the
  user to choose reverse-engineering (full node coverage), blackbox (at user-chosen granularity),
  or abort. Editing uncovered code without an explicit decision is not allowed.
- **Before completing a unit of work**, the agent validates the graph’s consistency.

The user experiences this as: “my agent writes better code.” The graph is invisible infrastructure —
the agent uses it behind the scenes, the user benefits without needing to know why.

This corresponds to the **Invisible Infrastructure** level of the governance spectrum defined in
the [Foundation](foundation) document. It requires zero user training and zero process change. The agent simply
has access to better semantic memory.

### Layer 2: Explicit triggers

When the user consciously wants to work on the graph, they can signal it via agent commands
(slash commands, dedicated prompts, etc.). These triggers are shortcuts to more complex work
sessions — they are not required (the agent does the same thing ambiently), but they are
convenient when the user wants explicit control.

Example triggers:

- “Design the payments module” → agent creates nodes, relations, artifacts
- “Implement OrderService from the graph” → agent loads the context package and materializes (see [Materialization](materialization))
- “Check graph health” → agent runs validation and drift detection and reports results
- “Sync the graph with code” → agent detects divergences and proposes a resolution

These triggers are **convenience, not necessity**. Ambient behavior is the core value.
A user who never uses an explicit trigger still benefits from ambient integration.

---

## The agent writes the graph directly

The agent creates and edits graph files — both YAML metadata (`node.yaml`, `flow.yaml`,
`aspect.yaml`, `knowledge.yaml`) and Markdown artifacts (`responsibility.md`, `interface.md`,
`content.md`, etc.). Tools have no write operations to the graph — they are readers and validators of semantic knowledge. Tools do write operational metadata (`.drift-state`, `.journal.yaml`) for drift tracking and session buffering; see the [Engine](engine) document.

### Condition: the agent knows how

The agent can write graph files correctly because it has five sources of knowledge about
format and conventions (described in detail in the Learning mechanisms section below):

1. The rules file tells it **when** to act
2. The configuration (`config.yaml`) tells it **what** is allowed
3. The templates (`templates/`) show **how** files look — schemas for each graph layer (node, aspect, flow, knowledge)
4. The existing graph shows **how** it looks in this project
5. Tool validation tells it **what** is wrong

### Feedback loop: write → validate → fix

The agent does not need to know the format perfectly. It writes something, runs validation,
gets concrete feedback, fixes it. This cycle is natural and agents handle it well:

```text
Agent: creates node.yaml with a relation to "payment/svc"
  → validation: "relation target 'payment/svc' does not resolve —
    did you mean 'payments/payment-service'?"
  → Agent: fixes the path
  → validation: no errors
```

Validation feedback is **contextual and actionable** — not “error”, but “what is wrong,
why, and what to do.” This is how tools teach an agent to build good graphs without requiring
prior knowledge of conventions.

### What tools create vs what agents create

| Element                                                             | Created by                |
| ------------------------------------------------------------------- | ------------------------- |
| `.yggdrasil/` structure, `config.yaml`                              | Initialization (one time) |
| Node directories in `model/` + `node.yaml`                          | Agent                     |
| Node Markdown artifacts                                             | Agent                     |
| Aspect directories in `aspects/` + `aspect.yaml`                    | Agent                     |
| Flow directories in `flows/` + `flow.yaml`                          | Agent                     |
| Knowledge directories in `knowledge/<category>/` + `knowledge.yaml` | Agent                     |
| Schemas in `templates/` (node, aspect, flow, knowledge)             | Initialization (copied)  |
| Platform rules file                                                 | Initialization (one time) |

Tools create infrastructure (initialization). The agent creates content (everything after init).

---

## Learning mechanisms

An agent does not need prior knowledge of Yggdrasil’s graph format, conventions, or configuration.
It learns through five mechanisms:

### 1) Rules file → WHEN

A set of behavioral directives (delivered through the platform integration mechanism —
a rules file in Cursor, `CLAUDE.md` in Claude Code, instructions in Copilot) teaches the agent
**when** to use the graph. The canonical content is in `source/cli/src/templates/rules.ts`.

```text
This repository uses Yggdrasil. The graph is in .yggdrasil/

=== SESSION OPEN (reconciliation) ===
- Consolidate pending notes from the previous sessions journal
- Detect drift — files may have changed outside the previous session
- Check potentially stale knowledge (staleness)
- Report status: what needs attention before you start

*Exception:* Read-only requests (e.g. "explain this") run only step 1.

=== CREATIVE WORK ===

BEFORE MODIFYING A FILE:
- Find the file owner node (ownership resolution)
- Load the node context package (context assembly)
- Use context to understand intent, constraints, interfaces

WHEN OWNER NOT FOUND (file without graph coverage):
- STOP. Determine: greenfield, partially mapped, or existing code?
- Greenfield: create proper nodes from the start; blackbox forbidden.
- Partially mapped (file inside mapped module): ask user — add to existing node or new node?
- Existing code: present three options (Reverse engineering, Blackbox, Abort); wait for user.

AFTER SEMANTIC DECISIONS:
- Persist the decision: update the graph or write a note in the session journal

BEFORE A CHANGE THAT AFFECTS MANY NODES:
- Check impact of the planned change (impact analysis simulation)
- Inform the user about the consequence scope

=== SESSION CLOSE (consolidation) ===
- Consolidate pending journal notes into the graph
- Detect drift — files may have been manually changed during the session
- Verify graph consistency — fix any errors
- Report exactly what nodes and files were changed
```

**Execution checklists** (agent must output and execute before finishing):

- **Code-first:** Read spec → Modify code → Sync graph artifacts → Baseline hash (`yg drift-sync`).
- **Graph-first:** Read schema → Edit graph → Verify source files → Validate → Baseline hash.

The directives say **when** to act, not how graph files are structured. Schema and format come from config, templates, and validation feedback.

### 2) Configuration → WHAT is allowed

`config.yaml` is both tool configuration and a self-documenting schema for the agent.
By reading it, the agent immediately knows:

- Which node types exist (service, repository, controller, …)
- Which tags exist (requires-audit, high-throughput, …)
- Which artifacts exist, when they are required, and what they should contain
  (each has a `description`)
- Which knowledge categories exist and what they mean
- Which quality thresholds apply

One file, two audiences, zero duplication: tools read it to validate; the agent reads it to
know what is allowed.

### 3) Templates → HOW files look

Schemas in `.yggdrasil/templates/` define the structure of each graph layer: `node.yaml` for
nodes, `aspect.yaml` for aspects, `flow.yaml` for flows, `knowledge.yaml` for knowledge elements.
The agent reads the schema for the element type it is creating or editing.

### 4) Existing graph → HOW it looks in this project

In a repository with an established graph, the agent reads existing nodes and follows the
patterns it sees. If existing service nodes have detailed responsibilities with clear
boundaries, the agent writes new nodes in the same style. If existing nodes have rich interface
specifications, the agent follows that.

This mechanism gets stronger over time. A mature graph teaches by example more effectively than
any documentation.

### 5) Validation → WHAT is wrong

After every graph modification, the agent runs validation and receives concrete, contextual
feedback:

- Which artifacts are required for this node type and why
- Which references do not resolve and what might be wrong
- Which tags do not exist in configuration
- Whether the context package fits into the budget

This feedback is **configuration-aware**. It does not teach generic graph building — it teaches
this project’s conventions. A medical project gets feedback about missing `compliance` artifacts.
A real-time system gets feedback about missing `performance` artifacts. Tools translate project
configuration into guidance at the moment the agent needs it.

### The bootstrapping problem

In a new repository there is no existing graph for the agent to learn from. The agent relies on
mechanisms (1) directives, (2) configuration, (3) schemas in templates/, and (5) validation feedback.
The agent fills in content, tools validate, the agent fixes.

The first few nodes are the hardest — no examples and limited feedback. Quality improves quickly as
the graph grows and the self-calibrating granularity loop kicks in.

For repositories with existing files, ambient behavior (described next) provides a faster bootstrap.

---

## Graph-building is normal behavior

There is no separate “import” or “ingest” operation. Building the graph from existing files is the
same behavior as building it for new files — the agent sees something that should be in semantic
memory and proposes creating a node.

Situations where the agent creates or updates nodes:

- **A new project adopts Yggdrasil.** The agent sees existing files and proposes nodes for key
  components.
- **Someone submits a PR without the graph.** The agent sees new files without graph coverage and
  asks whether to create nodes.
- **The agent implements a new feature.** It creates nodes BEFORE writing outputs (graph →
  materialization) or in parallel.
- **The agent reviews someone else’s change.** It notices missing coverage or divergence and asks
  what to do.
- **The user absorbs drift.** The agent updates the graph to reflect file changes.

This is the **same skill** in different contexts. Not “import mode” and “normal mode.” One mode:
working in the repository, with the graph as part of the repository, maintaining consistency.

Knowing how to create nodes from existing files is universal knowledge — not isolated to a single
operation. An agent that can describe the meaning of a new component can also describe the meaning
of an existing one. The mechanism is the same: read, understand, capture in semantic memory.

---

## Knowledge persistence strategy

Conversation is ephemeral memory — it is compressed (summarization), interruptible (the user ends a
session), and does not survive between sessions in full fidelity. The graph is persistent memory —
a file on disk, in the repository, under version control.

The graph reflects system **intent**: what it is, why it is that way, and what rules apply.

### Default flow: graph + code, no journal

By default, the agent updates the graph immediately (no journal) so graph and code stay synchronized.
After any graph edit: run `yg validate` and fix issues until clean.

### Optional journal mode (ONLY if the user explicitly requests it)

If the user says to use a journal / iterative mode:

- Use `yg journal-add --note "..." [--target <node>]` to buffer intent while requirements are ping-ponging.
- Still keep the graph minimally consistent (e.g., create missing nodes/mappings to maintain ownership).
- When the user signals wrapping up: consolidate notes into the graph and archive.

The journal is not the default path — it is enabled only on explicit user request.

### Agent decision: new node or attach

When the agent creates or changes something, it decides independently: create a new node in semantic
memory or attach the change to an existing appropriate node. If unclear, it asks the user before
acting.

### Conversation lifecycle (no explicit "session")

Each conversation is work. The agent does not wait for explicit session open/close:

- **Start of every conversation:** Preflight — (1) `yg journal-read` (consolidate, archive if entries exist),
  (2) `yg drift` (present states `ok`/`drift`/`missing`/`unmaterialized`, ask absorb or reject),
  (3) `yg status` (report health), (4) `yg validate` (if W008, update knowledge artifacts).
  *Exception:* Read-only requests run only step 1.
- **User signals closing the topic** (e.g. "end", "wrap up", "that's enough", "done"): Consolidate journal (if used),
  archive, drift, validate, report exactly what nodes and files were changed.

If the conversation is interrupted before wrap-up, journal notes (if any) survive on disk and are
processed during the next conversation's preflight. The system is interruption-resilient.

### The journal as an intent trace

The journal preserves the original context of decisions — a literal record of intent from the
conversation. Git says *who* changed *which file*. The journal says *why* — which conversational
decision led to a change in semantic memory.

Journal mechanics — file format, entry model, reconciliation algorithm — are described in the Engine
document.

---

## Cost of scope

A change in semantic memory has an impact scope proportional to the scope of the changed element:

- **Node scope** — change affects one context package; one node may need re-materialization.
- **Tag scope** — change affects packages for nodes with a given tag; a group may need
  re-materialization.
- **Global scope** — change affects every context package; the whole graph may need
  re-materialization.

The agent is aware of this and prefers the narrowest scope that achieves the goal.
When the user asks for a global rule, the agent informs them of the consequences:
“this will affect every node — are you sure global is necessary, or would tag scope be enough?”

The agent does not block — it allows. But it asks, because the cost is real: applying a global
change means every mapped node should be re-materialized against the new rule.

---

## Subagent model

When work is delegated to subagents (a common pattern in modern AI tools), the graph provides a
coordination mechanism.

### Direction, not micromanagement

A parent agent gives a subagent a task and identifies the relevant graph nodes. The subagent has
access to tools and the graph. It builds its own context by querying tools for needed nodes,
explores graph structure when it encounters unexpected dependencies, and makes implementation
decisions within bounded context.

The parent agent does **not** assemble context packages ahead of time and inject them into the
subagent prompt. That would be wasteful (the parent reads context just to pass it on) and rigid
(the subagent cannot adapt to what it discovers during implementation).

The graph is a **map the subagent navigates**, not a **briefing the parent prepares**.
The subagent reads the map when and where it needs it, consuming tokens only for the context it
actually uses.

### What the graph gives multi-agent work

- **Bounded scope.** Each subagent works on identified nodes. The graph defines what each node is
  responsible for and what it is not, preventing subagents from stepping on each other.
- **Dependency interfaces.** When a subagent must call code in another node, it reads the interface
  specification from semantic memory instead of reading implementation. This preserves abstraction
  boundaries.
- **Shared knowledge.** All subagents read from the same semantic memory. There is no risk one
  subagent has a different understanding of the system than another.

### The journal belongs to the parent agent

Subagents do not write to the session journal. A subagent working on its node writes directly to the
graph — that is its job. If the subagent discovers something outside its scope (an observation about
another node, potential inconsistency, missing relation), it reports it back to the parent agent.
The parent agent decides: write to the graph, note it in the journal, or discard it.

This model ensures a single journal writer, zero coordination, and no contention on the file.

### Behavioral directives apply to all agents

Behavioral directives that make the parent agent graph-aware also apply to subagents.
When a subagent is run in the same repository, it inherits the same directives and the same tool
access. No special configuration is needed — graph awareness propagates through the repository,
not through agent-to-agent communication.

---

## Bootstrap and the first minutes

### Cold start

A new repository goes through initialization. What next?

Initialization creates `.yggdrasil/config.yaml` with sensible defaults and configures integration
with the agent platform. From that moment the agent has a “graph instinct” — it knows the repository
uses Yggdrasil and follows behavioral directives.

The graph is empty, but the agent starts building it during normal work. The user asks for a change
in the orders module — the agent notices missing coverage, proposes creating a node, the user agrees,
the agent creates `model/orders/order-service/node.yaml` + `responsibility.md`. Next time work touches
that module, the agent loads the context package and writes better code.

Value appears from the first node — not from a complete graph.

### Immediate value

The first session with Yggdrasil looks different from the hundredth. But even the first provides a
measurable difference:

- The agent has `config.yaml` with stack and standards (global context in every package)
- The first nodes provide semantic context for the most painful areas
- Validation gives the agent feedback on graph quality, starting the self-calibration loop

With each session the graph grows, context packages become richer, and the agent gets better.

### Incremental adoption

Incremental adoption (see [Foundation](foundation)) happens through the agent’s natural behavior: proposing nodes
when it sees missing coverage. Coverage grows organically where the agent actually works. Modules
that are not modified do not get nodes — coverage follows activity.

---

## Graph evolution patterns

### Greenfield

New project. The graph is empty. The agent builds it alongside the first files:

```text
empty → a few shallow nodes → growing coverage → deepening artifacts
        in response to bad outputs → mature graph
```

Characteristic: the graph and outputs grow together. There is no “import” phase.
Self-calibration starts early.

### Brownfield

Existing project adopts Yggdrasil:

```text
initialization → agent builds nodes during normal work → shallow coverage
                grows organically → deepening in painful areas → mature graph
```

Characteristic: coverage grows from places where the agent actually works. Modules untouched for
months may have no nodes. This is intentional — semantic memory grows where it is needed.

### Refactoring

A stable graph undergoes restructuring:

```text
stable → broken mappings (refactor changed paths) → validation reports issues
        → agent fixes mappings and relations → stable (new structure)
```

Characteristic: semantic memory (responsibility, interface, constraints) survives refactoring even
if mappings temporarily do not. Tools report what is broken; the agent fixes it.

---

## Integration with process tools

Yggdrasil is semantic memory infrastructure. It does not dictate how to gather requirements, plan
work, or organize tasks. External process tools (specification, planning, task management) can
integrate with Yggdrasil via its tools:

- A process tool captures requirements and the agent translates them into the graph
- A process tool plans implementation and the agent materializes from context packages
- A process tool validates progress and checks graph health
- A process tool handles divergences and the agent resolves drift

The boundary is clear: process tools manage workflow (what to do in what order). Yggdrasil manages
semantic memory (what the system is and how to assemble context for implementation). Neither
invades the other's domain.

This separation means Yggdrasil works with any process — heavy or light, automated or manual,
tool-assisted or conversational. The only requirement is that semantic decisions eventually land
in the graph.

---

## Collaboration in version control

The graph is files in the repository. Standard version control mechanisms (branches, merges,
conflict resolution) apply.

### Merge conflicts

Two branches may modify the same `node.yaml` — e.g., one adds a relation, another changes a tag.
The resulting merge conflict is a YAML conflict that git reports normally.

Tools do not resolve conflicts — that requires human or agent judgment. But validation after merge
immediately shows whether the result is structurally consistent. If not, it reports what exactly is
broken.

### Work pattern

```text
1. Create a branch
2. Agent modifies the graph and outputs
3. Validate on the branch → no errors
4. Merge into main
5. Validate after merge → verify consistency
6. If errors → agent fixes
```

This is the same pattern as for code — branch, change, validate, merge, validate again.
Yggdrasil does not require a special VCS workflow.

---

## Token economics

The graph introduces overhead: building and maintaining semantic memory costs tokens.
That overhead is an investment that pays back in two ways.

### Reduced exploration

Without a graph, the agent explores the repository speculatively — opening related files,
scanning for patterns, building understanding from raw files. This is expensive and repeated every
session.

With a graph, the agent reads a focused context package — pre-structured knowledge assembled
deterministically. The package is typically 2,000–5,000 tokens regardless of project size.
The agent does not need to explore.

### Reduced correction loops

Without a graph, the agent guesses constraints, interfaces, and semantic intent. Bad guessing
produces bad code. A human fixes. The agent tries again. Many rounds.

With a graph, the agent knows constraints, interfaces, and intent from the context package.
First-try accuracy is higher. Fewer correction rounds.

### The tipping point

For small projects and one-off sessions, graph overhead exceeds savings.
For projects that live longer than a few sessions and grow beyond trivial size, savings accumulate:

- Semantic memory survives between sessions (no re-exploration)
- Semantic memory survives between people (no re-explaining)
- Semantic memory survives between agents (no re-teaching)
- Context packages remain bounded regardless of repository size (no degradation)

Yggdrasil is not for prototypes or one-off experiments. It is for projects where accumulated
semantic memory has long-term value.

---

## Failure modes

### Empty graph

The most likely failure: the graph is structurally valid but contains shallow, useless content.
Nodes exist, but their artifacts say nothing meaningful. Context packages are technically assembled
but provide no real direction.

Defense: quality criteria in configuration (minimum artifact length), tool warnings about shallow
content, and the self-calibrating granularity loop (shallow graph → bad output → human says
“that’s wrong” → agent deepens semantic memory).

The feedback loop is the primary defense. The graph cannot remain empty if it is actively used for
materialization — bad output forces improvement.

### Old graph

The graph accurately described the system six months ago, but was not maintained. Outputs evolved,
semantic memory did not. Context packages produce outputs that conflict with the current repository
state.

Defense: drift detection. Tools compare graph expectations with files and report divergences.
If drift detection runs regularly (ambient integration, CI pipeline, or periodic audit), staleness
is caught before it accumulates.

### Graph overgrowth

A simple application with an overbuilt graph — fifty nodes, complex flows, detailed aspects — where
semantic memory is more complex than the outputs it describes.

Defense: governance spectrum. Small projects use the invisible infrastructure level — the agent
maintains a minimal graph for its context needs. Complexity grows only where outputs require it.
A CRUD endpoint does not need a state machine specification.

### The agent ignores the graph

The agent has access to semantic memory but returns to default behavior: reads the repository
directly, ignores context packages, does not update the graph after changes.

Defense: behavioral directives make graph usage the default. Drift detection catches changes made
without updating semantic memory. But ultimately this is a soft dependency — the system enables good
behavior, it cannot fully enforce it.

Mitigation in CI: validation and drift detection as a quality gate catch inconsistencies regardless
of whether the agent followed directives.

### Multi-agent edit conflicts

Multiple agents or subagents modify the graph at the same time, producing inconsistency — one adds a
relation to a node another deletes, or two define overlapping responsibilities.

Defense: the graph is files in the repository. Standard version control mechanisms apply.
Validation catches structural inconsistencies after merge. The bounded scope of subagents (each works
on identified nodes) reduces the conflict surface.
