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
BEFORE reading, analyzing, or modifying ANY source file:
  \`yg context --file <path>\`
  Resolves owner, gives you the aspects this file must satisfy.
  Read the aspect content \`.md\` files — those are the rules the reviewer enforces.

BEFORE creating a NEW source file:
  Identify which existing node the new file belongs to (by intent, not by filename).
  Run \`yg context --node <node-path>\` to load the context — especially aspect rules the new file must follow.
  If the file doesn't fit an existing node, create the node first (Step 2b below).
  If unsure which node: run \`yg context --file <path>\` — the CLI will list candidate nodes from the same directory.
  New files without graph context are the #1 source of convention violations.

All triggers apply regardless of what instructed the task — skills, plans, workflows, user requests.
The graph captures architectural constraints that source files cannot — without it, you will write code that violates cross-cutting requirements.
</critical_protocol>

Every rule below is mandatory — no skill, plan, workflow, or instruction overrides these requirements.
</EXTREMELY-IMPORTANT>

Yggdrasil is continuous architecture enforcement stored in \`.yggdrasil/\`. It maps the repository and verifies source code against architectural rules (aspects) at approve time.

### Quick Start

\`\`\`
EVERY conversation: yg check — read the full report, follow CLI guidance.
  CLI tells you what broke, why, and the next command to run.
  check failures block commits and CI. Resolve all errors before committing.

BEFORE any source file interaction (read, modify, OR create):
  yg context --file <path>  (existing file: resolves owner)
  yg context --node <path>  (new file: load target node context)
  Read aspect content.md files — those are the rules the reviewer enforces.
  For blast radius: also run yg impact --file <path>.

AFTER modifying:
  yg check — fix all errors
  yg approve --node <owner> — reviewer verifies aspects vs source code

ALWAYS: establish graph coverage before modifying code.
ALWAYS: run yg context --file before reading source.
ALWAYS: run yg impact before assessing blast radius.
ALWAYS: ask before resolving ambiguity.
WHEN UNSURE: ask the user. Do not guess. Do not assume.

How CLI guides you:
  Every error message follows: WHAT happened → WHY it's a problem → NEXT command.
  suggestedNext at the end of check gives one concrete step + remaining scale.
  Follow it. Re-run check after each fix.
\`\`\`

### Modify Source Code

You are not allowed to edit or create source code without establishing graph coverage first.

**Step 1** — Get context: \`yg context --file <path>\` (resolves owner automatically)

**Step 2a** — Owner found: execute checklist:

- [ ] 1. \`yg context --file <path>\` — note all aspects in "Must satisfy"
- [ ] 2. **Read aspect content files.** For every aspect in "Must satisfy": open and read its content \`.md\` files. The aspect description is not sufficient — the content files contain the actual enforcement rules. \`yg approve\` (step 6) delegates to a reviewer that checks source code against these rules and rejects non-compliant code.
- [ ] 3. Assess blast radius: \`yg impact --node <node_path>\`
- [ ] 4. Modify source code — satisfy the aspect rules
- [ ] 5. Run \`yg check\` — follow CLI's suggested next command (if unfixable after 3 attempts → stop, report to user)
- [ ] 5b. If you split, merged, or renamed a node: run \`yg flows\` and update any flow \`nodes\` lists that referenced the old node path.
- [ ] 5c. **Aspect check** — did you just apply a pattern that also exists in other files? If the node has no aspect for it and you saw the same pattern in 3+ files, create the aspect now.
- [ ] 6. Run \`yg approve --node <node_path>\` — reviewer verifies aspects vs source code

**Step 2b** — Owner not found: establish coverage first. Present options to the user:

*Partially mapped* (file unmapped but inside a mapped module): ask whether to add to existing node or create new one.

*Existing code:*

- Option A — Proper node: create node(s), map files, write description in \`yg-node.yaml\`
- Option B — Abort

*Greenfield (new code):* Only Option A. Follow the graph-first workflow:

1. Create aspects first (cross-cutting requirements the new code must satisfy)
2. Create flows if the code participates in a business process (with flow-level aspects)
3. Create nodes: \`yg-node.yaml\` with description, mapping, relations, aspects
4. Review the context package (\`yg context\`) — aspects are the specification
5. Implement code that satisfies aspect rules. Every source file must be mapped.
6. \`yg check\`, \`yg approve\`

**Node sizing rule:** One node per cohesive feature area, NOT per directory. If a node would map >10 source files or cover >3 distinct user workflows, split it into child nodes.

**Why sizing matters for enforcement:** The reviewer verifies aspects against ALL source files in a node. A node with too many files forces the reviewer to evaluate aspects across too much code — it may reject compliant code because it lacks focused context. Smaller nodes (2-5 source files) give the reviewer enough context to verify accurately. Design nodes so that every mapped file is relevant to every aspect on that node.

**\`wide-node\` warning:** \`yg check\` emits a \`wide-node\` warning when a node with aspects maps more source files than \`quality.max_mapping_source_files\` (default: 10). This warning means: the reviewer WILL struggle with this node. Split it before running \`yg approve\` — otherwise expect false rejections.

After the user chooses, return to Step 1 and follow Step 2a.

### Working from External Specifications

When the user provides external documents (specs, PRDs, design docs, reference docs) as input for implementation:

1. **Read ALL spec documents BEFORE writing any code.** Understand the full scope.
2. **Extract enforceable requirements as aspects FIRST** — these are the rules the reviewer will check.
3. **The graph enforces architecture; external docs are INPUT to the graph, not a parallel source of truth.**
4. **Non-enforceable knowledge** (business strategy, personas, pricing) is not captured in the graph. Enforceable rules go to aspects.

### Conversation Lifecycle

\`\`\`
START (every conversation, before any work):
  - [ ] 1. yg check → read full report
  - [ ] 2. Fix any errors before starting work
  No exceptions. You cannot know if a file is mapped without running yg.

UNDERSTANDING any source file (questions, research, OR planning):
  - [ ] 1. yg context --file <path>
         Mapped → read structured text output. Aspect content files are listed with "read:" prefix — read them.
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
- [ ] 2. Before changing an aspect or flow, check blast radius: \`yg impact --aspect <id>\` or \`yg impact --flow <name>\` — understand which nodes are affected before modifying shared rules or processes
- [ ] 3. Make changes
- [ ] 4. Run \`yg check\` immediately — fix all errors
- [ ] 5. Verify affected source files are consistent — update if needed
- [ ] 6. Run \`yg approve\` for affected nodes

### Architecture Ownership

\`yg-architecture.yaml\` defines which node types exist, what each type means, and which relations are allowed between types. **Every change to this file requires user confirmation** — it defines the vocabulary and constraints for the entire graph.

**On a new or empty repo:** Do NOT accept the defaults silently. Read \`yg-architecture.yaml\`, present the current types and relation rules to the user, and ask: "Does this type system fit your project, or should we adjust it?" The default types are starting points, not answers.

**Before creating nodes with relations:** Read \`yg-architecture.yaml\` to check which relation types are allowed between the source and target node types. Do not guess — if the architecture does not allow \`service\` to call \`data\`, you cannot create that relation. The options are:
1. Use an allowed relation type
2. Ask the user whether to update the architecture (explain the constraint)
3. Change the node type to one that allows the needed relation

**Never silently modify \`yg-architecture.yaml\`.** If a relation is forbidden, do NOT add the target type to the allowed list without asking the user first. Present the constraint, explain the options, let the user decide.

### Delegating to Subagents

When you delegate work to a subagent (any subprocess, tool agent, or spawned assistant), the subagent does NOT inherit your Yggdrasil knowledge. Before any other instruction, the subagent MUST:

1. Read \`.yggdrasil/agent-rules.md\` — this is the complete operating manual
2. Follow the Quick Start Protocol from that file before touching any mapped code

Include this as the FIRST instruction in every subagent prompt:

\`\`\`
BEFORE doing anything else: read .yggdrasil/agent-rules.md and follow its protocol.
DELIVERABLES — all required, incomplete work will be rejected:
  1. Working source code
  2. Graph nodes for every new/modified source file
  3. \`yg check\` passing
\`\`\`

A subagent that delivers code without corresponding graph updates has not completed its task.`;

// prettier-ignore
const REFERENCE = `## REFERENCE

### Graph Structure

\`\`\`
.yggdrasil/
  yg-config.yaml     ← project config: reviewer, quality thresholds, parallel
  yg-architecture.yaml ← node type definitions, default aspects per type
  model/             ← what exists: nodes, hierarchy, relations, file mappings
  aspects/           ← what must: cross-cutting requirements — the ONLY enforcement rules
  flows/             ← why and in what process: business processes with node participation
  schemas/           ← YAML schemas — read before creating any graph element
  .drift-state/      ← generated by CLI; never edit manually
\`\`\`

Key facts:

- **Hierarchy:** nodes nest in \`model/\`. Children inherit parent aspects. Parent aspects flow to children automatically. **Consequence:** before nesting nodes under a parent, check which aspects the parent has — every child must satisfy ALL of them. If an aspect applies to the parent but not to a specific child, either move the aspect to the children that need it, or make the child a top-level node instead.
- **Aspect id = directory path** under \`aspects/\`. Each aspect has \`yg-aspect.yaml\` + content \`.md\` files. Content files contain enforcement rules checked by the reviewer. No automatic parent-child — use \`implies\` explicitly.
- **Flows = business processes.** A flow describes what happens in the world, not code sequences. Flow aspects propagate to all participants.
- **Nodes = \`yg-node.yaml\` only.** Name, type, description, mapping, relations, aspects, ports. No \`.md\` files in nodes.

**Node type guidance:** Each type in \`yg-architecture.yaml node_types\` has a \`description\` that tells you when to use it. Check the project's architecture file for the full list and descriptions. Common types: \`module\` (business logic), \`service\` (providing functionality), \`library\` (shared utilities), \`infrastructure\` (guards, middleware, interceptors — invisible in call graphs but affect blast radius).

### Aspect Distribution Channels

Every graph dimension is a distribution channel for aspects to nodes:

| Channel | How aspects reach nodes |
|---|---|
| Direct | \`node.aspects\` in yg-node.yaml |
| Type | Architecture defines default aspects per node type |
| Hierarchy | Parent aspects inherited by children |
| Port | Consumer must satisfy port-required aspects |
| Flow | Participants inherit flow-level aspects |

### Context Assembly

Two context commands serve different purposes:

- **\`yg context --node <path>\`** — node overview: aspects, flows, dependents
- **\`yg context --file <path>\`** — per-file: aspects to satisfy, consumed dependencies

**Reading context:** Both commands output structured text. Aspect content file paths appear with a \`read:\` prefix — read each one to get the enforcement rules.

\`yg context --node <path>\` outputs:
- **Header** — node path, description, type
- **Source files** — files owned by this node
- **Must satisfy** — aspects with paths to content.md files
- **Participates in** — flows
- **Dependencies** — nodes this node depends on
- **Dependents** — count of nodes that depend on this one (consequence framing for blast radius)
- **Parent** — parent node

\`yg context --file <path>\` outputs:
- **Owner** — node path and type (or "unmapped" with candidate nodes)
- **Must satisfy** — aspects with paths to content.md files
- **Dependencies consumed** — what this file uses from each dependency
- **Node context** — back-pointer: run \`yg context --node\` for full node overview

Read ALL aspect content files listed — the cost is low, the risk of skipping is high.

### Information Routing

When you encounter information, route it to the correct location:

- **Enforceable cross-cutting rule** → aspect (\`aspects/<id>/\` with \`yg-aspect.yaml\` + content \`.md\` files). If applies to ALL nodes of a type → architecture default aspects.
- **Business process with participants** → flow (\`flows/<name>/\` with \`yg-flow.yaml\`). Process-level requirements → flow aspects.
- **Node identity** → \`description\` field in \`yg-node.yaml\` (1-2 sentences).
- **Already visible in source code** → not captured in the graph.
- **Non-enforceable knowledge** (business strategy, personas, design decisions) → not captured in the graph. If it can be made enforceable, write it as an aspect.

### Quick Routing Table

| What you have | Where it goes |
|---|---|
| Cross-cutting rule (3+ nodes) | Aspect content.md |
| Architectural invariant for a node type | Architecture default aspect |
| Business process participation | Flow (\`yg-flow.yaml nodes\`) |
| Process-level requirement | Flow \`aspects\` + aspect directory |
| Node identity (brief) | \`description\` in yg-node.yaml |
| Already visible in source code or config files | Not captured |
| Non-enforceable knowledge | Not captured |

### Creating Aspects

- [ ] 1. Read \`schemas/yg-aspect.yaml\`
- [ ] 2. Create \`aspects/<id>/\` directory
- [ ] 3. Write \`yg-aspect.yaml\` — name, description, optional implies
- [ ] 4. Write content \`.md\` files: WHAT must be satisfied + WHY (user's words, do not invent)
- [ ] 5. \`yg check\`

Test: "Does this requirement apply to more than one node?" Yes → aspect. "Can the reviewer check it against source code?" Yes → aspect. Both must be true.

### Creating Flows

- [ ] 1. Read \`schemas/yg-flow.yaml\`
- [ ] 2. Create \`flows/<name>/\` directory
- [ ] 3. Write \`yg-flow.yaml\` — name, description, nodes (participant list), and flow-level aspects
- [ ] 4. \`yg check\`

Test: "Does this describe what happens in the world, or only in the software?" If only software — rewrite.

**Flow identification heuristic:** If a spec, conversation, or code reveals a sequence of steps toward a business goal — it IS a flow. This applies to multi-actor processes AND single-actor workflows.

### Ports

Nodes can declare typed ports — named entry points with required aspects:

\`\`\`yaml
ports:
  charge:
    description: "Charge payment"
    aspects: [correlation-tracking]
\`\`\`

Consumers reference ports via consumes on relations:

\`\`\`yaml
relations:
  - target: payments/service
    type: calls
    consumes: [charge]
\`\`\`

At check time: \`port-missing-consumes\` fires if target has ports but consumer has no consumes. \`port-undefined\` fires if consumes references undefined port. \`consumes-without-ports\` fires if consumes is declared but target has no ports.
At approve time: Reviewer verifies consumer satisfies port-required aspects.

### CLI Commands

Core: \`yg check\`, \`yg context --node/--file\`, \`yg impact --node/--file/--aspect/--flow\`, \`yg approve --node/--aspect/--flow\`
Navigation: \`yg tree [--root <path>] [--depth <n>]\`, \`yg aspects\`, \`yg flows\`, \`yg owner --file\`
Setup: \`yg init\`
Debug: \`yg approve --dry-run --node <path>\` — preview reviewer prompt without LLM call

### Error Categories

CLI groups errors into categories. Each message tells you what happened, why,
and what command to run next.

- **Drift (\`source-drift\`, \`upstream-drift\`):** source files or upstream context changed since last approve. Run approve workflow.
- **Structural (\`yaml-invalid\`, \`config-invalid\`, \`relation-broken\`, etc.):** YAML broken or graph inconsistent. Fix the YAML.
- **Coverage (\`unmapped-files\`, \`mapping-path-missing\`):** source files not mapped. Bootstrap workflow.
- **Completeness (\`description-missing\`):** required fields missing. Add them.
- **Architecture (\`aspect-undefined\`, \`relation-target-forbidden\`, \`port-*\`, etc.):** references broken or contracts violated. Fix references.
- **Semantic (\`aspect-violation\`, approve only):** Reviewer found aspects not satisfied in source code.

Follow the CLI's suggested next command.

### Approve Enforcement

Approve is the architecture enforcement gate. Binary — no flags, no negotiation.

**How it works:**
1. Source or upstream context changed → run reviewer → reviewer checks each aspect's content.md against source code
2. Reviewer satisfied → \`approved\`, new baseline recorded
3. Reviewer not satisfied → \`refused\` with \`aspect-violation\` — fix source code and re-run

**Three modes:**

- \`yg approve --node <path> [<path2> ...]\` — one or more node paths. Multiple paths run as a batch.
- \`yg approve --aspect <id>\` — batch approve all cascade nodes caused by this aspect change.
- \`yg approve --flow <name>\` — batch approve all cascade nodes caused by this flow change.

Batch mode runs approvals in parallel (up to \`parallel\` config limit). Use batch when \`yg check\` suggests it in \`suggestedNext\`.

**Do NOT interrupt \`yg approve\`.** When reviewer is configured, approve calls the reviewer for every aspect across every source file — this takes time and is intentional. Interrupting it leaves drift state unrecorded and forces a re-run.

**Always read the FULL raw output of \`yg approve\`.** Every aspect result, every error message — read it all. The reviewer already ran and the cost is paid; the output is the return on that investment.

Always run the command without \`| grep\`, \`| head\`, \`| tail\`, or any filter that discards lines. Saving to a file and reading it (\`tee\`) is fine — that preserves all data. The rule is: all reviewer output must reach you unmodified.

Always batch at most 3-5 nodes per approve invocation. This is a maximum, not a suggestion.

**When reviewer rejects — decision tree:**

1. **Code violates aspect** → fix the code. This is the common case.
2. **Code is compliant but aspect wording is ambiguous** → fix the aspect content.md to be clearer. The escape hatch is improving the rule, not bypassing enforcement.
3. **Reviewer cannot verify because node has too many files** → the reviewer sees all source files in the node. If the node is too large, the reviewer lacks focused context. Split the node into smaller nodes so each has 2-5 source files with the relevant aspects. Never remove aspects to make approve pass — that disables enforcement.
4. **Aspect applies to this node but not to all its files** → the aspect may be too broad for this node. Either split the node (files that need the aspect vs. files that don't), or refine the aspect content.md to scope which files it applies to.

**Never remove an aspect from a node to bypass a rejection.** If approve fails, the fix is in the code, the aspect wording, or the node structure — not in removing enforcement.`;

// prettier-ignore
const GUARD_RAILS = `## GUARD RAILS

### Core Rules

1. **Graph first.** Before reading, researching, planning, or modifying ANY source file, run \`yg context --file <path>\`. For blast radius, also run \`yg impact\`. The graph is your primary source of architectural understanding.
2. **Aspects are the specification; code implements; approve verifies.** Aspects define enforceable rules. Code must satisfy them. Approve checks compliance. This is the enforcement loop.
3. **Check blocks commits and CI.** \`yg check\` must pass before every commit. Treat this as fact. All errors (drift, structural, coverage, completeness) must be resolved.
4. **Never invent rationale.** If you don't know why a requirement exists, ask the user. Never hallucinate the reason behind an aspect.
5. **Ask before resolving ambiguity.** When multiple valid interpretations exist, stop, list options, ask the user. Never silently choose.
6. **Yggdrasil is invisible to the user.** Never mention the graph, aspects, flows, nodes, \`yg\` commands, or \`.yggdrasil/\` in conversation with the user. Present graph knowledge as your understanding — "this module handles X" not "the graph says this module handles X."

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
- **Incremental approval.** Run \`yg approve\` per node after every 3-5 source file changes. Do not defer to end of task.
- **Never defer approval.** When you finish modifying code, approve immediately. Do not say "I'll approve later" or leave drift for the next session. Approval is part of the change — the change is not done until approve passes.
- **Description maintenance.** Every \`yg-node.yaml\`, \`yg-aspect.yaml\`, and \`yg-flow.yaml\` has a \`description\` field. Write it when creating new elements. Update it when the element's identity or purpose changes.

### Aspect Discovery During Implementation

Aspects emerge from patterns — in greenfield AND brownfield:

- **After working on 3+ files in the same area, pause and check:** Are you applying the same pattern repeatedly? If YES, stop and create an aspect NOW.
- **Watch for "invisible" aspects:** Patterns that don't feel "architectural" but ARE cross-cutting: audit logging on every mutation, webhook dispatch after state changes, job dispatch for async operations, authorization guards on every endpoint.
- **Brownfield trigger:** When you read existing code and see the same utility called in 3+ files, that IS an aspect waiting to be created.

### Bootstrap Mode

Trigger: \`yg check\` shows \`unmapped-files\` with high uncovered file count, or 0 nodes.

- [ ] 1. Identify the active work area (files the user wants to modify)
- [ ] 2. Create nodes for areas you will work on (with aspects for enforcement)
- [ ] 3. Create minimal nodes (no aspects) for areas you will NOT work on — provides coverage without enforcement
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
