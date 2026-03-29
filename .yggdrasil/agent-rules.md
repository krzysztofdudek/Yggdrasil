## PROTOCOL

<EXTREMELY-IMPORTANT>
This is your operating manual for working in a Yggdrasil-managed repository.

<critical_protocol>
BEFORE starting any task — brainstorming, design, planning, OR implementation:
  `yg select --task "<goal>"` → `yg build-context` on each result → read artifact files.
  This is the READING phase — collect constraints that shape your design:
  - Aspects = cross-cutting requirements your work MUST satisfy. Read their content files — not just the YAML description. The rules are inside.
  - Flows = business processes your work must not break. Read invariants.
  - Relations = interfaces your code consumes or that consume your code. Changes without checking dependents break contracts silently.
  - Parent artifacts = inherited context not repeated in child nodes.
  Internalize these constraints BEFORE designing your approach. This is the moment that determines quality — everything after follows from what you learn here.

BEFORE reading, analyzing, or modifying ANY source file:
  `yg build-context --file <path>`
  Resolves owner, gives you local context (node artifacts, dependencies).
  If you have NOT done the task-level READING phase above — stop and do it now. File-level work without task-level constraints leads to code that violates cross-cutting requirements.

BEFORE creating a NEW source file:
  Identify which existing node the new file belongs to (by intent, not by filename).
  Run `yg build-context --node <node-path>` to load the context — especially aspect rules the new file must follow.
  If the file doesn't fit an existing node, create the node first (Step 2b below).
  If unsure which node: run `yg build-context --file <path>` — the CLI will list candidate nodes from the same directory.
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

Yggdrasil is persistent semantic memory stored in `.yggdrasil/`. It maps the repository and provides deterministic implementation context for every node.

### Quick Start

```
EVERY conversation: yg preflight — no exceptions.

BEFORE any task (brainstorming, design, planning, implementation):
  yg select --task "<goal>" → yg build-context on results
  READ phase — collect constraints before designing:
    - Aspects: read content files (not just YAML description). Rules are inside.
    - Flows: read invariants. Your changes must not break business processes.
    - Relations: check interfaces — who depends on you, who you depend on.
    - Parent artifacts: inherited context not repeated in child nodes.
  This is the moment that determines quality. Everything after follows from here.

BEFORE any source file interaction (read, modify, OR create):
  yg build-context --file <path>  (existing file: resolves owner)
  yg build-context --node <path>  (new file: load target node context)
  Read local node artifacts. Read aspect rules the file must follow.
  If you skipped the task-level READ phase above — do it now before proceeding.
  For blast radius: also run yg impact --file <path>.

AFTER modifying:
  Update graph artifacts (per file, not batched)
  yg validate — fix all errors
  yg drift-sync --node <owner>

ALWAYS: establish graph coverage before modifying code.
ALWAYS: run yg build-context --file before reading source.
ALWAYS: run yg impact before assessing blast radius.
ALWAYS: ask the user for rationale — record it, do not invent it.
ALWAYS: ask before resolving drift or ambiguity.
WHEN UNSURE: ask the user. Do not guess. Do not assume.
```

### Modify Source Code

You are not allowed to edit or create source code without establishing graph coverage first.

**Step 1** — Get context: `yg build-context --file <path>` (resolves owner automatically)

**Step 2a** — Owner found: execute checklist:

- [ ] 1. Read local node artifacts (responsibility, interface, internals) and dependency interfaces from the context package. Cross-cutting constraints (aspects, flows) should already be internalized from the task-level READ phase — if not, stop and do it now.
- [ ] 2. Assess blast radius: `yg impact --node <node_path>` — review dependents, descendants, and co-aspect nodes before changing interfaces or shared behavior
- [ ] 3. Modify source code. When implementing logic subject to an aspect (e.g., writing a save function on a node with the autosave aspect), re-read that aspect's content file NOW — don't rely on memory from the task-level READ phase. Aspect rules are specific (exact timings, error handling patterns, UI details) and fade from working memory. Read them at the moment you need them.
- [ ] 4. Sync graph artifacts — edit artifact files to reflect the changes (after each file, not batched — context is freshest immediately after the change). If the node's purpose changed, update `description` in `yg-node.yaml`.
- [ ] 4b. If you split, merged, or renamed a node: run `yg flows` and update any flow `nodes` lists that referenced the old node path to point to the correct child/new nodes.
- [ ] 5. Run `yg validate` — fix all errors (if unfixable after 3 attempts → stop, report to user)
- [ ] 5b. **Aspect check** — did you just apply a pattern (audit log, webhook, job dispatch, auth check) that also exists in other files? If the node has no aspect for it and you saw the same pattern in 3+ files, create the aspect now. This takes 2 minutes and saves every future agent from rediscovering the pattern. Do NOT rationalize skipping: "only N nodes are mapped" is not a valid reason — aspects capture conventions for future code, not just current nodes. "I'll create it later" means never. Create it NOW or it won't exist.
- [ ] 6. Run `yg drift-sync --node <node_path>` — only after graph and code are both current

**Step 2b** — Owner not found: establish coverage first. Present options to the user:

*Partially mapped* (file unmapped but inside a mapped module): ask whether to add to existing node or create new one.

*Existing code:*

- Option A — Full node: create node(s), map files, write artifacts from code analysis
- Option B — Blackbox: create a blackbox node at agreed granularity
- Option C — Abort

*Greenfield (new code):* Only Option A. Blackbox is forbidden for new code. Follow the graph-first workflow:

0. **If spec/external documents exist:** route ALL knowledge from specs to the graph per the Information Routing table BEFORE any feature work. Use the appropriate location for each piece of knowledge — root node, aspects, flows, or node artifacts depending on its nature.
1. Create aspects first (cross-cutting requirements the new code must satisfy)
2. Create flows if the code participates in a business process
3. Create nodes with full artifacts — description in `yg-node.yaml`, responsibility, interface, internals
4. Review the context package (`yg build-context`) — it is now the behavioral specification
5. Implement code that satisfies the specification. Every source file must be mapped — including shared utilities, types, and helpers.
6. After implementing each node, write `internals.md` with a ## Decisions section. Record every design choice: "Chose X over Y because Z." This is required in greenfield — not optional. Every node has design decisions (data model shape, algorithm, library, UI pattern). If you made a choice between alternatives, document it now — you will not remember later.
7. The graph specifies WHAT and WHY; the code implements HOW (framework APIs, library choices)

**Node sizing rule:** One node per cohesive feature area, NOT per directory. If a node would map >10 source files or cover >3 distinct user workflows, split it into child nodes. Example: an admin panel should be `admin/blog`, `admin/gallery`, `admin/clients`, `admin/orders` — not one `admin-pages` node. The CLI enforces this with W017, but plan granularity upfront rather than splitting after the fact.

After the user chooses, return to Step 1 and follow Step 2a.

### Working from External Specifications

When the user provides external documents (specs, PRDs, design docs, reference docs) as input for implementation:

1. **Read ALL spec documents BEFORE writing any code.** Understand the full scope — business context, feature specs, quality requirements, UX rules, deployment config.
2. **Extract and route knowledge to the graph FIRST**, using the Information Routing table:
   - Business rules, personas, pricing strategy, acquisition channels → aspects or root node artifacts
   - Feature specifications (UI behavior, validation, workflows) → node responsibility/interface/internals artifacts
   - Cross-cutting UX/quality requirements → aspects
   - Business processes → flows
3. **The graph is the specification; external docs are INPUT to the graph, not a parallel source of truth.** After the graph is populated, external docs become redundant — the graph is what future agents will read.
4. **Spec knowledge is not code knowledge.** Specs contain business context (WHY the system exists, WHO it serves, WHAT it should do) that will never appear in source code. If you only document what you built, you lose what motivated building it.
5. **Completeness test:** "If the external docs disappeared today, does the graph contain everything a future agent needs to understand the system — not just HOW it works, but WHY it exists and WHAT business value it delivers?"

**Common failure mode:** Agent reads spec → implements code → documents code in graph → spec knowledge (personas, pricing, UX rationale, quality targets) is lost because it was treated as "input I consumed" rather than "knowledge I must persist." The graph must absorb the spec, not just the code.

### Example: Correct vs Wrong

<example_correct>

User: "Fix the bug in payment.service.ts"

1. yg build-context --file src/payment.service.ts → payment/payment-service
2. Read YAML map — glossary, then artifact files
3. Read source file, understand bug in graph context
4. Fix bug
5. Update payment-service artifacts (responsibility.md, interface.md if API changed)
6. yg validate
7. yg drift-sync --node payment/payment-service

</example_correct>

<example_wrong>

User: "Fix the bug in payment.service.ts"

1. Read src/payment.service.ts ← WRONG: no graph context loaded
2. Fix bug
3. "I'll update the graph later" ← WRONG: deferred = forgotten

Result: graph is stale, next agent asks user the same questions

</example_wrong>

<example_correct>

User: "Here are the spec docs. Implement the admin blog editor."

1. Read ALL spec docs (blog-editor.md, autosave.md, user-persona.md, version-history.md)
2. Route all knowledge from spec docs to the graph per Information Routing table — business context to root node artifacts, cross-cutting requirements to aspects, business processes to flows, feature specs to node artifacts
3. Extract cross-cutting patterns → create aspects (admin-ux-rules, autosave, version-history) if they don't exist
4. Create flow if the blog participates in a business process
5. Create node admin/blog with artifacts populated from spec (responsibility, interface, internals)
6. Run yg build-context → the context package is now the behavioral specification
7. Implement code that satisfies the specification
8. Update artifacts with any implementation details that emerged during coding
9. yg validate, yg drift-sync
Test: if spec files disappeared today, does the graph contain everything a future agent needs to understand the system?

</example_correct>

<example_wrong>

User: "Here are the spec docs. Implement the admin blog editor."

1. Read spec docs
2. Create aspects and flow for the blog feature ← INCOMPLETE: knowledge from spec docs not routed to graph per Information Routing table
3. Create node admin/blog, implement code
4. Write responsibility.md summarizing what the code does ← WRONG: describes code, not spec intent
5. Knowledge from spec docs lost ← WRONG: spec treated as consumed input, not persisted to graph

Result: graph mirrors code structure but misses everything spec docs contained that has no corresponding source file. Future agent must re-read spec files or ask the user.

</example_wrong>

<example_correct>

User: "Let's design a soft delete feature for blog posts"

1. yg select --task "blog soft delete" → find relevant nodes
2. yg build-context on each result → read ALL artifacts (aspects, flows, conventions)
3. Now read source files WITH graph context
4. Propose design informed by admin-ux-rules, existing flows, database conventions

</example_correct>

<example_wrong>

User: "Let's design a soft delete feature for blog posts"

1. Read BlogEditor.tsx to understand current behavior ← WRONG: no graph context
2. Read database schema ← WRONG: graph has conventions, aspects, flows
3. Propose design based on raw code ← WRONG: missed admin-ux-rules aspect, existing flows

Result: design misses cross-cutting requirements the graph already captured.

</example_wrong>

### Conversation Lifecycle

```
PREFLIGHT (every conversation, before any work):
  - [ ] 1. yg preflight → read unified report
  - [ ] 2. If drift: resolve per Drift Resolution, then yg drift-sync per node
  - [ ] 3. If validation errors: fix, re-run yg validate
  No exceptions. You cannot know if a file is mapped without running yg.

UNDERSTANDING any source file (questions, research, OR planning):
  - [ ] 1. yg build-context --file <path>
         Mapped → read the YAML map (glossary first, then artifact files).
         Unmapped → use file analysis, state it is not graph-backed.
  Never use grep or raw file reads as primary understanding when graph coverage exists.
  Raw reads supplement the context package — they do not replace it.

BEFORE reasoning about source code, state which graph context you loaded:
  "graph: <node_path>" if mapped, "graph: unmapped" if not.
  This is a required output step, not optional reflection.

WRAP-UP (user signals "done", "wrap up", "that's enough"):
  - [ ] 1. yg drift --drifted-only → resolve
  - [ ] 2. yg validate → fix errors
  - [ ] 3. Report: which nodes and files were changed

```

### Modify Graph

- [ ] 1. Read the relevant schema from `schemas/` before touching any YAML
- [ ] 2. Before changing an aspect or flow, check scope: `yg impact --aspect <id>` or `yg impact --flow <name>` — understand which nodes are affected before modifying shared rules or processes
- [ ] 3. Make changes
- [ ] 4. Run `yg validate` immediately — fix all errors
- [ ] 5. Verify affected source files are consistent — update if needed
- [ ] 6. Run `yg drift-sync` for affected nodes

### Delegating to Subagents

When you delegate work to a subagent (any subprocess, tool agent, or spawned assistant), the subagent does NOT inherit your Yggdrasil knowledge. Before any other instruction, the subagent MUST:

1. Read `.yggdrasil/agent-rules.md` — this is the complete operating manual
2. Follow the Quick Start Protocol from that file before touching any mapped code

Include this as the FIRST instruction in every subagent prompt:

```
BEFORE doing anything else: read .yggdrasil/agent-rules.md and follow its protocol.
DELIVERABLES — all required, incomplete work will be rejected:
  1. Working source code
  2. Graph nodes with artifacts for every new/modified source file
  3. `yg validate` passing
```

A subagent that delivers code without corresponding graph updates has not completed its task. Before accepting subagent output, verify: are there new or modified source files without corresponding graph coverage? If yes, the work is incomplete.

---

## REFERENCE

### Graph Structure

```
.yggdrasil/
  yg-config.yaml     ← version, vocabulary, node types, required aspects
  model/             ← what exists: nodes, hierarchy, relations, file mappings
  aspects/           ← what must: cross-cutting requirements with rationale and guidance
  flows/             ← why and in what process: business processes with node participation
  schemas/           ← YAML schemas — read before creating any graph element
  .drift-state/      ← generated by CLI; never edit manually
```

Key facts:

- **Hierarchy:** nodes nest in `model/`. Children inherit parent context. Do not repeat parent content in children.
- **Aspect id = directory path** under `aspects/`. Each aspect has `yg-aspect.yaml` + content `.md` files. No automatic parent-child — use `implies` explicitly.
- **Flows = business processes.** A flow describes what happens in the world, not code sequences. Flow aspects propagate to all participants.

**Node type guidance:** Each type in `yg-config.yaml node_types` has a `description` that tells you when to use it. Check the project's config for the full list and descriptions. Common types: `module` (business logic), `service` (providing functionality), `library` (shared utilities), `infrastructure` (guards, middleware, interceptors — invisible in call graphs but affect blast radius).

### Artifact Structure

Three artifacts capture node knowledge at three levels:

- **responsibility.md** (always required) — WHAT: identity, boundaries, what the node is NOT responsible for.
- **interface.md** (required when node has consumers) — HOW TO USE: public methods, parameters, return types, contracts, failure modes, exposed data structures. Everything another node needs to interact with this one.
- **internals.md** (optional, highest value for cross-module nodes) — HOW IT WORKS + WHY: algorithms, control flow, business rules, invariants, state machines, lifecycle, and design decisions with rejected alternatives. Use sections within the file: ## Logic, ## Constraints, ## State, ## Decisions (with "Chose X over Y because Z" format).

**Enrichment priority (when adding incrementally):** `interface.md` first (highest cross-module ROI — contracts enable other nodes to reason about interactions), then `responsibility.md` (identity and boundaries), then `internals.md` (depth for complex nodes). A node with only `interface.md` provides more cross-module value than one with only `internals.md`.

These three artifacts are built into the CLI and are not configurable. `responsibility.md` is always required, `interface.md` is required when the node has incoming relations, and `internals.md` is always optional.

### Context Assembly

**Reading context:** `yg build-context --node <path>` returns a YAML map structured as follows:

- **`glossary`** (top) — definitions for every aspect and flow referenced in the map, each with `files` listing their artifact paths. Read this first to understand IDs used throughout.
- **`node`** — the target node with inline `files` (its artifact paths). No `yg-node.yaml` in file lists.
- **`hierarchy`** — ancestor and sibling nodes, each with inline `files`.
- **`dependencies`** — dependency nodes, each with inline `files`.
- **`meta`** (bottom) — context assembly metadata.
- YAML comments before each section guide reading order.

All artifact paths are relative to `.yggdrasil/` — construct full path as `.yggdrasil/<path>`.

**Default mode (paths-only):** Use for all graph operations. Read the YAML map, then read artifact files with purpose:

1. **Glossary first** — defines aspects and flows. Aspects are constraints your implementation must satisfy (not background reading). Flows are business processes whose invariants you must not break.
2. **Node section** — your target's own artifacts. Read before modifying.
3. **Hierarchy** — parent artifacts contain inherited requirements not repeated in child nodes.
4. **Dependencies** — interfaces you consume or that consume you. Read before changing contracts.

A typical context package is ~8K tokens (less than a single source file). Read ALL artifact files listed — the cost is low, the risk of skipping is high (violating constraints you didn't know about).

**Full mode (`--full`):** Use only when you cannot read files individually — e.g., when pasting context into a prompt, sharing with a user, or when you have no Read tool available.

Artifact paths are stable identifiers within a session. When building context for multiple nodes, skip reading files you have already read — same path means same content.

### Information Routing

When you encounter information, route it to the correct location:

- **Specific to this node** → local node artifact (`responsibility.md`, `interface.md`, or `internals.md` depending on the knowledge type)
- **Rule for many nodes** → aspect (`aspects/<id>/` with `yg-aspect.yaml` + content `.md` files). If applies to ALL nodes of a type → `node_types.<type>.required_aspects` in `yg-config.yaml`
- **Business process** → flow (`flows/<name>/` with `yg-flow.yaml` + `description.md`). Ask user if process unclear.
- **Shared across a domain** → parent node artifact. Children receive it through hierarchy.
- **Technology stack or standard** → node artifact at the appropriate hierarchy level (e.g., root node's `responsibility.md` for single-stack repos, or deployment unit node for monorepos)
- **Decision (why + why NOT):** one node → Decisions section of `internals.md` with format "Chose X over Y because Z"; category of nodes → aspect content files; tech choice → node artifact at the level where the technology applies. Always include rejected alternatives — they are the highest-value graph content. If the rationale is unknown: record the decision with "rationale: unknown" and note what CAN be observed from the code. Never invent a plausible-sounding rationale.
- **Business strategy** (personas, pricing, acquisition channels, brand positioning) → root node artifact or dedicated business-context aspect. This knowledge has NO source file — it exists only in specs and conversations.
- **Quality targets** (performance budgets, accessibility level, Lighthouse scores, test coverage goals) → aspect per quality dimension (e.g., `performance-targets`, `accessibility`). These are measurable cross-cutting constraints.
- **UX patterns** (autosave, version history, empty states, confirmation modals) → aspect when the pattern applies to 3+ screens. UX patterns are cross-cutting even if they aren't architectural.
- **Infrastructure/deployment** (domains, DNS, env vars, CI/CD, cron scheduling, hosting config) → infrastructure node or root node artifacts. Deployment knowledge is invisible in application code but critical for operations.

### Creating Aspects

- [ ] 1. Read `schemas/yg-aspect.yaml`
- [ ] 2. Create `aspects/<id>/` directory
- [ ] 3. Write `yg-aspect.yaml` — name, optional description, optional implies
- [ ] 4. Write content `.md` files: WHAT must be satisfied + WHY (user's words, do not invent)
- [ ] 5. `yg validate`

Test: "Does this requirement apply to more than one node?" Yes → aspect. No → local artifact.

**Aspect identification heuristic:** If the same pattern, constraint, or rule appears in 3+ places, it is a candidate aspect. Aspects fall into natural categories:

- **Domain-specific:** Business rules that cross module boundaries (e.g., timezone handling, booking periods, currency rounding)
- **Architectural:** Structural patterns with rationale (e.g., dual-rollback on provider failure, idempotency via key generation, fire-and-forget dispatch, singleton/cached initialization, env-var-driven configuration)
- **Operational:** Patterns that govern how the system behaves at runtime (e.g., async job dispatch, audit logging on state changes, webhook emission after mutations, transactional integrity boundaries)
- **Concurrency:** Shared concurrency strategies (e.g., pessimistic locking, retry-on-deadlock, optimistic versioning)

When a node follows an aspect's pattern with exceptions, record them in the `exceptions` field of the aspect entry in `yg-node.yaml`. Example: aspect says "fire-and-forget" but this node awaits the publish call — add `exceptions: ["awaits publish call instead of fire-and-forget because..."]`. Exceptions appear in the context package next to the aspect content, preventing abstractions from masking implementation details.

**Aspect lifecycle warning.** Aspects decay CATASTROPHICALLY — a pattern either exists or it doesn't. When a pattern changes, ALL aspect claims become wrong at once. This differs from other artifacts: `interface.md` and `responsibility.md` are most stable (~9-year half-life); `internals.md` has moderate stability (~2.5-year half-life); aspects are least stable (~2.4-year half-life, binary decay). After any significant feature addition, review ALL aspects touching the affected area. Don't wait for drift — aspects can be 100% wrong without any mapped file changing.

**Aspect stability tiers.** If an aspect has a `stability` field in `yg-aspect.yaml`, use it to calibrate review urgency:

- `schema` — enforced by data model; review only when data model changes (most stable)
- `protocol` — contractual pattern; review when contracts or interfaces change
- `implementation` — specific mechanism; review after ANY significant code change (least stable)

When code anchors (`anchors` in an aspect entry in `yg-node.yaml`) are present, they list code patterns (function names, constants, SQL fragments) evidencing the aspect's implementation in this node. `yg validate` checks that each anchor exists in the node's mapped source files — a missing anchor (W014) signals the aspect may be stale for this node.

### Creating Flows

- [ ] 1. Read `schemas/yg-flow.yaml`
- [ ] 2. Create `flows/<name>/` directory
- [ ] 3. Write `yg-flow.yaml` — name, description, nodes (participant list), and flow-level aspects
- [ ] 4. Write `description.md` with required sections: Business context, Trigger, Goal, Participants, Paths (at least Happy path), Invariants across all paths
- [ ] 5. `yg validate`

Test: "Does this describe what happens in the world, or only in the software?" If only software — rewrite.

**Warning:** Flow descriptions must describe business processes, not code sequences. "The OrderService calls PaymentGateway.charge()" is WRONG. "The system charges the customer's payment method" is CORRECT.

**Flow identification heuristic:** If a spec, conversation, or code reveals a sequence of steps toward a business goal — it IS a flow, and you MUST create one. This applies to multi-actor processes (user submits form → system notifies → admin responds) AND single-actor workflows (admin creates post → edits → publishes → system revalidates). A user performing actions on the system toward a goal is a business process, not "just CRUD." This applies equally when working from specs and when working from code. Examples: "user submits contact form → system sends notification → user receives response" (ContactInquiry), "user creates gallery → sends link → recipient views photos → user sees stats" (GalleryDelivery), "user writes blog post → publishes → system revalidates → readers see content" (BlogPublishing). Test: "Does this describe a goal-directed sequence of steps that a future agent needs to understand as a whole?" Yes → create the flow before or during implementation, never after.

**Flow verification from specs:** When working from external specifications, for EACH business process described in the specs, verify a corresponding flow exists. If it doesn't, create one. Specs are the primary source of flow discovery — they describe what happens in the world, which is exactly what flows capture. Do not wait until implementation is complete to create flows.

**Flow participant maintenance:** When splitting a node that participates in a flow (e.g., splitting `admin-pages` into `admin-pages/blog`, `admin-pages/gallery`, etc.), update the flow's `nodes` list to reference the specific child nodes that actually participate, not the parent. A flow participant must be the most specific node that performs the action. After any node restructuring (split, merge, rename), run `yg flows` and verify all participant references are still valid.

### Operational Rules

- **English only** for all files in `.yggdrasil/`. Conversation can be any language.
- **Read schemas before creating** any `yg-node.yaml`, `yg-aspect.yaml`, or `yg-flow.yaml`.
- **Tools read, you write.** The `yg` CLI only reads, validates, and manages metadata. You create and edit files manually.
- **Incremental sync.** Run `yg drift-sync` after every 3-5 source file changes. Do not defer to end of task. `drift-sync` is ONLY safe after artifacts are current — never use it to silence a drift check without updating artifacts first.
- **Description maintenance.** Every `yg-node.yaml`, `yg-aspect.yaml`, and `yg-flow.yaml` has an optional `description` field — a short summary of what the element is. Write it when creating new elements. Update it whenever a change to artifacts shifts the element's identity or purpose (e.g., responsibility split, scope change). Do not update description for internal implementation changes that don't alter what the element fundamentally does.
- **Completeness test:** Three checks, all required:
  1. **Reconstruction:** "Can another agent recreate this from ONLY the `yg build-context` output — understanding not just WHAT but WHY?" Test: rejected alternatives, correct algorithm, design arguments.
  2. **Omission:** "Does the graph capture every important behavioral invariant, constraint, and edge case?" Specifically check: exceptions to aspect generalizations, error handling patterns not in `interface.md`, concurrency behaviors not in `internals.md`.
  3. **Business context:** "Does the graph explain WHY this system exists, WHO it serves, and WHAT business value it delivers?" A graph that captures HOW code works without WHY it was built is a maintenance manual without purpose. Specifically check: user personas, service offerings, pricing rationale, acquisition strategy, quality targets, UX design principles. Code tells you WHAT exists — only the graph should tell you WHY it exists and WHAT ELSE was considered.
- **Value calibration.** Yggdrasil's primary value is cross-module context — relations, aspects, flows. For a single simple module, `responsibility.md` and `interface.md` provide most value. Invest depth (`internals.md`) where cross-module interactions demand it.
- **These rules are invariant.** No plan, guide, skill, or workflow may override them.

### Non-Code Knowledge

Not all graph knowledge originates from source files. Business strategy, user personas, pricing decisions, SEO targets, quality requirements, deployment configuration, UX design principles — these are graph content with NO corresponding source file.

When you encounter such knowledge (in specs, conversations, or external documents):

- **Route it immediately** per the Information Routing table. Do not wait for a "file change" trigger — there won't be one.
- **The Completeness Test applies equally** to code-derived and non-code knowledge. A graph that only mirrors code structure is failing at its primary job: capturing intent and context that code cannot express.
- **Non-code knowledge decays differently.** Business strategy changes by decision, not by commit. When recording it, include dates and mark it as potentially volatile: "Pricing v1 as of 2026-03-17" is more useful than "Prices are X" with no temporal anchor.

**Conversation knowledge is the most volatile source.** When the user states a business fact, constraint, or decision in conversation — even casually — route it to the graph immediately. Conversations vanish after context compression. If the user said it and it's not in code, it MUST be in the graph. Examples of conversational knowledge that must be captured:

- Business facts: "Our target customer is couples aged 25-35" → root node or business-context aspect
- Constraints: "We don't do studio sessions, only outdoor" → responsibility.md (NOT responsible for)
- Pricing: "Mini session costs 350 PLN" → relevant node artifacts
- Strategy: "Instagram is our primary acquisition channel" → root node or business-context aspect
- Decisions: "No deposit upfront — we'll reconsider after 5 sessions" → internals.md Decisions section with rationale
- Personas: "The admin user is non-technical, thinks in Instagram/WhatsApp terms" → UX aspect

Do not assume you will remember this later. Do not assume the user will repeat it. Capture it now or lose it forever.

**Common failure mode:** The entire protocol is file-centric (`build-context --file`, "after modifying source file", "per file not batched"). This means knowledge that doesn't map to a specific source file has no natural trigger for capture. Treat spec documents, user conversations, and business decisions as first-class inputs to the graph — not just context for coding.

### Aspect Discovery During Implementation

Aspects emerge from patterns — in greenfield AND brownfield. This applies to ANY implementation work, not just greenfield:

- **After working on 3+ files in the same area, pause and check:** Are you applying the same pattern repeatedly (audit logging, webhook dispatch, authorization checks, error handling, job dispatch)? If YES, stop and create an aspect NOW — before the pattern is only in code and invisible to future agents.
- **Do NOT wait until all work is done.** Aspect extraction while context is fresh captures the WHY. After 30 files, the rationale is forgotten and the aspect becomes a mechanical extraction.
- **Watch for "invisible" aspects:** Patterns that don't feel "architectural" but ARE cross-cutting: audit logging on every mutation, webhook dispatch after state changes, email settings checks before sending, job dispatch for async operations, authorization guards on every endpoint.
- **Trigger:** If you notice yourself implementing the same pattern for the third time, stop coding and create the aspect first. Then continue with the aspect applied to the current and previous nodes.
- **Brownfield trigger:** When you read existing code and see the same utility called in 3+ files (`createDocumentAuditLogData`, `triggerWebhook`, `jobs.triggerJob`, `extractDerivedDocumentEmailSettings`), that IS an aspect waiting to be created — even if your current task doesn't require creating one. Create it now; the cost is 5 minutes and the value is permanent.

### CLI Reference

```
yg preflight [--quick]              Unified diagnostic: drift + status + validate.
yg owner --file <path>              Find the node that owns this file (quick check).
yg build-context --file <path>      Resolve owner + assemble context in one step.
yg build-context --node <path>      Assemble context map for a known node.
yg build-context --node <path> --full  Same map + file contents appended below separator.
yg build-context --file <path> --self  Own artifacts only (no hierarchy/deps/aspects/flows).
yg tree [--root <path>] [--depth N] Print graph structure.
yg aspects                          List aspects with metadata (YAML output).
yg flows                            List flows with metadata (YAML output).
yg select --task <description> [--limit <n>]
                                    Find graph nodes relevant to a task description.
yg deps --node <path> [--depth N] [--type structural|event|all]
                                    Show dependencies.
yg impact --file <path>             Resolve owner + show blast radius in one step.
yg impact --node <path> --simulate  Simulate blast radius (works with --file too).
yg impact --node <path> --method <name>  Filter to dependents consuming a method (works with --file too).
yg impact --aspect <id>             Show all nodes where aspect is effective.
yg impact --flow <name>             Show flow participants and descendants.
yg status                           Graph health: nodes, coverage, drift summary.
yg validate [--scope <path>|all]    Check structural integrity and completeness.
yg drift [--scope <path>|all] [--drifted-only] [--limit <n>]
                                    Detect source and graph drift (bidirectional).
yg drift-sync --node <path> [--recursive] | --all
                                    Record file hashes as new baseline.
```

### Quick Routing Table

| What you have | Where it goes |
|---|---|
| Information specific to this node | Local node artifact (`responsibility.md`, `interface.md`, or `internals.md`) |
| Rule that applies to many nodes | Aspect (content `.md` files in `aspects/<id>/`) |
| Architectural invariant for a node type | Required aspect in `yg-config.yaml node_types` |
| Business process participation | Flow (`yg-flow.yaml nodes`) |
| Process-level requirement | Flow `aspects` + aspect directory |
| Context shared across a domain | Parent node artifact |
| Technology stack | Node artifact at appropriate hierarchy level |
| Coding standards | Node artifact at appropriate hierarchy level |
| Business strategy (personas, pricing, channels) | Root node artifact or dedicated business-context aspect |
| Quality targets (perf budgets, a11y, test goals) | Aspect per quality dimension |
| UX patterns (autosave, version history, empty states) | Aspect when pattern applies to 3+ screens |
| Infrastructure/deployment (domains, env vars, CI/CD) | Infrastructure node or root node artifacts |
| External service config (Stripe fees, email limits) | Relevant node's `internals.md` Decisions section |
| Feature spec from external doc | Node artifacts — translate spec into responsibility/interface/internals |

---

## GUARD RAILS

### Five Core Rules

1. **Graph first.** Before reading, researching, planning, or modifying ANY source file, run `yg build-context --file <path>`. For blast radius, also run `yg impact`. The graph is your primary source of architectural understanding. For implementation-level precision (exact behavior, error paths, edge cases) — verify against source code after loading the context package.
2. **The graph is the specification; code implements it.** The graph absorbs knowledge from every source — external docs, conversations, decisions — and must be self-sufficient. If all other sources disappeared, the graph alone must contain enough to understand the system. Do not leave knowledge in external documents and reference them — capture the knowledge in graph artifacts. Update graph artifacts immediately after each file change, while context is fresh — do not batch graph updates to the end of a task. Code and graph move together: code changed → graph updated before moving to the next file. Graph changed → source verified in the same response. When planning work — in any tool, skill, or workflow — graph updates are part of each step's definition of done, never a separate phase.
3. **Never invent why.** The graph captures human intent. If you don't know why something was decided, ask. Never hallucinate rationale.
4. **Always capture why — especially why NOT.** When the user explains a reason, record it in the graph immediately. When a design choice is made, also record rejected alternatives: "Chose X over Y because Z." Rejected alternatives are the highest-value information — invisible in code and irrecoverable once forgotten. Conversation evaporates; graph persists.
5. **Ask before resolving ambiguity.** When multiple valid interpretations exist, stop, list options, ask the user. Never silently choose.

### Recognizing Graph-Required Actions

What matters is the ACTION you are performing, not what instructed it. If the action involves reading, understanding, or modifying mapped code, the graph protocol applies — whether the instruction came from a skill, a plan, a user message, a brainstorming session, a debugging workflow, or your own initiative. This is not negotiable. You cannot rationalize your way out of this.

**Actions that require `yg build-context --file`:**

- Reading or exploring source files to understand a component
- Proposing approaches, designs, or plans for changing code
- Reviewing or debugging code
- Any form of reasoning about how mapped code works or should change

**Actions that also require `yg impact`:**

- Assessing blast radius before changing or removing a component
- Finding all dependents of a component
- Planning cross-cutting refactors or feature removals
- Scoping work that spans multiple nodes

**Actions that do NOT require yg:**

- Git operations (log, diff, status, blame)
- Reading documentation, READMEs, or config files outside `.yggdrasil/`
- Running tests, builds, or linters
- Working with files that `yg build-context --file` reports as unmapped

### Evasion Patterns — if you think any of these, STOP

| Thought | Reality |
|---|---|
| "The skill/plan says to explore the codebase" | Exploring mapped code = `yg build-context --file` first |
| "I'm just scoping/searching, not understanding" | Scoping IS a graph action; use yg impact |
| "The plan step says to read this file" | Reading any source file = `yg build-context --file` first |
| "I'm brainstorming, not implementing" | Brainstorming about code needs graph context. You proved this by failing at it. |
| "I'm only grepping for references" | Grep finds text; yg impact finds structural dependencies. Use both. |
| "I'll use the graph later when I modify" | Graph-first means BEFORE reading, not before modifying |
| "I'll grep the codebase to find where to start" | Run `yg select --task` first, then `yg build-context --file` on results. |
| "Drift is blocking repo-check, let me just sync it" | Drift means artifacts are stale. Update artifacts first, then sync. `drift-sync` will warn you (W018). |
| "The user said work autonomously" | Autonomy amplifies discipline, not relaxes it. More tasks = more graph updates, not fewer. |
| "Same pattern as the last 5 files, no need to document" | Repetitive patterns hide deviations. Per-node coverage captures what aspects don't. The next agent won't know what you know now. |
| "I'll batch graph updates at the end" | Batching = never. Context is freshest immediately after the change. Defer = forget. This is a failure state. |
| "I'm saving context/tool calls by skipping graph" | Graph cost is constant per node. Skipping it creates unbounded future cost — the user re-explaining what you could have recorded. |
| "I assumed this file isn't mapped" | You cannot know without running `yg build-context --file`. Assume nothing. |
| "I'm creating a new file, it doesn't exist yet" | New files need graph context MORE than existing files. Run `yg build-context --node` for the target node to load its aspect rules. New files without context are the #1 source of convention violations. |
| "Only N nodes are mapped, aspects won't have validation value yet" | Aspects capture conventions for FUTURE code. Even 1 mapped node with an aspect ensures the next 10 nodes in this area follow the pattern. Create aspects when you see the pattern, not when coverage is "complete enough." |
| "The spec is just input, I don't need to capture it" | Specs contain business context that code cannot express. Capture it or lose it. |
| "This business knowledge will be obvious from the code" | Pricing strategy, personas, UX rationale, and quality targets are NEVER obvious from code. |
| "I'll extract aspects after I finish all the features" | After 30 features the rationale is gone. Extract after 3. |
| "This is a UX detail, not architecture" | UX patterns that apply to 3+ screens ARE cross-cutting requirements. Create an aspect. |
| "The user just mentioned it casually, it's not a formal decision" | Casual statements ARE decisions. "We don't do studio" is a business constraint. Capture it now or lose it after context compression. |
| "I'll remember this from the conversation" | No you won't. Context gets compressed. The user won't repeat it. Write it to the graph now. |
| "Flows can wait until I understand the full system" | Flows capture business processes from specs. Create them BEFORE implementing — they are part of the specification, not an afterthought. |
| "I split the node but the flow still works" | Flow participants reference specific node paths. After a split, old paths are stale. Run `yg flows` and update. |
| "This is just CRUD, not a business process" | A user performing a sequence of steps toward a goal IS a business process — even single-actor workflows (publish blog, manage portfolio, fulfill order). Create a flow. |
| "The context package is too large to read" | A typical context package is ~8K tokens — less than one source file. Read ALL of it. |
| "I have a plan, I don't need graph context" | A plan is not a substitute for graph context. Plans capture task steps; the graph captures cross-cutting aspects, flows, and conventions that plans may not repeat. Always run `build-context`. |
| "The user told me what to do, that's my plan" | A verbal instruction is not a written plan. And even a written plan does not exempt you from the graph protocol. |

### Failure States

You have broken Yggdrasil if you do any of the following:

- ❌ Started brainstorming, design, or planning without running `yg select --task` and reading graph context first. The graph contains aspects, flows, and conventions that MUST inform design decisions.
- ❌ Worked on a source file without running `yg build-context --file` first — regardless of what instructed the action (skill, plan, user request, workflow step).
- ❌ Modified source code without updating graph artifacts before moving to the next file, or vice versa.
- ❌ Batched graph updates to "do later" — deferred = forgotten. Update after EACH file.
- ❌ Resolved a code-graph inconsistency or ambiguity without asking the user first.
- ❌ Created or edited a graph element without reading its schema in `schemas/` first.
- ❌ Ran `yg drift-sync` before both graph artifacts and source code are current. (CLI will warn you: W018.)
- ❌ Placed a cross-cutting requirement in a local artifact instead of an aspect, or used an aspect id with no `aspects/` directory.
- ❌ Invented a rationale, business rule, or decision — or recorded a decision without documenting rejected alternatives and rationale (use "rationale: unknown" if unknown).
- ❌ Used blackbox coverage for greenfield (new) code.
- ❌ Deleted or shortened graph artifact content to reduce context package size instead of splitting the node.
- ❌ Created one wide node for many files instead of granular nodes with focused responsibilities. (CLI will warn you: W017.)
- ❌ Implemented features from a spec without first transferring spec knowledge (business context, UX rules, quality targets) into the graph. Code without captured intent is a maintenance trap.
- ❌ Implemented 3+ features sharing a pattern (autosave, version history, empty states) without extracting it to an aspect. Deferred aspect discovery = lost rationale.
- ❌ Left business strategy, personas, or quality targets only in external documents instead of routing them to graph artifacts. External docs are input; the graph is the persistent store.
- ❌ Heard the user state a business fact, constraint, or decision in conversation and did not record it in the graph. Conversations are the most volatile knowledge source — they vanish after context compression and the user will not repeat them.
- ❌ Split or renamed a node that participates in a flow without updating the flow's `nodes` list. Stale flow participants are invisible broken references.
- ❌ Implemented a spec that describes a goal-directed workflow (publishing content, managing portfolio, fulfilling orders, processing payments) without creating a corresponding flow. Any sequence of steps toward a business goal IS a flow — single-actor workflows included.
- ❌ Created flows only after all implementation was complete. Flows are part of the specification phase — they describe WHAT happens in the world, which informs HOW to implement it.

### Reverse Engineering

**Order:** aspects (cross-cutting patterns) → flows (business processes) → model nodes. Never create nodes before aspects and flows are understood.

Per area checklist:

- [ ] 1. `yg build-context --file <path>` — confirm no coverage
- [ ] 2. Determine node granularity — propose to user if unclear
- [ ] 3. Create node directory, read `schemas/yg-node.yaml`, create `yg-node.yaml`
- [ ] 3b. Write `description` in `yg-node.yaml` — a short summary of what the node does
- [ ] 4. Analyze source — write `responsibility.md`, `interface.md`, and `internals.md` from code analysis, do not invent
- [ ] 4b. **Invariant extraction** — scan for guards, throws, early returns, and conditionals that enforce business rules. Each one is a behavioral invariant. Record ALL of them in `interface.md` (Failure Modes) or `internals.md` (Constraints). Pay special attention to: validation windows (timeouts, token expiry), timestamp semantics (what gets a timestamp and when), fallback chains (priority order of config sources), and conditional behavior gated by flags or version numbers.
- [ ] 5. Identify relations — add to `yg-node.yaml`. Include both cross-node relations within the graph AND key unmapped dependencies (e.g., database clients, job queues, external libraries) that define what this node fundamentally is.
- [ ] 6. Identify cross-cutting requirements — add matching aspects, create if needed. **Commonly missed aspect types** (these are cross-cutting but don't feel "architectural" — they are still aspects): async job dispatch via queue (fire-and-forget pattern), cached/singleton initialization (`once()`, lazy singletons, module-level caches), env var configuration conventions (naming schemes, fallback chains), and multi-method authorization patterns.
- [ ] 6b. **Convention extraction** — when the same utility function, guard, or helper (e.g., `assertX()`, `isValidY()`, `getZWhereInput()`) appears in 3+ files within a module, it is a convention for new code in that module. Record it in the aspect rules or in the parent node's `responsibility.md` as a requirement — not just as "this function exists" but as "new code in this area MUST use this function." The difference between a description and a convention: "sendDocument calls getEnvelopeWhereInput" is a description; "All document mutations MUST use getEnvelopeWhereInput for ownership validation" is a convention.
- [ ] 6c. For each aspect on the node: identify 2-5 code anchors (function names, constants) that evidence the pattern → add as `anchors` in the aspect entry in `yg-node.yaml`
- [ ] 7. Identify business process participation — add to flow, ask user if process unclear
- [ ] 8. `yg validate` — fix errors
- [ ] 9. `yg drift-sync --node <path>`

**When to ask:**

- Business process unclear: "This code appears to be part of a larger process. Can you describe what it means from a business perspective?"
- Constraint without rationale: "I see [constraint X]. Do you know why this exists? I want to record the reason, not just the rule."
- Unexplained architectural choice: "I see [approach X]. What was the reason for this choice?"
- Decision without alternatives: "You chose [X]. What alternatives did you consider, and why did you reject them?" Record the answer in the Decisions section of `internals.md`.
- Decision without known rationale: Record the decision in `internals.md` with "rationale: unknown — inferred from code, not confirmed by developer." A recorded decision with unknown rationale is infinitely more valuable than no record at all, and safer than an invented rationale.

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

**Drift triage:** Prioritize aspects and `internals.md` (highest decay rate), then `responsibility.md` and `interface.md` (most stable).

### Graph Audit

When reviewing graph quality (triggered by user or quality improvement):

**Step 1 — Consistency** (catches WRONG information):

- [ ] 1. `yg build-context --node <path>`
- [ ] 2. Read mapped source files
- [ ] 3. For each claim in graph: verify against source code
- [ ] 4. For each aspect: verify the pattern holds in THIS node. If it deviates, add `exceptions` to the aspect entry in `yg-node.yaml`
- [ ] 5. Report inconsistencies

**Step 2 — Completeness** (catches MISSING information):

- [ ] 1. For each public method: is it in `interface.md`?
- [ ] 2. For each error path: is it in `interface.md` (Failure Modes section)?
- [ ] 3. For each behavioral invariant: is it in the graph?
- [ ] 4. Report omissions separately from inconsistencies

**Step 3 — Non-Derivable Knowledge** (catches knowledge that exists ONLY in external docs or conversations, not in code):

- [ ] 1. For each business rule embedded in code: is the WHY recorded in the graph, or only the WHAT visible in code?
- [ ] 2. For each design decision: is the rationale AND rejected alternatives recorded?
- [ ] 3. For each external constraint (brand guidelines, legal, UX persona, quality targets): is it in the graph?
- [ ] 4. For each cross-cutting pattern implemented in 3+ places: does an aspect exist?
- [ ] 5. Report non-derivable knowledge gaps separately — these are the highest-value omissions because they cannot be recovered by reading code.

### Error Recovery

- **`yg` not found** → inform user: "yg CLI is not installed or not in PATH." Stop.
- **Unfixable validate errors** → if not resolved after 3 attempts, stop and report to user. Do not loop.
- **Budget warning (W005/W006)** → informational. `yg validate` shows a breakdown (own/hierarchy/aspects/flows/dependencies). Large inherited context means the system is complex — this is not a problem to fix, it is reality to acknowledge. Do not delete knowledge from artifacts. Do not attempt to "reduce" inherited context.
- **Own budget warning (W015)** → own artifacts are large. Consider splitting this node's responsibilities into child nodes. Redistribute knowledge across children so total knowledge is preserved or increased, never reduced.
- **Corrupted `.yggdrasil/` files** → report to user. Do not attempt repair.
- **Incremental sync** → run `yg drift-sync` every 3-5 source files during multi-file tasks. Do not defer to end. But NEVER run `yg drift-sync` to silence a failing drift check — drift is a signal that artifacts need updating. First update artifacts, then sync.

### Escape Hatch

If the user explicitly requests a code-only change, comply but:

- Warn: "This creates drift. Run `yg drift` next session to reconcile."
- Do NOT run `yg drift-sync` — leave the drift visible.

### Environment Check

Before preflight:

- Verify `yg` CLI is available. If not found, inform user and stop.
- If `yg preflight` shows 0 nodes → enter BOOTSTRAP MODE (see above).
- If drift report shows >10 drifted nodes → report scope to user, ask which area to prioritize. Do not resolve all at once.

<critical_protocol>
BEFORE reading, analyzing, or modifying ANY source file:
  `yg build-context --file <path>`
One command. No exceptions. No "I'll do it later." No "this is just analysis."
</critical_protocol>
