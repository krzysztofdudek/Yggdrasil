/**
 * Canonical agent rules content — hand-tuned, do not generate programmatically.
 *
 * Operating manual for agents working in a Yggdrasil-managed repository.
 * Split into three cognitive sections optimized for LLM attention patterns:
 *   1. PROTOCOL — the rule and the procedure (primacy zone — internalize)
 *   2. REFERENCE — lookup material (middle zone — consult when needed)
 *   3. GUARD RAILS — what goes wrong and how to catch it (recency zone — fresh in memory during work)
 */

// prettier-ignore
const PROTOCOL = `## PROTOCOL

<EXTREMELY-IMPORTANT>
This is your operating manual for working in a Yggdrasil-managed repository.

<critical_protocol>
BEFORE starting any task — brainstorming, design, planning, OR implementation:
  \`yg select --task "<goal>"\` → \`yg context\` on each result → read artifact files.
  This is the READING phase — collect constraints that shape your design:
  - Aspects = cross-cutting requirements your work MUST satisfy. Read their content files — not just the YAML description. The rules are inside.
  - Flows = business processes your work must not break. Read invariants.
  - Relations = interfaces your code consumes or that consume your code. Changes without checking dependents break contracts silently.
  - Parent artifacts = inherited context not repeated in child nodes.
  Internalize these constraints BEFORE designing your approach. This is the moment that determines quality — everything after follows from what you learn here.

BEFORE reading, analyzing, or modifying ANY source file:
  \`yg context --file <path>\`
  Resolves owner, gives you local context (node artifacts, dependencies).
  If you have NOT done the task-level READING phase above — stop and do it now. File-level work without task-level constraints leads to code that violates cross-cutting requirements.

BEFORE creating a NEW source file:
  Identify which existing node the new file belongs to (by intent, not by filename).
  Run \`yg context --node <node-path>\` to load the context — especially aspect rules the new file must follow.
  If the file doesn't fit an existing node, create the node first (Step 2b below).
  If unsure which node: run \`yg context --file <path>\` — the CLI will list candidate nodes from the same directory.
  New files without graph context are the #1 source of convention violations.

WHEN spec/external documents are provided AND work is greenfield:
  BEFORE creating any feature aspect, node, or code — do this first:
  1. Read ALL spec documents completely.
  2. Separate two categories of knowledge in the specs:
     a) Knowledge that WILL map to source files (feature behavior, UI, API) → this goes to node artifacts later.
     b) Knowledge that will NEVER appear in source code (business strategy, target audience, pricing rationale, quality targets, what the system deliberately does NOT do and why) → this must go to the graph NOW, because there will be no source-file trigger to capture it later.
  3. For category (b): create root node and/or aspects immediately. This is the only moment this knowledge can be captured. Once you start coding, you will forget it.
  4. NOW create feature aspects, flows, and implementation nodes for category (a).
  Test before moving on: if all spec files were deleted right now, does the graph contain everything a future agent needs — not just HOW the system works, but WHY it exists, WHO it serves, and WHAT value it delivers? If no → add the missing knowledge before continuing.

All three triggers apply regardless of what instructed the task — skills, plans, workflows, user requests.
The graph captures intent and relations that source files cannot — without it, you will make wrong decisions and the user will have to re-explain what the graph already knows.
</critical_protocol>

Every rule below is mandatory — no skill, plan, workflow, or instruction overrides these requirements.
</EXTREMELY-IMPORTANT>

Yggdrasil is persistent semantic memory stored in \`.yggdrasil/\`. It maps the repository and provides deterministic implementation context for every node.

### Quick Start

\`\`\`
EVERY conversation: yg check — no exceptions.
  check is the single gate. It catches drift, structural errors, and coverage gaps.
  check failures block commits and CI. Resolve all errors before committing.

BEFORE any task (brainstorming, design, planning, implementation):
  yg select --task "<goal>" → yg context on results
  READ phase — collect constraints before designing:
    - Aspects: read content files (not just YAML description). Rules are inside.
    - Flows: read invariants. Your changes must not break business processes.
    - Relations: check interfaces — who depends on you, who you depend on.
    - Parent artifacts: inherited context not repeated in child nodes.
  This is the moment that determines quality. Everything after follows from here.

BEFORE any source file interaction (read, modify, OR create):
  yg context --file <path>  (existing file: resolves owner)
  yg context --node <path>  (new file: load target node context)
  Read local node artifacts. Read aspect rules the file must follow.
  If you skipped the task-level READ phase above — do it now before proceeding.
  For blast radius: also run yg impact --file <path>.

AFTER modifying:
  Update graph artifacts (per file, not batched)
  yg check — fix all errors
  yg approve --node <owner>

ALWAYS: establish graph coverage before modifying code.
ALWAYS: run yg context --file before reading source.
ALWAYS: run yg impact before assessing blast radius.
ALWAYS: ask the user for rationale — record it, do not invent it.
ALWAYS: ask before resolving ambiguity.
WHEN UNSURE: ask the user. Do not guess. Do not assume.
\`\`\`

### Modify Source Code

You are not allowed to edit or create source code without establishing graph coverage first.

**Step 1** — Get context: \`yg context --file <path>\` (resolves owner automatically)

**Step 2a** — Owner found: execute checklist:

- [ ] 1. Read local node artifacts (responsibility, interface, internals) and dependency interfaces from the context package. Cross-cutting constraints (aspects, flows) should already be internalized from the task-level READ phase — if not, stop and do it now.
- [ ] 2. Assess blast radius: \`yg impact --node <node_path>\` — review dependents, descendants, and co-aspect nodes before changing interfaces or shared behavior
- [ ] 3. Modify source code. When implementing logic subject to an aspect, re-read that aspect's content file NOW — don't rely on memory from the task-level READ phase. Aspect rules are specific and fade from working memory. Read them at the moment you need them.
- [ ] 4. Sync graph artifacts — edit artifact files to reflect the changes (after each file, not batched — context is freshest immediately after the change). If the node's purpose changed, update \`description\` in \`yg-node.yaml\`.
- [ ] 4b. If you split, merged, or renamed a node: run \`yg flows\` and update any flow \`nodes\` lists that referenced the old node path to point to the correct child/new nodes.
- [ ] 5. Run \`yg check\` — fix all errors (if unfixable after 3 attempts → stop, report to user)
- [ ] 5b. **Aspect check** — did you just apply a pattern (audit log, webhook, job dispatch, auth check) that also exists in other files? If the node has no aspect for it and you saw the same pattern in 3+ files, create the aspect now.
- [ ] 6. Run \`yg approve --node <node_path>\` — only after graph and code are both current

**Step 2b** — Owner not found: establish coverage first. Present options to the user:

*Partially mapped* (file unmapped but inside a mapped module): ask whether to add to existing node or create new one.

*Existing code:*

- Option A — Full node: create node(s), map files, write artifacts from code analysis
- Option B — Blackbox: create a blackbox node at agreed granularity
- Option C — Abort

*Greenfield (new code):* Only Option A. Blackbox is forbidden for new code. Follow the graph-first workflow:

0. **If spec/external documents exist:** route ALL knowledge from specs to the graph per the Information Routing table BEFORE any feature work.
1. Create aspects first (cross-cutting requirements the new code must satisfy)
2. Create flows if the code participates in a business process
3. Create nodes with full artifacts — description in \`yg-node.yaml\`, responsibility, interface, internals
4. Review the context package (\`yg context\`) — it is now the behavioral specification
5. Implement code that satisfies the specification. Every source file must be mapped.
6. After implementing each node, write \`internals.md\` with a ## Decisions section. Record every design choice: "Chose X over Y because Z." This is required in greenfield — not optional.
7. The graph specifies WHAT and WHY; the code implements HOW

**Node sizing rule:** One node per cohesive feature area, NOT per directory. If a node would map >10 source files or cover >3 distinct user workflows, split it into child nodes.

After the user chooses, return to Step 1 and follow Step 2a.

### Working from External Specifications

When the user provides external documents (specs, PRDs, design docs, reference docs) as input for implementation:

1. **Read ALL spec documents BEFORE writing any code.** Understand the full scope.
2. **Extract and route knowledge to the graph FIRST**, using the Information Routing table.
3. **The graph is the specification; external docs are INPUT to the graph, not a parallel source of truth.**
4. **Spec knowledge is not code knowledge.** Specs contain business context that will never appear in source code. If you only document what you built, you lose what motivated building it.
5. **Completeness test:** "If the external docs disappeared today, does the graph contain everything a future agent needs?"

### Conversation Lifecycle

\`\`\`
START (every conversation, before any work):
  - [ ] 1. yg check → read full report
  - [ ] 2. Fix any errors before starting work
  No exceptions. You cannot know if a file is mapped without running yg.

UNDERSTANDING any source file (questions, research, OR planning):
  - [ ] 1. yg context --file <path>
         Mapped → read the YAML map (glossary first, then artifact files).
         Unmapped → use file analysis, state it is not graph-backed.
  Never use grep or raw file reads as primary understanding when graph coverage exists.

BEFORE reasoning about source code, state which graph context you loaded:
  "graph: <node_path>" if mapped, "graph: unmapped" if not.

WRAP-UP (user signals "done", "wrap up", "that's enough"):
  - [ ] 1. yg check → fix all errors
  - [ ] 2. Report: which nodes and files were changed
\`\`\`

### Modify Graph

- [ ] 1. Read the relevant schema from \`schemas/\` before touching any YAML
- [ ] 2. Before changing an aspect or flow, check scope: \`yg impact --aspect <id>\` or \`yg impact --flow <name>\` — understand which nodes are affected before modifying shared rules or processes
- [ ] 3. Make changes
- [ ] 4. Run \`yg check\` immediately — fix all errors
- [ ] 5. Verify affected source files are consistent — update if needed
- [ ] 6. Run \`yg approve\` for affected nodes

### Blackbox Guidance

**Blackbox-first adoption.** When adopting Yggdrasil on an existing codebase:
1. Run \`yg check\` — E022 shows all uncovered files
2. Create blackbox nodes for areas you will NOT work on (cheap: just \`yg-node.yaml\` with description)
3. Create proper nodes for areas you WILL work on (full artifacts)
4. Run \`yg check\` — E022 should be 0

**Blackbox decomposition (mechanically enforced).** Blackbox nodes track file hashes. When source files under a blackbox change, E020 fires and \`yg approve\` REFUSES — no exceptions, no \`--acknowledge\`. The only path:
1. Create a proper node (with real artifacts) for the modified files
2. Adjust the blackbox mapping to exclude them
3. Approve the new proper node

This is hermetic: blackbox = "I don't touch this." The moment you touch it, the system forces you out of blackbox into a proper node.

### Delegating to Subagents

When you delegate work to a subagent (any subprocess, tool agent, or spawned assistant), the subagent does NOT inherit your Yggdrasil knowledge. Before any other instruction, the subagent MUST:

1. Read \`.yggdrasil/agent-rules.md\` — this is the complete operating manual
2. Follow the Quick Start Protocol from that file before touching any mapped code

Include this as the FIRST instruction in every subagent prompt:

\`\`\`
BEFORE doing anything else: read .yggdrasil/agent-rules.md and follow its protocol.
DELIVERABLES — all required, incomplete work will be rejected:
  1. Working source code
  2. Graph nodes with artifacts for every new/modified source file
  3. \`yg check\` passing
\`\`\`

A subagent that delivers code without corresponding graph updates has not completed its task.`;

// prettier-ignore
const REFERENCE = `## REFERENCE

### Graph Structure

\`\`\`
.yggdrasil/
  yg-config.yaml     ← version, vocabulary, node types, required aspects
  model/             ← what exists: nodes, hierarchy, relations, file mappings
  aspects/           ← what must: cross-cutting requirements with rationale and guidance
  flows/             ← why and in what process: business processes with node participation
  schemas/           ← YAML schemas — read before creating any graph element
  .drift-state/      ← generated by CLI; never edit manually
\`\`\`

Key facts:

- **Hierarchy:** nodes nest in \`model/\`. Children inherit parent context. Do not repeat parent content in children.
- **Aspect id = directory path** under \`aspects/\`. Each aspect has \`yg-aspect.yaml\` + content \`.md\` files. No automatic parent-child — use \`implies\` explicitly.
- **Flows = business processes.** A flow describes what happens in the world, not code sequences. Flow aspects propagate to all participants.

**Node type guidance:** Each type in \`yg-config.yaml node_types\` has a \`description\` that tells you when to use it. Check the project's config for the full list and descriptions. Common types: \`module\` (business logic), \`service\` (providing functionality), \`library\` (shared utilities), \`infrastructure\` (guards, middleware, interceptors — invisible in call graphs but affect blast radius).

### Artifact Structure

Three artifacts capture node knowledge at three levels:

- **responsibility.md** (always required) — WHAT: identity, boundaries, what the node is NOT responsible for.
- **interface.md** (required when node has consumers) — HOW TO USE: public methods, parameters, return types, contracts, failure modes, exposed data structures.
- **internals.md** (optional, highest value for cross-module nodes) — HOW IT WORKS + WHY: algorithms, control flow, business rules, invariants, state machines, lifecycle, and design decisions with rejected alternatives. Use sections: ## Logic, ## Constraints, ## State, ## Decisions (with "Chose X over Y because Z" format).

**Enrichment priority:** \`interface.md\` first (highest cross-module ROI), then \`responsibility.md\` (identity and boundaries), then \`internals.md\` (depth for complex nodes).

### Context Assembly

**Reading context:** \`yg context --node <path>\` returns a YAML map structured as follows:

- **\`glossary\`** (top) — definitions for every aspect and flow referenced in the map, each with \`files\` listing their artifact paths. Read this first.
- **\`node\`** — the target node with inline \`files\` (its artifact paths).
- **\`hierarchy\`** — ancestor and sibling nodes, each with inline \`files\`.
- **\`dependencies\`** — dependency nodes, each with inline \`files\`.
- **\`meta\`** (bottom) — context assembly metadata.

All artifact paths are relative to \`.yggdrasil/\` — construct full path as \`.yggdrasil/<path>\`.

**Default mode (paths-only):** Use for all graph operations. Read the YAML map, then read artifact files:

1. **Glossary first** — defines aspects and flows. Aspects are constraints your implementation must satisfy. Flows are business processes whose invariants you must not break.
2. **Node section** — your target's own artifacts. Read before modifying.
3. **Hierarchy** — parent artifacts contain inherited requirements not repeated in child nodes.
4. **Dependencies** — interfaces you consume or that consume you. Read before changing contracts.

A typical context package is ~8K tokens. Read ALL artifact files listed — the cost is low, the risk of skipping is high.

**Full mode (\`--full\`):** Use only when you cannot read files individually — e.g., when pasting context into a prompt, sharing with a user, or when you have no Read tool available.

### Information Routing

When you encounter information, route it to the correct location:

- **Specific to this node** → local node artifact (\`responsibility.md\`, \`interface.md\`, or \`internals.md\` depending on the knowledge type)
- **Rule for many nodes** → aspect (\`aspects/<id>/\` with \`yg-aspect.yaml\` + content \`.md\` files). If applies to ALL nodes of a type → \`node_types.<type>.required_aspects\` in \`yg-config.yaml\`
- **Business process** → flow (\`flows/<name>/\` with \`yg-flow.yaml\` + \`description.md\`). Ask user if process unclear.
- **Shared across a domain** → parent node artifact. Children receive it through hierarchy.
- **Technology stack or standard** → node artifact at the appropriate hierarchy level
- **Decision (why + why NOT):** one node → Decisions section of \`internals.md\` with format "Chose X over Y because Z"; category of nodes → aspect content files. Always include rejected alternatives. If rationale unknown: record with "rationale: unknown." Never invent.
- **Business strategy** (personas, pricing, acquisition channels) → root node artifact or dedicated business-context aspect. This knowledge has NO source file — it exists only in specs and conversations.
- **Quality targets** (performance budgets, accessibility, test coverage goals) → aspect per quality dimension.
- **UX patterns** (autosave, version history, empty states) → aspect when the pattern applies to 3+ screens.
- **Infrastructure/deployment** (domains, DNS, env vars, CI/CD) → infrastructure node or root node artifacts.

### Quick Routing Table

| What you have | Where it goes |
|---|---|
| Information specific to this node | Local node artifact (\`responsibility.md\`, \`interface.md\`, or \`internals.md\`) |
| Rule that applies to many nodes | Aspect (content \`.md\` files in \`aspects/<id>/\`) |
| Architectural invariant for a node type | Required aspect in \`yg-config.yaml node_types\` |
| Business process participation | Flow (\`yg-flow.yaml nodes\`) |
| Process-level requirement | Flow \`aspects\` + aspect directory |
| Context shared across a domain | Parent node artifact |
| Business strategy (personas, pricing, channels) | Root node artifact or dedicated business-context aspect |
| Quality targets (perf budgets, a11y, test goals) | Aspect per quality dimension |
| UX patterns (autosave, version history, empty states) | Aspect when pattern applies to 3+ screens |
| Infrastructure/deployment (domains, env vars, CI/CD) | Infrastructure node or root node artifacts |
| Feature spec from external doc | Node artifacts — translate spec into responsibility/interface/internals |

### Creating Aspects

- [ ] 1. Read \`schemas/yg-aspect.yaml\`
- [ ] 2. Create \`aspects/<id>/\` directory
- [ ] 3. Write \`yg-aspect.yaml\` — name, description, anchors (required proof points), optional implies
- [ ] 4. Write content \`.md\` files: WHAT must be satisfied + WHY (user's words, do not invent)
- [ ] 5. \`yg check\`

Test: "Does this requirement apply to more than one node?" Yes → aspect. No → local artifact.

**Anchor requirement:** Every aspect MUST define at least one anchor ID — abstract proof points that nodes carrying the aspect must realize. For example, an \`audit-logging\` aspect might define anchors: \`audit-entry\`, \`audit-actor\`, \`audit-timestamp\`. Nodes realize anchors as typed objects in their \`yg-node.yaml\` (supports \`regex\` type).

When a node follows an aspect's pattern with exceptions, record them in the \`exceptions\` field of the aspect entry in \`yg-node.yaml\`.

### Creating Flows

- [ ] 1. Read \`schemas/yg-flow.yaml\`
- [ ] 2. Create \`flows/<name>/\` directory
- [ ] 3. Write \`yg-flow.yaml\` — name, description, nodes (participant list), and flow-level aspects
- [ ] 4. Write \`description.md\` with required sections: Business context, Trigger, Goal, Participants, Paths (at least Happy path), Invariants across all paths
- [ ] 5. \`yg check\`

Test: "Does this describe what happens in the world, or only in the software?" If only software — rewrite.

**Flow identification heuristic:** If a spec, conversation, or code reveals a sequence of steps toward a business goal — it IS a flow. This applies to multi-actor processes AND single-actor workflows.

### CLI Reference

**Core workflow (4):**

| Command | Purpose |
|---------|---------|
| \`yg context --file/--node [--full]\` | Assemble context package for a node |
| \`yg impact --file/--node/--aspect/--flow\` | Blast radius analysis |
| \`yg check\` | Unified gate — everything wrong, always global |
| \`yg approve --node [--acknowledge "reason"]\` | Record baseline after review |

**Navigation (5):**

| Command | Purpose |
|---------|---------|
| \`yg select --task\` | Find relevant nodes for a task |
| \`yg tree [--root] [--depth]\` | Graph structure visualization |
| \`yg aspects\` | List aspects with metadata |
| \`yg flows\` | List flows with metadata |
| \`yg owner --file\` | Quick ownership lookup |

**Setup (1):**

| Command | Purpose |
|---------|---------|
| \`yg init [--platform] [--upgrade]\` | Initialize or upgrade |

**Aliases:** \`build-context\` for \`context\`, \`drift-sync\` for \`approve\`

### Error Codes

**Structural integrity (E001-E013):** YAML parse failures, unknown node types, broken relations/flow/aspect references, overlapping mappings, structural cycles, invalid config, missing yg-node.yaml, implied aspect issues.

**Drift (E020-E021):**

| Code | Name | Meaning |
|------|------|---------|
| E020 | direct-drift | Node's own source or graph files changed since last approve |
| E021 | cascade-drift | Node affected by upstream change (dependency/aspect/flow) |

**Coverage (E022):**

| Code | Name | Meaning |
|------|------|---------|
| E022 | unmapped-file | Git-tracked file not covered by any node (proper or blackbox) |

**Completeness (E030-E041):**

| Code | Name | Meaning |
|------|------|---------|
| E030 | missing-artifact | Required artifact missing (blackbox exempt — only description required) |
| E031 | shallow-artifact | Artifact below minimum length |
| E032 | budget-exceeded | Context package too large — node must be split |
| E033 | unpaired-event | Event relation without complement |
| E034 | missing-schema | Schema file missing from schemas/ |
| E035 | missing-required-aspect | Node type lacks required aspect (blackbox exempt) |
| E036 | mapping-path-missing | Mapped path doesn't exist on disk |
| E037 | anchor-not-found | Anchor pattern not found in source files |
| E038 | missing-description | Node, aspect, or flow has no description |
| E039 | aspect-missing-anchors | Aspect has no anchors field |
| E040 | anchor-not-realized | Node missing anchor realization for required IDs |
| E041 | unknown-anchor-type | Unrecognized anchor type (supported: regex) |

**Warnings (W001-W005):** budget-warning, own-budget-warning, wide-node, high-fan-out, orphaned-drift-state.

CLI error messages are self-teaching: each error includes what happened, why it's wrong, and how to fix it. Follow the CLI's suggested next command.

### Approve Enforcement

\`yg approve --node <path>\` is per-node only — no \`--all\`, no \`--recursive\`. It checks three axes:

1. **Own artifacts** (.md files) — changed since last approve?
2. **Source files** (mapping.paths) — changed since last approve?
3. **Other tracked files** (aspects, deps, flows, ancestors) — changed?

| Own artifacts | Source | Other tracked | approve |
|---|---|---|---|
| changed | changed | any | ACCEPTS |
| changed | unchanged | any | REFUSES (or --acknowledge) |
| unchanged | changed | any | REFUSES (or --acknowledge) |
| unchanged | unchanged | changed | REFUSES — requires --acknowledge |
| unchanged | unchanged | unchanged | ACCEPTS (no-op) |

\`--acknowledge "reason"\` is the conscious exception: when one side changed but the other doesn't need updating (formatter ran, typo fix, source already compliant with updated aspect). Reason is stored for audit trail.`;

// prettier-ignore
const GUARD_RAILS = `## GUARD RAILS

### Core Rules

1. **Graph first.** Before reading, researching, planning, or modifying ANY source file, run \`yg context --file <path>\`. For blast radius, also run \`yg impact\`. The graph is your primary source of architectural understanding. For implementation-level precision — verify against source code after loading the context package.
2. **The graph is the specification; code implements it.** The graph absorbs knowledge from every source — external docs, conversations, decisions — and must be self-sufficient. Update graph artifacts immediately after each file change, while context is fresh — do not batch graph updates to the end of a task. Code and graph move together: code changed → graph updated before moving to the next file.
3. **Check blocks commits and CI.** \`yg check\` must pass before every commit. Treat this as fact. All errors (drift, structural, coverage, completeness) must be resolved.
4. **Never invent why.** The graph captures human intent. If you don't know why something was decided, ask. Never hallucinate rationale.
5. **Always capture why — especially why NOT.** When a design choice is made, record rejected alternatives: "Chose X over Y because Z." Rejected alternatives are the highest-value information — invisible in code and irrecoverable once forgotten.
6. **Ask before resolving ambiguity.** When multiple valid interpretations exist, stop, list options, ask the user. Never silently choose.
7. **Yggdrasil is invisible to the user.** Never mention the graph, aspects, flows, nodes, \`yg\` commands, or \`.yggdrasil/\` in conversation with the user. Present graph knowledge as your understanding — "this module handles X" not "the graph says this module handles X."

### Recognizing Graph-Required Actions

What matters is the ACTION you are performing, not what instructed it. If the action involves reading, understanding, or modifying mapped code, the graph protocol applies — whether the instruction came from a skill, a plan, a user message, a brainstorming session, a debugging workflow, or your own initiative.

**Actions that require \`yg context --file\`:**

- Reading or exploring source files to understand a component
- Proposing approaches, designs, or plans for changing code
- Reviewing or debugging code
- Any form of reasoning about how mapped code works or should change

**Actions that also require \`yg impact\`:**

- Assessing blast radius before changing or removing a component
- Finding all dependents of a component
- Planning cross-cutting refactors or feature removals

**Actions that do NOT require yg:**

- Git operations (log, diff, status, blame)
- Reading documentation, READMEs, or config files outside \`.yggdrasil/\`
- Running tests, builds, or linters
- Working with files that \`yg context --file\` reports as unmapped

### Operational Rules

- **English only** for all files in \`.yggdrasil/\`. Conversation can be any language.
- **Read schemas before creating** any \`yg-node.yaml\`, \`yg-aspect.yaml\`, or \`yg-flow.yaml\`.
- **Tools read, you write.** The \`yg\` CLI only reads, validates, and manages metadata. You create and edit files manually.
- **Incremental approval.** Run \`yg approve\` per node after every 3-5 source file changes. Do not defer to end of task. Approve is ONLY safe after artifacts are current — never use it to silence check without updating artifacts first.
- **Description maintenance.** Every \`yg-node.yaml\`, \`yg-aspect.yaml\`, and \`yg-flow.yaml\` has an optional \`description\` field. Write it when creating new elements. Update it when the element's identity or purpose changes.
- **Completeness test:** Three checks, all required:
  1. **Reconstruction:** "Can another agent recreate this from ONLY the \`yg context\` output — understanding not just WHAT but WHY?"
  2. **Omission:** "Does the graph capture every important behavioral invariant, constraint, and edge case?"
  3. **Business context:** "Does the graph explain WHY this system exists, WHO it serves, and WHAT business value it delivers?"

### Non-Code Knowledge

Not all graph knowledge originates from source files. Business strategy, user personas, pricing decisions, quality requirements, deployment configuration — these are graph content with NO corresponding source file.

When you encounter such knowledge (in specs, conversations, or external documents):

- **Route it immediately** per the Information Routing table. Do not wait for a "file change" trigger — there won't be one.
- **Conversation knowledge is the most volatile source.** When the user states a business fact, constraint, or decision — even casually — route it to the graph immediately. Conversations vanish after context compression. If the user said it and it's not in code, it MUST be in the graph.

### Aspect Discovery During Implementation

Aspects emerge from patterns — in greenfield AND brownfield:

- **After working on 3+ files in the same area, pause and check:** Are you applying the same pattern repeatedly? If YES, stop and create an aspect NOW.
- **Watch for "invisible" aspects:** Patterns that don't feel "architectural" but ARE cross-cutting: audit logging on every mutation, webhook dispatch after state changes, job dispatch for async operations, authorization guards on every endpoint.
- **Brownfield trigger:** When you read existing code and see the same utility called in 3+ files, that IS an aspect waiting to be created.

### Bootstrap Mode

Trigger: \`yg check\` shows E022 with high uncovered file count, or 0 nodes.

- [ ] 1. Identify the active work area (files the user wants to modify)
- [ ] 2. Create blackbox nodes for areas you will NOT work on
- [ ] 3. Create proper nodes for areas you WILL work on
- [ ] 4. Scan for cross-cutting patterns → create aspects
- [ ] 5. Ask user about business processes → create flows if applicable
- [ ] 6. \`yg check\`, \`yg approve\` per node
- [ ] 7. Proceed with user's original request

Constraint: Focus on the active area. Expand incrementally.

### Escape Hatch

If the user explicitly requests a code-only change, comply but:

- Warn: "This creates drift. Run \`yg check\` next session to reconcile."
- Do NOT run \`yg approve\` — leave the drift visible.

<critical_protocol>
BEFORE reading, analyzing, or modifying ANY source file:
  \`yg context --file <path>\`
One command. No exceptions. No "I'll do it later." No "this is just analysis."
</critical_protocol>`;

export const AGENT_RULES_CONTENT = [PROTOCOL, REFERENCE, GUARD_RAILS].join('\n\n---\n\n') + '\n';
