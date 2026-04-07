# Integration

## What this document is

The [Foundation](foundation) document defines the problem and invariants. The [Graph](graph) document defines the
structure of semantic memory. The [Engine](engine) document defines deterministic mechanics.

This document defines **how agents interact with a repository that uses Yggdrasil** — the
behavioral contract between the system and the agents that use it.

## The main idea

Yggdrasil does not give agents a new workflow. It gives them a **better source of context**
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

- **When starting from a high-level goal**, the agent runs `yg select` to identify
  relevant nodes, then loads their context with `yg context --node` to get a node overview:
  aspects, flows, dependents, and artifact pointers. Graph artifacts (responsibility,
  interface, aspect content) are written in the same vocabulary developers use in task
  descriptions — making simple keyword matching against artifact content an effective selection
  mechanism. This layered flow — select, then context — gives the agent a structured reading
  phase before any design or implementation begins.
- **Before modifying a file**, the agent runs `yg context --file` to get per-file details:
  aspect requirements to satisfy, consumed dependencies, and the owning node. Aspect
  requirements are cross-cutting rules defined in aspect content files — the agent uses them
  as implementation constraints.
- **After modifying**, the agent updates graph artifacts, runs `yg check` (the structural gate),
  and then `yg approve` (the semantic verification gate). Approve runs LLM checks: it verifies
  each aspect against source code and checks whether artifacts are current. If LLM is not
  configured, approve falls back to three-axis change detection only — semantic verification
  is gracefully skipped with a notice.
- **When it notices files without graph coverage**, the agent stops. If greenfield (new code to be
  created): create proper nodes from the start; blackbox is forbidden. If existing code: ask the
  user to choose reverse-engineering (full node coverage), blackbox (at user-chosen granularity),
  or abort. Editing uncovered code without an explicit decision is not allowed.
- **When using context packages**, the agent treats the graph as the primary source of
  architectural understanding (intent, constraints, relations, rationale). For implementation-level
  precision (exact behavior, error handling, edge cases), the agent verifies against source code.

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

The agent creates and edits graph files — both YAML metadata (`yg-node.yaml`, `yg-flow.yaml`,
`yg-aspect.yaml`) and Markdown artifacts (`responsibility.md`, `interface.md`, `internals.md`,
`content.md`, etc.). Tools have no write operations to the graph — they are readers and validators of semantic content. Tools do write operational metadata (`.drift-state/`) for drift tracking; see the [Engine](engine) document.

### Condition: the agent knows how

The agent can write graph files correctly because it has five sources of knowledge about
format and conventions (described in detail in the Learning mechanisms section below):

1. The rules file tells it **when** to act
2. The configuration (`yg-config.yaml`) tells it **what** is allowed
3. The schemas (`schemas/`) show **how** files look — schemas for each graph layer (node, aspect, flow)
4. The existing graph shows **how** it looks in this project
5. Tool validation tells it **what** is wrong

### Aspect verification and ports

Two v4 mechanisms replace earlier regex-based approaches with agent-friendly alternatives:

**Aspect verification** replaces regex anchors as the primary way aspects constrain source
files. Instead of writing regular expressions that must match in source code, the agent writes
aspect content files (`content.md`) describing requirements in natural language. At approve
time, the LLM verifies each aspect's content against the actual source code. If an aspect is
not satisfied, E055 tells the agent exactly what failed.

Aspect content files are more expressive than regex (they can describe behavioral properties,
not just textual patterns) and more natural for agents to author.

**Ports** replace integration aspects as the way provider nodes declare typed contracts for
their consumers. Instead of requiring consuming nodes to prove an aspect at the architecture
level, the target (provider) node declares ports — typed contracts that consumers must satisfy
(e.g., “caller must propagate a correlation ID”). Consumers reference ports via `consumes`
on their relation entries. This makes integration requirements explicit and verifiable.

### Feedback loop: write → validate → fix

The agent does not need to know the format perfectly. It writes something, runs validation,
gets concrete feedback, fixes it. This two-gate cycle is natural and agents handle it well:

```text
Agent: creates yg-node.yaml with a relation to “payment/svc”
  → yg check: “relation target 'payment/svc' does not resolve —
    did you mean 'payments/payment-service'?”
  → Agent: fixes the path
  → yg check: no errors
  → yg approve: E055 “aspect 'no-direct-db-access' not satisfied in order-service.ts”
  → Agent: fixes the code (or updates the aspect if the requirement changed)
  → yg approve: all aspects verified
```

Validation feedback is **contextual and actionable** — not “error”, but “what is wrong,
why, and what to do.” `yg check` teaches structural correctness; `yg approve` teaches
semantic correctness. Together they form a self-teaching loop that guides the agent to build
good graphs without requiring prior knowledge of conventions.

### What tools create vs what agents create

| Element                                                        | Created by                 |
| -------------------------------------------------------------- | -------------------------- |
| `.yggdrasil/`, `yg-config.yaml`                                | Initialization (one time)  |
| Node directories in `model/` + `yg-node.yaml`                  | Agent                      |
| Node Markdown artifacts                                        | Agent                      |
| Aspect directories in `aspects/` + `yg-aspect.yaml`            | Agent                      |
| Flow directories in `flows/` + `yg-flow.yaml`                  | Agent                      |
| Aspect content files (requirements in `content.md`)            | Agent                      |
| Ports (typed contracts) in `yg-node.yaml` dependency entries   | Agent                      |
| Schemas in `schemas/` (node, aspect, flow)                     | Initialization (copied)    |
| Platform rules file                                            | Initialization (one time)  |

Tools create infrastructure (initialization). The agent creates content (everything after init),
including aspect content files (requirements verified by LLM at approve time) and ports
(typed contracts declaring what each dependency provides).

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

=== SESSION OPEN ===
- Run yg check — see full picture (drift, errors, coverage)
- Fix any issues before starting work

*Exception:* Read-only requests (e.g. "explain this") skip check.

=== BEFORE ANY TASK ===
- yg select "<goal>" → yg context --node on results
- READ phase: aspects (read content files — rules are inside),
  flows (read invariants), relations (check interfaces), parent artifacts

=== CREATIVE WORK ===

BEFORE MODIFYING A FILE:
- yg context --file <path> — resolves owner, shows aspect requirements to satisfy
- Use aspect requirements as implementation constraints

WHEN OWNER NOT FOUND (file without graph coverage):
- STOP. Determine: greenfield, partially mapped, or existing code?
- Greenfield: create proper nodes from the start; blackbox forbidden.
- Partially mapped (file inside mapped module): ask user — add to existing node or new node?
- Existing code: present three options (Reverse engineering, Blackbox, Abort); wait for user.

AFTER MODIFYING:
- Update graph artifacts (per file, not batched)
- yg check — structural gate
- yg approve --node — LLM verifies aspects + artifact freshness
  (no LLM configured → falls back to change detection only)

BEFORE A CHANGE THAT AFFECTS MANY NODES:
- Check impact of the planned change (yg impact)
- Inform the user about the consequence scope

=== SESSION CLOSE (consolidation) ===
- Run yg check — verify graph consistency
- Report exactly what nodes and files were changed
```

**Layered workflow** (the primary agent flow):

1. `yg select "<goal>"` — find relevant nodes
2. `yg context --node` on each result — node overview (aspects, flows, dependents)
3. `yg context --file <path>` — per-file details (aspect requirements to satisfy, consumed dependencies)
4. Modify source code — aspect requirements tell you what rules to follow
5. Update artifacts → `yg check` → `yg approve --node`

The directives say **when** to act, not how graph files are structured. Schema and format come from config, templates, and validation feedback.

### 2) Configuration → WHAT is allowed

**`yg-config.yaml`** contains project-level configuration:

- Which node types exist and their descriptions
- Which artifacts exist and when they are required
- Which quality thresholds apply (minimum artifact length, context budget)
- Which aspects are required on each node type

By reading this file, the agent immediately knows what node types are allowed, what aspects
each node must prove, and what quality thresholds apply. Tools read the same file to validate;
the agent reads it to understand what constraints apply to its choices.

### 3) Schemas → HOW files look

Schemas in `.yggdrasil/schemas/` define the structure of each graph layer: `yg-node.yaml` for
nodes, `yg-aspect.yaml` for aspects, `yg-flow.yaml` for flows.
The agent reads the schema for the element type it is creating or editing.

### 4) Existing graph → HOW it looks in this project

In a repository with an established graph, the agent reads existing nodes and follows the
patterns it sees. If existing service nodes have detailed responsibilities with clear
boundaries, the agent writes new nodes in the same style. If existing nodes have rich interface
specifications, the agent follows that.

This mechanism gets stronger over time. A mature graph teaches by example more effectively than
any documentation.

### 5) Validation → WHAT is wrong

After every graph modification, the agent runs validation (`yg check`) and receives concrete,
contextual feedback. At approve time, the agent gets deeper semantic feedback:

- `yg check` — structural gate: missing artifacts, broken references, budget violations,
  coverage gaps. Fast and deterministic.
- `yg approve` — semantic gate: LLM verifies aspects against source code and checks artifact
  freshness. Self-teaching errors tell the agent exactly what to fix:
  - **E055 (aspect-not-satisfied):** an aspect is not satisfied by the source file — the agent
    must fix the code or update the aspect.
  - **E056 (artifact-stale):** an artifact no longer reflects the source code — the agent
    must update it.

If no LLM is configured, approve falls back to three-axis change detection (own artifacts,
source files, upstream changes). Semantic verification is gracefully degraded, not blocked —
a notice tells the agent that LLM checks were skipped.

This feedback is **configuration-aware**. It does not teach generic graph building — it teaches
this project’s conventions. A medical project gets feedback about missing `compliance` artifacts.
A real-time system gets feedback about missing `performance` artifacts. Tools translate project
configuration into guidance at the moment the agent needs it.

### The bootstrapping problem

In a new repository there is no existing graph for the agent to learn from. The agent relies on
mechanisms (1) directives, (2) configuration, (3) schemas in schemas/, and (5) validation feedback.
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

### Graph maintenance through code changes

When code changes land through pull requests, the graph can be maintained by analyzing the diff
against existing graph coverage. A PR that changes a file mapped to a node implies potential
updates to that node's artifacts. An automated analysis of the diff against the node's
responsibility, interface, and internals can propose graph patches with high precision — changes
that are clearly correct can be auto-applied, while uncertain changes are flagged for review.

This closes the maintenance loop: the graph does not depend on developers remembering to update
it. Code changes trigger graph updates through the same CI pipeline that runs tests and linters.

---

## Knowledge persistence strategy

Conversation is ephemeral memory — it is compressed (summarization), interruptible (the user ends a
session), and does not survive between sessions in full fidelity. The graph is persistent memory —
a file on disk, in the repository, under version control.

The graph reflects system **intent**: what it is, why it is that way, and what rules apply.

### Default flow: graph + code

By default, the agent updates the graph immediately so graph and code stay synchronized.
After any graph edit: run `yg check` (structural gate) and fix issues until clean, then
run `yg approve --node` (semantic gate) which uses LLM to verify aspects hold against
source code and artifacts are current.

### Agent decision: new node or attach

When the agent creates or changes something, it decides independently: create a new node in semantic
memory or attach the change to an existing appropriate node. If unclear, it asks the user before
acting.

### Conversation lifecycle (no explicit "session")

Each conversation is work. The agent does not wait for explicit session open/close:

- **Start of every conversation:** Run `yg check` — see full picture (drift, errors, coverage).
  Fix any issues before starting work.
  *Exception:* Read-only requests skip check.
- **User signals closing the topic** (e.g. "end", "wrap up", "that's enough", "done"):
  run `yg check`, report exactly what nodes and files were changed.

---

## Cost of scope

A change in semantic memory has an impact scope proportional to the scope of the changed element:

- **Node scope** — change affects one context package; one node may need re-materialization.
- **Aspect scope** — change affects packages for nodes with a given aspect; a group may need
  re-materialization.
- **Global scope** — change affects every context package; the whole graph may need
  re-materialization.

The agent is aware of this and prefers the narrowest scope that achieves the goal.
When the user asks for a global rule, the agent informs them of the consequences:
“this will affect every node — are you sure global is necessary, or would aspect scope be enough?”

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

### Behavioral directives apply to all agents

Behavioral directives that make the parent agent graph-aware must also apply to subagents.
In practice, subagents do not automatically inherit directives from the repository — they
must be explicitly instructed to read the rules file as their first action. The graph is
a map the subagent navigates, but the subagent must first be told the map exists.

### Knowledge absorption across agent boundaries

The graph is a black hole for knowledge — it absorbs information from every source
(external documents, conversations, specifications, decisions) and must be self-sufficient.
If all external sources disappeared, the graph alone must contain enough to understand the
system.

This principle has practical consequences for subagent work:

- **Deliverables include the graph.** A subagent that creates source files without
  corresponding graph nodes has not completed its task. Code without graph coverage is
  knowledge lost — the implementation exists but its intent, constraints, and rationale
  are not captured in persistent memory.
- **Graph updates are immediate, not deferred.** Subagents update graph artifacts after
  each file, not as a final batch. Context is freshest immediately after writing code.
  Deferred updates produce shallow, low-value artifacts.
- **External knowledge is absorbed, not referenced.** When a subagent works from external
  documents (specifications, reference docs, design documents), the relevant knowledge
  must be captured in graph artifacts. The graph does not point to external sources — it
  contains the knowledge. External documents are ephemeral; the graph persists.
- **Plans integrate graph work into every step.** An implementation plan where "update
  graph" is step 7 of 8 is structurally wrong. Each step that produces or modifies source
  code includes graph updates as part of its completion criteria.

The parent agent enforces this by verifying subagent output: for every new or modified
source file, does a corresponding graph node with artifacts exist? If not, the work is
sent back for completion.

---

## Bootstrap and the first minutes

### Cold start

A new repository goes through initialization. What next?

Initialization creates `.yggdrasil/yg-config.yaml` with sensible defaults and configures integration
with the agent platform. From that moment the agent has a “graph instinct” — it knows the repository
uses Yggdrasil and follows behavioral directives.

On first `yg check`, the agent sees E022 — all git-tracked source files have no graph coverage.
The E022 message includes guidance: create proper nodes for the area you will work on, blackbox
the rest. The agent starts by blackboxing everything at a coarse granularity (a few large directory
mappings), then creates proper nodes for the area of immediate work. This achieves full coverage
quickly — E022 clears — and proper nodes are created incrementally as work touches new areas.

Value appears from the first node — not from a complete graph.

### Accelerated bootstrap

For repositories with rich git history (frequent commits with descriptive messages), auto-construction
from git history can produce a structurally complete graph with zero fabrication. The quality depends
on commit culture — repositories with hundreds of commits and commit bodies achieve near-perfect
structural coverage, while shallow histories produce a useful scaffold of nodes and basic relations
that can be enriched later.

For repositories where git history is thin, a guided extraction session works: 8-13 questions about
the codebase (asked by an extraction agent, answered by a developer who knows the code but does
not need to know Yggdrasil) produce a graph at 82-90% of expert quality. The most effective
questions are behavioral probes — “what would break if you changed X?” — rather than memory
probes — “why was X designed this way?”

Both approaches are complementary. Auto-construction provides structure; guided extraction fills
in the decisions and rationale that git history cannot capture.

### Immediate value

The first session with Yggdrasil looks different from the hundredth. But even the first provides a
measurable difference:

- The agent has `yg-config.yaml` with project configuration and initial node artifacts with technology context
- The first nodes provide semantic context for the most painful areas
- Validation gives the agent feedback on graph quality, starting the self-calibration loop

With each session the graph grows, context packages become richer, and the agent gets better.

### Incremental adoption

Incremental adoption starts with blackbox-first coverage: blackbox the entire repository at coarse
granularity, then decompose blackbox nodes into proper nodes as work touches those areas.
E022 ensures full coverage from day one — no uncovered files allowed. Proper node coverage grows
incrementally where the agent actually works; blackbox areas are decomposed on first touch.

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

Two branches may modify the same `yg-node.yaml` — e.g., one adds a relation, another changes an aspect.
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

With a graph, the agent reads focused context at two levels — `yg context --node` for the
node overview (aspects, flows, dependents) and `yg context --file` for per-file
details (aspect requirements to satisfy, consumed dependencies). Both output structured text with artifact
pointers. The context is typically 5,000-10,000 tokens regardless of project size. The agent
does not need to explore.

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

Defense: mechanical enforcement through two gates. `yg check` (structural) catches drift
(E020/E021), coverage gaps (E022), and completeness issues. `yg approve` (semantic) catches
aspect violations (E055 — an aspect is not satisfied by source code) and stale artifacts
(E056 — an artifact no longer reflects the source). The agent cannot commit without a clean `yg check`,
and approve's self-teaching errors guide the agent to fix exactly what is wrong. The system
enforces graph usage through its gates, not through soft behavioral directives alone.

Mitigation in CI: `yg check` as a quality gate catches inconsistencies regardless
of whether the agent followed directives.

### Multi-agent edit conflicts

Multiple agents or subagents modify the graph at the same time, producing inconsistency — one adds a
relation to a node another deletes, or two define overlapping responsibilities.

Defense: the graph is files in the repository. Standard version control mechanisms apply.
Validation catches structural inconsistencies after merge. The bounded scope of subagents (each works
on identified nodes) reduces the conflict surface.
