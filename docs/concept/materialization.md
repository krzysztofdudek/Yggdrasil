# Materialization

## What this document is

The [Foundation](foundation) document defines the problem and invariants. The [Graph](graph) document defines the
structure of semantic memory. The [Engine](engine) document defines deterministic mechanics.
The [Integration](integration) document defines the behavioral contract with agents.

This document defines **what happens when semantic memory becomes an output** — the process
by which a context package transforms into an implementation.

Materialization is the point where Yggdrasil delivers its primary value. Everything before
it — building the graph, assembling context, validating — exists to make this moment precise.

---

## The context package as a specification

A context package is not "input to a code generation function." It is a **specification** —
a complete description of what the node is, what it depends on, what constraints it must
satisfy, and what semantic context it exists within.

An agent reading a context package knows:

- What the system is (world identity)
- What rules always apply (long-term memory)
- What domain the node lives in (domain context)
- What it is specifically responsible for (unit identity)
- Who it collaborates with and how (surroundings)

This is sufficient knowledge to produce an output. If it is not sufficient — the semantic
memory graph is incomplete, and that is a signal to enrich the graph, not to search for
information outside it (see Success Metric in the [Engine](engine) document).

---

## When materialization happens

Materialization is not a separate step in a pipeline. It is one of the things the agent
does naturally while working on the repository. The agent does not need an explicit
"materialize now" command — it sees a node with a mapping, sees that the output does not
exist or is outdated, and produces it.

Situations leading to materialization:

- **New node with a mapping.** The agent created a node describing a new component.
  The mapping points to a file that does not exist yet. Drift state is `unmaterialized`.
  The agent produces the output.
- **Graph change.** The agent updated artifacts or relations of an existing node.
  The output under the mapping does not reflect the changes. The agent produces a new output.
- **Drift rejection.** The human decided that a manual change to a file was a mistake.
  The agent re-materializes from the graph.
- **Work on multiple nodes.** The agent implements a feature spanning several nodes.
  For each, it builds context and materializes.
- **Wide-scope knowledge change.** The agent added a global invariant or changed an aspect.
  The context packages of all affected nodes changed. Outputs under mappings potentially
  require re-materialization (see Cost of scope in the [Integration](integration) document).

In all cases the mechanism is the same: Context Package → Agent → Output under mapping path.

After completing a materialization or after resolving drift, the agent runs
`yg drift-sync --node <path>` to record the new baseline in `.yggdrasil/.drift-state/`.

---

## What the agent sees

During materialization, the agent has access to:

- **The context package** — the node's semantic memory, deterministically assembled by tools.
- **The existing output** (if it exists) — the file under the mapping path. The agent
  decides whether to do an incremental update or a full replacement.

The context package contains the interfaces of dependencies, not their implementations.
The agent does not need to read the code of neighboring modules to understand their
contract — the context package provides that knowledge. This is a fundamental property of
the system: knowledge about dependencies reaches the agent through the graph, not through
code exploration.

If the agent has to explore the repository to understand what a node should do, the context
package is incomplete. The fix is always on the graph side (see Self-calibration below).

---

## Stages and ordering

When an agent materializes multiple nodes in a single session, ordering matters. Structural
relations form an acyclic dependency graph (see [Graph](graph) document), which yields a topological
order.

Stage mechanics are described in the [Engine](engine) document (Dependency Resolution Order section).
Consequences for materialization:

- **Stage N before Stage N+1.** The output of node A, which `calls` B, imports, calls, or
  extends the output of B. If B's output does not exist, A's output cannot integrate.
  The agent materializes B before A.
- **Parallelism within a stage.** Nodes in the same stage are independent. A parent agent
  can delegate them to subagents working in parallel. Each subagent builds its context
  independently (see Subagent model in the [Integration](integration) document).
- **Event relations do not force ordering.** An emitter does not depend on a listener.
  Nodes connected by `emits`/`listens` can be materialized in any order.

When working on a single node, ordering is not an issue — dependencies already exist as
outputs of previous sessions. The ordering problem arises when materializing many new nodes
at once.

---

## Self-calibration in practice

The [Foundation](foundation) document defines self-calibrating granularity as an invariant.
In materialization, it looks like this:

```text
Agent: materializes OrderService from its context package.
Output: code creates orders, but validation is generic (the agent
        invented the rules because constraints.md did not exist).

Human: "validation is wrong — an order must have min 1 item,
        max 100 items, and the total must be > 0"

Agent: adds constraints.md to the node with specific rules.
       Runs validation — no errors.
       Re-materializes from the improved context package.

Output: validation is precise — exactly the rules the human described.
```

Key observations:

- The agent did not fix the code directly — it **enriched the graph**, then re-materialized.
  The output is a derivative of semantic memory.
- The human did not have to read the code — they spoke at the level of business rules.
  The agent translated between levels.
- The graph became more detailed exactly where detail was needed. Other nodes were
  not affected.
- The next time this node is materialized (e.g. after a dependency interface change),
  validation will remain precise — the rules are in the graph.

This is not a one-off cycle. It is a continuous process: every materialization either
confirms the graph is sufficient (good output) or reveals a gap (bad output → enrich graph).
Over time, the graph converges to the level of detail that consistently produces good outputs.

---

## Blackboxes and materialization

Nodes with `blackbox: true` (see [Graph](graph) document) do not participate in materialization
or topological ordering. They describe unexplored areas — their artifacts may be coarse
or incomplete, but they still enter the context packages of dependent nodes.

Consequence: a blackbox node is never materialized, but it **affects the materialization
of others**. A new service depending on a blackbox legacy module gets its interface in
its context package and implements integration based on available knowledge. If the
integration output is bad, it is a signal that the blackbox node needs to be deepened —
its artifacts need a more accurate description of the interface.

Artifacts of blackbox nodes count towards the context budget of dependent nodes — they
are not free for consumers.

---

## Outputs are not just code

A mapping points to files. Those files can be anything: source code, configuration,
database migrations, documentation, API specifications. The graph does not distinguish
the nature of the output — it stores semantic memory regardless of whether materialization
produces a `.ts`, `.sql`, `.yaml`, or `.md` file.

The agent, having the context package, knows what the node is and how to produce an output
appropriate to its nature. A node with type `repository` mapped to a migration file
produces a migration. A node with type `service` mapped to a TypeScript file produces
a service implementation. Knowledge about the nature of the output is in the graph
(type, artifacts, context), not in the materialization system.

---

## Output quality is a function of graph quality

This is a central property of the system. There are no "good" and "bad" materializations —
there are complete and incomplete graphs.

When an output is bad, the only meaningful question is: **what was missing in the graph?**
Not "how do I fix this file?" — because a manually fixed file will be correct once, and
on the next materialization it will revert to a bad state because the graph did not change.

This is analogous to the relationship between a test and code: a test does not fix code,
a test reveals a problem. The graph does not generate code — the graph is the specification
from which the agent produces the output. Bad specification → bad output. Fixing the
specification fixes all future outputs.
