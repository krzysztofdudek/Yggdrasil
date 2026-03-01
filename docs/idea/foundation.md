# Foundation

## The Problem

AI agents degrade proportionally to project size. At 20 files — excellent. At 200 — unreliable.
At 2,000 — dangerous. The cause is not intelligence: the same model handles all three scenarios.
The cause is what the model knows at the moment work begins.

An agent operating directly on files faces an impossible trade-off:

- **Too little context**: sees one file, doesn't understand the system, breaks neighboring contracts.
- **Too much context**: receives 200,000 tokens of repository dump, loses signal in noise,
  makes incorrect assumptions.

Neither extreme produces reliable results. Larger context windows won't fix this —
200,000 tokens of noise is not understanding. An agent needs 2,000 right tokens,
not 200,000 random ones.

Current tools — code indexing, RAG, symbol search — answer questions like
"where is function X defined?" or "show me file Y." They don't answer semantic questions:
"what is the auth module responsible for?", "what constraints must the orders service satisfy?",
"what breaks if I change the payments interface?" This kind of knowledge does not exist in the code.
It cannot be reliably extracted by search. This is a context problem. It is structural —
not solvable by better models or longer windows. It requires a structural solution.

---

## The Thesis

AI agents need a persistent, structured semantic memory of the system — one that goes beyond
code indexing and survives between sessions, agents, and people.

**Key insight**: AI agents don't need to see the entire repository. They need to see exactly
the context required for the piece they're working on — and nothing more.
Small, precise context always beats massive, noisy.

The structural solution is an intermediate semantic memory layer — a formal graph that lies
between human intent and generated output. The graph stores the repository's semantic memory:
modules, their responsibilities, interfaces, constraints, dependencies, cross-cutting requirements.
From this graph, the system mechanically assembles a bounded context package for each
implementation unit. The agent receives this package and produces output.

---

## Two Types of Memory

Version control systems gave repositories memory of changes. A repository with git knows
what happened: who changed which file, when, in what context, what the differences were.

Yggdrasil gives repositories persistent semantic memory. A repository with Yggdrasil knows
what it _is_: what parts it consists of, what depends on what, why certain decisions were made,
what rules apply, what breaks on change.

These two types of memory are orthogonal. Both are needed. Change memory has existed for
20 years. Semantic memory didn't exist because there was no one to consume it — a human reads
code and builds a mental model themselves. An agent doesn't build a mental model. An agent
processes text. It needs that model delivered in structured form.

A repository with Yggdrasil is self-aware.

---

## Interaction Model

The typical interaction model: a human talks to an agent, and the agent manages the repository —
both the graph and the outputs. The graph is files — they can be edited directly by a human,
another agent, a script, or any tool. Conversation with the agent is the primary but not the
only interface.

```
Human ──(conversation)──► Agent ──(reads/writes)──► Repository
                                                     ├── outputs (code, documents)
                                                     └── graph  (.yggdrasil/)
```

**Agent workflow on a repository with Yggdrasil:**

1. **Understanding intent** — conversation with the human, optionally assisted by external
   process tools.
2. **Building semantic memory** — creating or updating graph nodes with semantic descriptions,
   constraints, interfaces, relationships. Intent can be buffered in a session journal before
   reaching the graph (optional, see [Engine](engine)); by default the agent updates the graph directly.
3. **Assembling context** — tools build context packages from the graph (see [Graph](graph), [Engine](engine), [Tools](tools)).
4. **Materialization** — agent or subagents produce outputs from context packages (see [Materialization](materialization)).
5. **Drift detection** — tools compare graph expectations with actual state (see [Engine](engine)).

Yggdrasil is semantic memory infrastructure for steps 2–5. How intent is captured — through
conversation, specifications, tickets, or external tools — is outside Yggdrasil's scope.
What matters is that intent reaches the graph as semantic knowledge, and from there
Yggdrasil takes over. See [Integration](integration) for how agents interact with the system.

Although the primary use case is code, the model is not limited to code. A repository can
contain documentation, specifications, research work — any collection of files requiring a
coherent, maintained semantic memory. The graph describes the meaning of that collection
regardless of its nature.

---

## Atomic Invariant (Overrides Everything)

**CODE ↔ GRAPH ARE ONE.**

- Code changed → graph artifacts MUST be updated in the same response. No exceptions.
- Graph changed → source files MUST be verified or updated in the same response. No exceptions.
- There is no "code-only" response. There is no "graph-only" response (unless explicitly a dry-run plan).
- Completing a response with one side changed but the other not updated violates the core contract of Yggdrasil.

---

## Five Invariants

These are the non-negotiable properties of the system. Everything else — tools, workflow,
delivery format — is secondary.

### 1. Two Worlds: Graph and Outputs

In the repository there are two distinct entities.

The **graph** is the formal map of the system — its persistent semantic memory. It describes
what the system _is_: modules, their responsibilities, interfaces, constraints, dependencies,
cross-cutting requirements. The graph is structured knowledge stored as directories, metadata,
and content artifacts. It is versionable, diffable, and readable by both humans and agents.

**Outputs** are the materialization of the graph. The primary flow is Graph → Outputs: an agent
reads a context package from the graph and produces an implementation. When graph and outputs
diverge, the graph is the intended truth — unless the divergence is intentional, in which case
the graph is updated to reflect reality.

The agent manages both directions: forward (graph → outputs) and absorption (outputs → graph).
The human decides which direction to take.

This separation exists because outputs and semantic knowledge are different kinds of information.
Outputs say _how_. The graph says _what_, _why_, and _what the rules are_. An agent reading
500 source files cannot reliably reconstruct module responsibilities, design constraints, or
cross-cutting requirements. The graph captures this knowledge explicitly.

### 2. Bounded Context Assembly

For each implementation unit (a node in the graph), deterministic tools assemble a context
package — a single document containing exactly the knowledge the agent needs.

The context package is multi-layered. Each layer carries a different level of abstraction,
from most general to most specific:

- **World identity** — technology stack, standards, design conventions (changes least often)
- **Long-term memory** — decisions, patterns, system invariants (changes rarely)
- **Domain context** — hierarchy, context of parent modules, domain business rules
  (changes on reorganization)
- **Unit identity** — the node's own artifacts: responsibility, interface, constraints
  (changes on node evolution)
- **Surroundings** — dependency interfaces, cross-cutting concerns, end-to-end flows
  (changes on neighbor evolution)

These layers operate simultaneously — an agent needs all of them at once, but with different
intensity. When implementing a method, it focuses on the surroundings layer (dependency
interface) and unit identity (own contract), while world identity (stack, standards) and
long-term memory (patterns, decisions) inform _how_ to implement, not _what_.

The result is typically 2,000–5,000 tokens (5,000 is the warning threshold — packages above
that signal growing complexity). The size is bounded regardless of project size —
a node in a graph with 10 nodes and a node in a graph with 10,000 nodes produce packages
of similar size. The assembly algorithm is defined in the [Engine](engine) document.

### 3. Truth Hierarchy

Three layers of knowledge with clear precedence:

```
Intent → Graph → Outputs
(why)    (what)  (how)
```

- **Intent**: what the user wants and why. Can be expressed through conversation,
  specifications, tickets, or any other form. Yggdrasil does not dictate how intent is
  captured — that is the domain of process tools, not semantic memory infrastructure.
- **Graph**: complete semantic memory. Self-sufficient — an agent implementing a node should
  need only the context package built from the graph. If it must reach back to the original
  intent, the graph is incomplete.
- **Outputs**: derivatives of the graph. Never a source of truth unless deliberately absorbed
  into the graph.

Yggdrasil operates on the Graph → Outputs boundary. It guarantees that the graph is
self-sufficient for implementation and that outputs remain synchronized with the graph.
How intent reaches the graph is outside Yggdrasil's scope.

Conflicts are resolved in favor of the higher layer. The human can override at any time —
the hierarchy is the default rule, not a cage.

### 4. Self-Calibrating Granularity

When an agent produces a bad output, the cause lies in the graph — not in the output.
An unclear description produces an unclear implementation. A precise description produces
a precise implementation.

**Feedback loop:**

```
Human: "this output is wrong"
  → Agent identifies what was missing or ambiguous in the graph
  → Agent adds specific validation rules, explicit edge cases, precise interfaces,
    constraint specifications
  → Agent re-materializes from the improved graph
  → Better output
```

The graph over time converges to the level of detail that consistently produces good outputs
at a given AI capability level. This is the system's self-calibration mechanism. The graph
starts general and becomes more granular where needed.

Not every node requires the same level of detail — a simple utility needs a one-sentence
description; a complex service with business rules needs explicit constraints, state machines,
and error handling specifications. The graph grows in detail where detail matters.

The question is never "how do I fix this output?" — it is "what was missing in the graph
that led to the bad output?" The human asks this in conversation. The agent finds the answer
and fixes the graph.

### 5. Division of Labor

| Actor | Responsibility                                                                                                                       | Deterministic? |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Tools | Mechanical operations: graph parsing, context package assembly, dependency resolution, consistency validation, drift detection       | Yes            |
| Agent | Creative work: conversation with human, building semantic memory, writing and editing graph files, generating outputs, writing tests | No             |
| Human | Direction and judgment: expressing intent, answering questions, approving proposals, correcting errors, making trade-off decisions   | No             |

Tools never guess — they are a deterministic engine. The agent is the primary operator of
the repository — it writes both the graph and outputs. The human steers through conversation.

**Key distinction**: tools read and validate the graph, but do not write it. The agent writes
the graph, and tools give it feedback on quality and consistency of what it wrote. This model
is analogous to a compiler — the programmer writes code, the compiler checks correctness
and reports errors.

### Failure States

The agent has fundamentally broken Yggdrasil if it does any of the following:

- Modified source code without updating graph artifacts in the same response.
- Modified graph files without verifying or updating source code alignment in the same response.
- Resolved a code↔graph inconsistency without asking the user first.
- Created or edited a graph element without reading its schema in `.yggdrasil/schemas/`.
- Ran `yg drift-sync` before updating graph artifacts.
- Ran `yg drift-sync` after a graph-only change without verifying source files.
- Used blackbox coverage for greenfield or new code.

---

## The Graph as Persistent Memory

The graph is not generated on demand. It is built incrementally through conversations,
sessions, and team members. Each interaction enriches it.

After months of development, the graph contains the complete semantic memory of the project:
module responsibilities, interfaces, constraints, dependencies, cross-cutting concerns, flows.

This knowledge:

- **Survives sessions.** A new conversation starts with full semantic context, not from scratch.
- **Survives people.** A new team member's agent reads the graph and immediately understands
  the system.
- **Survives tools.** Switching from one AI agent to another requires no knowledge transfer —
  the graph _is_ the knowledge.
- **Survives model upgrades.** Upgrading the AI model does not lose accumulated semantic memory.

This is fundamentally different from code indexing or RAG, which reconstruct understanding
on every query from raw files. The graph is pre-structured knowledge — answers to semantic
questions, already formulated, already bounded, ready to be assembled into context packages.

A repository with Yggdrasil is self-aware. It knows what it is, how it works,
and what must never change.

---

## Pragmatic Drift Compromise

The two-worlds model is rigorous but not naïve. Outputs will diverge from the graph through
direct edits, hotfixes, experiments, or work in sessions not using the graph. The system
doesn't forbid this. It detects it.

**Drift** is divergence between the graph and outputs. The system detects drift and the agent
presents resolution options:

- **Absorption**: update the graph to match the changes — outputs become the truth.
- **Rejection**: re-materialize from the graph — the graph remains the truth.

The human decides. The agent executes. Drift is not a sin — unresolved drift is. The system
guarantees that drift is always visible and always resolved.

The drift detection mechanism is described in the [Engine](engine) document.

---

## Governance Spectrum

Different projects need different levels of discipline. Yggdrasil supports a spectrum:

- **Invisible infrastructure.** The agent uses the graph internally. The human may not even
  know it exists. Output quality improves silently.
- **Visible knowledge base.** The human browses the graph, asks the agent semantic questions,
  reviews graph changes alongside output changes.
- **Enforced governance.** Graph validation runs in CI. Drift detection blocks merges.
  Architects review graph changes in pull requests.

The same tools support all three levels. The difference is configuration and process, not tools.
A solo developer on a side project and a 200-person team working on a mission-critical system
use the same graph format and the same tools — at different points on the governance spectrum.

---

## Why Flat Files Aren't Enough

AI coding agents already have primitive forms of memory — CLAUDE.md, .cursorrules,
copilot-instructions.md. These are flat files with instructions and context. They are not
enough because:

- **They don't scale.** 1,000 lines in a single file is noise — the agent loses signal just
  as it does with 200,000 tokens of raw files.
- **They are not queryable per-unit.** There is no way to say "give me context for
  OrderService." Either the whole file or nothing.
- **They have no validation.** No one checks whether the content is consistent, complete,
  current. The file rots just like documentation.
- **They have no layered structure.** Everything is at one level — global standards next to
  details of a single service.
- **They don't survive tool changes.** CLAUDE.md works with Claude Code. .cursorrules works
  with Cursor. The format is proprietary per-platform.

Yggdrasil doesn't compete with these mechanisms — it uses them. Yggdrasil's rules file is
delivered through the platform's own mechanism (rules file in Cursor, CLAUDE.md in Claude Code,
instructions in Copilot). That file contains behavioral directives that teach the agent when
and how to use the graph. The platform provides the mechanism, Yggdrasil provides the content.

---

## Incremental Adoption

The graph can grow incrementally — coverage follows where the agent actually works. A project
with 500 files can start with 3 nodes for the one module that's causing problems.

**Condition:** When entering an area without graph coverage, the agent must not edit code until
coverage is decided. If greenfield (new code to be created): create proper nodes from the start;
blackbox is forbidden. If existing code: the user chooses reverse-engineer (full node), blackbox
(at chosen granularity), or abort. Incremental adoption means "the graph grows where we work" —
not "we work in code without a graph."

Value grows with coverage, but minimal coverage delivers minimal value immediately.
This is not an all-or-nothing decision — it is an incremental process, like adding tests
to an existing project.

---

## What It Is Not

- **Not documentation.** Documentation is for humans and rots because humans stop reading it.
  The graph is for agents — it lives because agents consume it on every operation.
  Bad graph → bad output → immediate fix. The feedback loop keeps it current.

- **Not a code generator.** Code generators use templates. The graph enables AI-based
  materialization, where an agent reads rich, multi-layered context and produces implementation.
  Output quality is a function of graph quality, not template sophistication.

- **Not a low-code platform.** Output is real code (or a document, or whatever in the chosen
  stack), in the user's repository, with their conventions. No vendor lock-in. Remove the graph,
  and the project works identically.

- **Not a diagramming tool.** Architectural diagrams are pictures of maps. The graph is a
  navigable, queryable map that produces outputs and validates itself.

- **Not a replacement for code indexing or RAG.** Those answer "where is X" — the graph answers
  "what is X responsible for, what are its constraints, and what breaks if you change it."
  They are complementary, not competitive.

- **Not a process tool.** Yggdrasil does not dictate how to gather requirements, plan work,
  or organize tasks. It is semantic memory infrastructure on which any process can build.
