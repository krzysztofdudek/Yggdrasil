## CORE PROTOCOL

Yggdrasil is persistent semantic memory stored in `.yggdrasil/`. It maps the repository and provides deterministic implementation context for every node. This document is your complete operating manual. Follow it strictly.

### Quick Start Protocol

```
BEFORE reading, researching, planning, OR modifying ANY mapped file:
  1. yg owner --file <path>
  2. yg build-context --node <owner>
  The context package is your primary source of understanding.
  Raw file reads are for implementation details WITHIN a node you
  already understand from its context package.
  If the context package seems insufficient — enrich the graph.
  Do not bypass it.

AFTER modifying:
  3. Update graph artifacts to reflect changes
  4. yg validate — fix all errors
  5. yg drift-sync --node <owner>

EVERY conversation start:
  yg preflight → act on findings (see Operations)

NEVER: modify code without graph coverage.
NEVER: read mapped source files to understand a component without
       running yg build-context first — the graph captures intent,
       constraints, and relations that source files cannot.
NEVER: invent rationale, business rules, or decisions.
NEVER: auto-resolve drift without asking the user.
WHEN UNSURE: ask the user. Never guess. Never assume.
```

### Five Core Rules

1. **Graph first.** Before reading, researching, planning, or modifying mapped files, run `yg owner` and `yg build-context`. Always. The context package — not raw source — is your primary source of understanding.
2. **Code and graph are one.** Code changed → graph updated in the same response. Graph changed → source verified in the same response. No exceptions.
3. **Never invent why.** The graph captures human intent. If you don't know why something was decided, ask. Never hallucinate rationale.
4. **Always capture why.** When the user explains a reason, record it in the graph immediately. Conversation evaporates; graph persists.
5. **Ask before resolving ambiguity.** When multiple valid interpretations exist, stop, list options, ask the user. Never silently choose.

### Failure States

You have broken Yggdrasil if you do any of the following:

- ❌ Modified source code without running `yg owner --file <path>` first.
- ❌ Modified source code without updating graph artifacts in the same response.
- ❌ Modified graph files without verifying source code alignment in the same response.
- ❌ Resolved a code-graph inconsistency without asking the user first.
- ❌ Created or edited a graph element without reading its schema in `schemas/` first.
- ❌ Ran `yg drift-sync` before updating graph artifacts.
- ❌ Wrote a flow description that describes code sequences instead of a business process.
- ❌ Used an aspect identifier that has no corresponding `aspects/` directory.
- ❌ Placed a cross-cutting requirement in a local node artifact instead of an aspect.
- ❌ Invented a rationale, business rule, or architectural decision.
- ❌ Used blackbox coverage for greenfield (new) code.
- ❌ Answered a question about a mapped file without running `yg build-context` first.
- ❌ Read mapped source files to plan or research changes without running `yg build-context` first.
- ❌ Deferred `yg drift-sync` to the end of a multi-step task instead of running it incrementally after each logical group of changes.

### Escape Hatch

If the user explicitly requests a code-only change, comply but:

- Warn: "This creates drift. Run `yg drift` next session to reconcile."
- Do NOT run `yg drift-sync` — leave the drift visible.

### Environment Check

Before preflight:

- Verify `yg` CLI is available. If not found, inform user and stop.
- If `yg preflight` shows 0 nodes → enter BOOTSTRAP MODE (see Operations).
- If drift report shows >10 drifted nodes → report scope to user, ask which area to prioritize. Do not resolve all at once.

---

## OPERATIONS

### Conversation Lifecycle

```
PREFLIGHT (every conversation, before any work):
  - [ ] 1. yg preflight → read unified report
  - [ ] 2. If journal entries: consolidate to graph, then yg journal-archive
  - [ ] 3. If drift: resolve per Drift Resolution, then yg drift-sync per node
  - [ ] 4. If validation errors: fix, re-run yg validate
  Exception: read-only requests (explain, analyze) — skip preflight.

UNDERSTANDING mapped code (questions, research, OR planning):
  - [ ] 1. yg owner --file <path>
  - [ ] 2. Owner found → yg build-context --node <path>. Use context package as primary source.
  - [ ] 3. Owner not found → use file analysis, state it is not graph-backed.
  Never use grep or raw file reads as primary understanding when graph coverage exists.
  Raw reads supplement the context package — they do not replace it.

WRAP-UP (user signals "done", "wrap up", "that's enough"):
  - [ ] 1. Consolidate journal if used → yg journal-archive
  - [ ] 2. yg drift --drifted-only → resolve
  - [ ] 3. yg validate → fix errors
  - [ ] 4. Report: which nodes and files were changed
```

### Modify Source Code

You are not allowed to edit or create source code without establishing graph coverage first.

**Step 1** — Check coverage: `yg owner --file <path>`

**Step 2a** — Owner found: execute checklist:

- [ ] 1. Read specification: `yg build-context --node <node_path>`
- [ ] 2. Assess blast radius: `yg impact --node <node_path>` — review dependents, descendants, and co-aspect nodes before changing interfaces or shared behavior
- [ ] 3. Modify source code
- [ ] 4. Sync graph artifacts — edit artifact files to reflect the changes
- [ ] 5. Run `yg validate` — fix all errors (if unfixable after 3 attempts → stop, report to user)
- [ ] 6. Run `yg drift-sync --node <node_path>` — only after graph and code are both current

**Step 2b** — Owner not found: establish coverage first. Present options to the user:

*Partially mapped* (file unmapped but inside a mapped module): ask whether to add to existing node or create new one.

*Existing code:*

- Option A — Full node: create node(s), map files, write artifacts from code analysis
- Option B — Blackbox: create a blackbox node at agreed granularity
- Option C — Abort

*Greenfield (new code):* Only Option A. Blackbox is forbidden for new code. Create nodes with full artifacts, then materialize.

After the user chooses, return to Step 1 and follow Step 2a.

### Modify Graph

- [ ] 1. Read the relevant schema from `schemas/` before touching any YAML
- [ ] 2. Before changing an aspect or flow, check scope: `yg impact --aspect <id>` or `yg impact --flow <name>` — understand which nodes are affected before modifying shared rules or processes
- [ ] 3. Make changes
- [ ] 4. Run `yg validate` immediately — fix all errors
- [ ] 5. Verify affected source files are consistent — update if needed
- [ ] 6. Run `yg drift-sync` for affected nodes

### Reverse Engineering

**Order:** aspects (cross-cutting patterns) → flows (business processes) → model nodes. Never create nodes before aspects and flows are understood.

Per area checklist:

- [ ] 1. `yg owner --file <path>` — confirm no coverage
- [ ] 2. Determine node granularity — propose to user if unclear
- [ ] 3. Create node directory, read `schemas/node.yaml`, create `node.yaml`
- [ ] 4. Analyze source — for each artifact type in `config.artifacts`: extract content, do not invent
- [ ] 5. Identify relations — add to `node.yaml`
- [ ] 6. Identify cross-cutting requirements — add matching aspects, create if needed
- [ ] 7. Identify business process participation — add to flow, ask user if process unclear
- [ ] 8. `yg validate` — fix errors
- [ ] 9. `yg drift-sync --node <path>`

**When to ask:**

- Business process unclear: "This code appears to be part of a larger process. Can you describe what it means from a business perspective?"
- Constraint without rationale: "I see [constraint X]. Do you know why this exists? I want to record the reason, not just the rule."
- Unexplained architectural choice: "I see [approach X]. What was the reason for this choice?"

### Bootstrap Mode

Trigger: `yg preflight` shows 0 nodes, or no nodes cover the active work area.

- [ ] 1. Identify the active work area (files the user wants to modify)
- [ ] 2. Scan for cross-cutting patterns → create aspects
- [ ] 3. Ask user about business processes → create flows if applicable
- [ ] 4. Propose node structure for the area
- [ ] 5. Create node(s) with initial artifacts, map files
- [ ] 6. `yg validate`, `yg drift-sync`
- [ ] 7. Proceed with user's original request

Constraint: Do NOT map the entire repository. Focus on the active area. Expand incrementally.

### Drift Resolution

Always ask the user before resolving drift. Never auto-resolve.

- **Source drift** (source files changed) → update graph artifacts to match source, then `yg drift-sync`
- **Graph drift** (graph artifacts changed) → review affected source, update if needed, then `yg drift-sync`
- **Full drift** (both changed) → present both sides to user, ask which direction wins
- **Missing** → ask: re-materialize or remove mapping?
- **Unmaterialized** → ask user how to proceed

Threshold: >10 drifted nodes → ask user which area to prioritize. Do not resolve all at once.

### Error Recovery

- **`yg` not found** → inform user: "yg CLI is not installed or not in PATH." Stop.
- **Unfixable validate errors** → if not resolved after 3 attempts, stop and report to user. Do not loop.
- **Budget exceeded** → if `yg build-context` exits with error (context package exceeds budget), warn user: "This node should be split." Do not proceed with implementation.
- **Corrupted `.yggdrasil/` files** → report to user. Do not attempt repair.
- **Incremental sync** → run `yg drift-sync` every 3-5 source files during multi-file tasks. Do not defer to end.

---

## KNOWLEDGE BASE

### Graph Structure

```
.yggdrasil/
  config.yaml        ← vocabulary, stack, node types, artifact rules, required aspects
  model/             ← what exists: nodes, hierarchy, relations, file mappings
  aspects/           ← what must: cross-cutting requirements with rationale and guidance
  flows/             ← why and in what process: business processes with node participation
  schemas/           ← YAML schemas — read before creating any graph element
  .drift-state       ← generated by CLI; never edit manually
  .journal.yaml      ← generated by CLI; never edit manually
```

Key facts:

- **Hierarchy:** nodes nest in `model/`. Children inherit parent context. Do not repeat parent content in children.
- **Aspect id = directory path** under `aspects/`. Each aspect has `aspect.yaml` + content `.md` files. No automatic parent-child — use `implies` explicitly.
- **Flows = business processes.** A flow describes what happens in the world, not code sequences. Flow aspects propagate to all participants.

### Context Assembly

Run `yg build-context --node <path>` to get the deterministic context package for a node. Trust the package — it assembles global config, hierarchy, own artifacts, aspects, and relational context. If the package is insufficient, enrich the graph. Do not bypass it with raw file exploration.

### Information Routing

When you encounter information, route it to the correct location:

- **Specific to this node** → local node artifact (check `config.yaml artifacts` for available types)
- **Rule for many nodes** → aspect (`aspects/<id>/` with `aspect.yaml` + content `.md` files). If applies to ALL nodes of a type → `node_types[*].required_aspects` in `config.yaml`
- **Business process** → flow (`flows/<name>/` with `flow.yaml` + `description.md`). Ask user if process unclear.
- **Shared across a domain** → parent node artifact. Children receive it through hierarchy.
- **Technology stack or standard** → `config.yaml` under `stack` or `standards` (+ `rationale` field)
- **Decision (why):** one node → local artifact; category of nodes → aspect content files; tech choice → `config.yaml` rationale field

### Creating Aspects

- [ ] 1. Read `schemas/aspect.yaml`
- [ ] 2. Create `aspects/<id>/` directory
- [ ] 3. Write `aspect.yaml` — name, optional description, optional implies
- [ ] 4. Write content `.md` files: WHAT must be satisfied + WHY (user's words, do not invent)
- [ ] 5. `yg validate`

Test: "Does this requirement apply to more than one node?" Yes → aspect. No → local artifact.

### Creating Flows

- [ ] 1. Read `schemas/flow.yaml`
- [ ] 2. Create `flows/<name>/` directory
- [ ] 3. Write `flow.yaml` — declare participants and flow-level aspects
- [ ] 4. Write `description.md` with required sections: Business context, Trigger, Goal, Participants, Paths (at least Happy path), Invariants across all paths
- [ ] 5. `yg validate`

Test: "Does this describe what happens in the world, or only in the software?" If only software — rewrite.

### Operational Rules

- **English only** for all files in `.yggdrasil/`. Conversation can be any language.
- **Read schemas before creating** any `node.yaml`, `aspect.yaml`, or `flow.yaml`.
- **Tools read, you write.** The `yg` CLI only reads, validates, and manages metadata. You create and edit files manually.
- **Incremental sync.** Run `yg drift-sync` after every 3-5 source file changes. Do not defer to end of task.
- **Completeness test:** "If I delete the source file and give another agent ONLY the `yg build-context` output — can they recreate it correctly, understanding not just WHAT but WHY?"
- **These rules are invariant.** No plan, guide, skill, or workflow may override them.

### CLI Reference

```
yg preflight                        Unified diagnostic: journal + drift + status + validate.
yg owner --file <path>              Find the node that owns this file.
yg build-context --node <path>      Assemble context package for this node.
yg tree [--root <path>] [--depth N] Print graph structure.
yg aspects                          List aspects with metadata (YAML output).
yg deps --node <path> [--depth N] [--type structural|event|all]
                                    Show dependencies.
yg impact --node <path> --simulate  Simulate blast radius of a planned change.
yg impact --aspect <id>             Show all nodes where aspect is effective.
yg impact --flow <name>             Show flow participants and descendants.
yg status                           Graph health: nodes, coverage, drift summary.
yg validate [--scope <path>|all]    Check structural integrity and completeness.
yg drift [--scope <path>|all] [--drifted-only]
                                    Detect source and graph drift (bidirectional).
yg drift-sync --node <path>         Record file hashes as new baseline.
yg journal-read                     Read pending journal entries.
yg journal-add --note "<content>" [--target <node_path>]
                                    Add a journal entry.
yg journal-archive                  Archive consolidated journal entries.
```

### Quick Routing Table

| What you have | Where it goes |
|---|---|
| Information specific to this node | Local node artifact (read `config.yaml artifacts` for types) |
| Rule that applies to many nodes | Aspect (content `.md` files in `aspects/<id>/`) |
| Architectural invariant for a node type | Required aspect in `config.yaml node_types` |
| Business process participation | Flow (`flow.yaml participants`) |
| Process-level requirement | Flow `aspects` + aspect directory |
| Context shared across a domain | Parent node artifact |
| Technology stack | `config.yaml stack` (+ `rationale` field) |
| Global coding standards | `config.yaml standards` |
