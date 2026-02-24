/**
 * Canonical agent rules content — hand-tuned, do not generate programmatically.
 *
 * Operating manual for agents: graph-first, exhaustive coverage, context is sufficient.
 */
export const AGENT_RULES_CONTENT = `# Yggdrasil - System Semantic Memory (Operating Manual)

You are working in a repository managed by Yggdrasil.
Yggdrasil is a persistent, structured semantic memory graph stored in \`.yggdrasil/\`. It maps the repository, dictates system rules, and assembles implementation contexts.

THIS PROMPT IS YOUR ENTIRE OPERATING MANUAL. Read it carefully. Follow it strictly.

---

## 0. ATOMIC INVARIANT — OVERRIDES EVERYTHING

**CODE ↔ GRAPH ARE ONE.**
- Code changed → graph artifacts MUST be updated IN THE SAME RESPONSE. No exceptions.
- Graph changed → source files MUST be verified/updated IN THE SAME RESPONSE. No exceptions.
- There is NO "code-only" response. There is NO "graph-only" response (unless explicitly a dry-run plan).
- If you complete a response and one side is changed but the other is not, you have VIOLATED the core contract of Yggdrasil.

---

## 1. CORE PRINCIPLES (NON-NEGOTIABLE)

1. **Graph First, Always:** Before answering a question, modifying code, or planning a feature, you MUST consult the graph.
2. **Context is Sufficient:** If you feel the need to randomly explore source files to understand what a node should do, the graph is incomplete. **Fix the graph** (add decisions, interface details, constraints). Do not bypass the graph by reading raw code.
3. **Graph is Intended Truth:** If the code and graph diverge, the graph is the truth. If a code change is deliberate, update the graph to match.
4. **Exhaustive Coverage:** Every source file MUST belong to exactly one graph node. No orphaned files.
5. **Tools Read, You Write:** The \`yg\` CLI tools only read, validate, and manage metadata. YOU must create and edit graph directories, \`.yaml\` files, and \`.md\` artifacts manually.
6. **English Only for Artifacts:** All graph artifact files (filenames from \`config.artifacts\`, in the same directory as \`node.yaml\`) MUST be written in English. Conversation can be in the user's language.
7. **Never Touch Operational Metadata:** NEVER manually edit \`.yggdrasil/.drift-state\` or \`.yggdrasil/.journal.yaml\`.
8. **Ask, Never Infer:** If graph and code diverge in a way with multiple valid resolutions, or if a required decision is ambiguous — STOP. State the ambiguity. List interpretations. Ask the user to decide. Never silently choose. Never patch without confirmation.

---

## 1.5 FAILURE STATES

You have fundamentally broken Yggdrasil if you do any of the following:
- ❌ You modified source code without updating graph artifacts in the SAME response.
- ❌ You modified graph files without verifying/updating source code alignment in the SAME response.
- ❌ You resolved a code↔graph inconsistency without asking the user first.
- ❌ You created or edited a graph element without reading its schema in \`.yggdrasil/templates/\`.
- ❌ You ran \`yg drift-sync\` before updating graph artifacts.
- ❌ You ran \`yg drift-sync\` after a graph-only change without verifying source files.
- ❌ You used Blackbox coverage for greenfield/new code.

---

## 2. CONVERSATION LIFECYCLE (YOUR HABITS)

You do not need explicit "session" commands. Follow these conversational triggers:

### A. Preflight (First message of the conversation)
Always execute these commands before doing anything else. *(Exception: If the user's request is clearly read-only, like "explain this", run ONLY step 1).*
1. \`yg journal-read\` -> If entries exist, consolidate them into the graph, then \`yg journal-archive\`.
2. \`yg drift\` -> If divergence is detected, present states (\`ok\`, \`drift\`, \`missing\`, \`unmaterialized\`). Ask the user: Absorb (update graph) or Reject (re-materialize code from graph)?
3. \`yg status\` -> Report graph health.
4. \`yg validate\` -> If W008 stale-knowledge appears, update the knowledge artifacts to reflect current node state.

### B. Session Verification (Wrap-up)
Triggered by phrases like: "we're done", "wrap up", "that's enough", "done".
**Note: The graph should ALREADY be up to date. If the graph requires massive updates at this stage, YOU HAVE FAILED.**
1. If iterative journal mode was used: consolidate notes to the graph, then \`yg journal-archive\`.
2. \`yg drift\` -> Check if files changed manually during the conversation.
3. \`yg validate\` -> Fix any structural errors.
4. Report exactly what nodes and files were changed.

---

## 3. WORKFLOW: MODIFYING OR CREATING FILES (Code-First)

You are NOT ALLOWED to edit or create source code without establishing graph coverage first.

**Step 1: Check coverage** -> Run \`yg owner --file <path>\`

**Step 2: If Owner FOUND (The Execution Checklist)**
Whenever you write or edit source code, you MUST output this exact checklist in your response to the user, and execute each step BEFORE finishing your turn:

- [ ] 1. Read Specification (ran \`yg build-context\`)
- [ ] 2. Modify Source Code
- [ ] 3. Sync Graph Artifacts (manually edit the node's artifact files IMMEDIATELY to match new code behavior)
- [ ] 4. Baseline Hash (ran \`yg drift-sync\` ONLY AFTER updating the graph)

**Step 3: If Owner NOT FOUND (Uncovered Area)**
STOP. Do not modify the code. First determine: **Is this greenfield or existing code?**

* **If GREENFIELD (empty directory, new project):** Do NOT offer blackbox. Create proper nodes (reverse engineering or upfront design) before implementing.
* **If PARTIALLY MAPPED (file is unmapped, but lives inside a mapped module):** Stop and ask the user if this file should be added to the existing node or if a new node is required.
* **If EXISTING CODE (legacy, third-party):** Present the user with 3 options and wait:
  * **Option 1: Reverse Engineering:** Create/extend standard nodes to map the area fully before modifying.
  * **Option 2: Blackbox Coverage:** Create a \`blackbox: true\` node to establish ownership without deep semantic exploration.
  * **Option 3: Abort/Change Plan:** Do not touch the file.

---

## 4. WORKFLOW: MODIFYING THE GRAPH & BLAST RADIUS (Graph-First)

When adding features, changing architecture, or doing graph-first design:

1. **Check Blast Radius:** Before modifying a node that others depend on, run \`yg impact --node <node_path> --simulate\`. Report the impact to the user.
2. **Read Config & Templates:**
   * Check \`.yggdrasil/config.yaml\` for allowed \`node_types\` and \`tags\`.
   * **CRITICAL:** ALWAYS read the schema in \`.yggdrasil/templates/\` for the element type (node.yaml, aspect.yaml, flow.yaml, knowledge.yaml) before creating or editing it.
3. **Validate & Fix:** Run \`yg validate\`. You must fix all E-codes (Errors).
4. **Token Economy & W-codes:**
   * W005/W006: Context package too large. Consider splitting the node.
   * W008: Stale semantic memory. Update knowledge artifacts.

**Graph Modification Checklist**
Whenever you change the graph structure or semantics, you MUST output and execute this exact checklist:

- [ ] 1. Read schema from \`.yggdrasil/templates/\` (node.yaml, aspect.yaml, flow.yaml, or knowledge.yaml for the element type)
- [ ] 2. Edit graph files (\`node.yaml\`, artifacts)
- [ ] 3. Verify corresponding source files exist and their behavior matches updated artifacts
- [ ] 4. Validate (ran \`yg validate\` — fix all Errors)
- [ ] 5. Baseline Hash (ran \`yg drift-sync\` ONLY AFTER steps 2-3 are confirmed)

**Journaling (Iterative Mode Scope):**
* **Default:** Write changes directly to graph files immediately. Do not defer.
* **Opt-in:** ONLY if the user says "use iterative mode" or "use journal". Once activated, it remains active for the ENTIRE conversation until wrap-up. Use \`yg journal-add --note "..."\` to buffer intent.

---

## 5. PATH CONVENTIONS (CRITICAL)

To avoid broken references (\`E004\`, \`E005\`), use correct relative paths:
* **Node paths** (used in CLI, relations, flow nodes): Relative to \`.yggdrasil/model/\` (e.g., \`orders/order-service\`).
* **File paths** (used in mapping, \`yg owner\`): Relative to the repository root (e.g., \`src/modules/orders/order.service.ts\`).
* **Knowledge paths** (used in node explicit refs): Relative to \`.yggdrasil/knowledge/\` (e.g., \`decisions/001-event-sourcing\`).

---

## 6. GRAPH STRUCTURE, CONFIG & TEMPLATES CHEAT SHEET

The graph lives entirely under \`.yggdrasil/\`. You NEVER guess structure. You MUST ALWAYS read the corresponding schema reference in \`.yggdrasil/templates/\` before creating or editing any graph file.

* **\`.yggdrasil/config.yaml\`**: Defines \`node_types\`, \`tags\`, \`artifacts\`, \`knowledge_categories\`.
* **\`.yggdrasil/templates/\`**: Schemas for each graph layer — \`node.yaml\`, \`aspect.yaml\`, \`flow.yaml\`, \`knowledge.yaml\`.
* **\`.yggdrasil/model/\`**: Node tree. Each node is a directory with \`node.yaml\` and artifact files.
* **\`.yggdrasil/aspects/\`**: Cross-cutting rules. Directory contains \`aspect.yaml\` and \`.md\` content.
* **\`.yggdrasil/flows/\`**: End-to-end processes. Directory contains \`flow.yaml\` and \`.md\` content.
* **\`.yggdrasil/knowledge/\`**: Repo-wide wisdom. Directory contains \`knowledge.yaml\` and \`.md\` content.

---

## 7. CONTEXT ASSEMBLY & KNOWLEDGE DECONSTRUCTION (HOW TO MAP FILES)

Your ultimate goal when describing a file or node is **Context Reproducibility**. A future agent reading ONLY the output of \`yg build-context\` for this node must be able to perfectly reconstruct the source code's behavior, constraints, environment, and purpose.

However, you must NOT dump all knowledge into a single file. Yggdrasil's context package is **multi-layered** and hierarchically assembled. When you map existing code or design new code, you must deconstruct the knowledge and place it at the correct abstraction layer so the engine can mechanically reassemble it.

### CRITICAL RULE: CAPTURE INTENT, BUT NEVER INVENT IT
The graph is not just a structural map; it is the semantic meaning of the system. Code explains "what" and "how". The graph MUST explain "WHY". 

1. **ALWAYS Capture the User's "Why":** If the user explains the business reason, intent, or rationale behind a request (e.g., "We need to do X because Y"), you MUST permanently record this reasoning in the relevant graph artifacts (e.g., \`responsibility.md\`, \`constraints.md\`, \`decisions.md\`). Do not let the conversation context evaporate.
2. **NEVER Invent the "Why":** Files that imply human judgment (like \`decisions.md\` or \`knowledge/invariants\`) must reflect ACTUAL human choices. 
3. **NO Hallucinations:** You MUST NEVER infer or hallucinate a rationale, an architectural decision, or a business rule. 
4. **Ask if Missing:** If the user requests a significant architectural or business logic change but does not provide the rationale, you MUST ask them "Why are we making this change?" before documenting the decision in the graph.

When mapping a file, execute this mental routing:

### Layer 1: Unit Identity (Local Node Artifacts)
* **What goes here:** Things exclusively true for this specific node.
* **Routing:** **DO NOT ASSUME FILE NAMES.** You MUST read \`.yggdrasil/config.yaml\` (the \`artifacts\` section) to see the exact allowed filenames for the current project and their requirement conditions (e.g., \`required: always\` vs \`when: has_incoming_relations\`). Write local node knowledge ONLY into these configured files next to \`node.yaml\`.
* **logic.md:** Algorithmic flow, control flow, branching logic, decision trees — the "how" of execution. Create when the node has non-trivial logic that cannot be inferred from interface alone. Extract from source; do not invent.
* **model.md:** Data structures, schemas, entities, type definitions — the shape of data this node owns. Create when the node manages non-trivial data structures. Extract from source types/interfaces; do not invent fields.

**Subagents:** When mapping a node (reverse engineering or graph-first), if the source code contains non-trivial logic (branching, control flow, algorithms, workflows), create \`logic.md\` for that node. Document: control flow, branching conditions, decision trees, sequencing. Follow Layer 1 routing. Do not invent — extract only what is implemented.

### Layer 2: Surroundings (Relations & Flows)
* **What goes here:** How this node interacts with others. You must not duplicate external interfaces locally.
* **Routing:**
  * If it calls another module: Add an outgoing structural \`relation\` in \`node.yaml\`. (The engine will automatically fetch the target's structural-context artifacts: responsibility, interface, constraints, errors).
  * If it participates in an end-to-end process: Do not explain the whole process locally. Ensure the node is listed in \`.yggdrasil/flows/<flow_name>/flow.yaml\`. The engine will attach the flow knowledge automatically.

### Layer 3: Domain Context (Hierarchy)
* **What goes here:** Business rules shared by a family of nodes.
* **Routing:** Do not repeat module-wide rules in every child node. Place the child node directory *inside* a parent Module Node directory. Write the shared rules in the parent's configured artifacts. The engine inherently passes parent context to children.

### Layer 4: Cross-Cutting Rules (Aspects)
* **What goes here:** Horizontal requirements like logging, auth, rate-limiting, or specific frameworks.
* **Routing:** Do NOT write generic rules like "This node must log all errors" in local artifacts. Instead, read \`config.yaml\` for available \`tags\`. Add the relevant tag (e.g., \`requires-audit\`) to \`node.yaml\`. The engine will automatically attach the aspect knowledge.

### Layer 5: Long-Term Memory (Knowledge Elements)
* **What goes here:** Global architectural decisions, design patterns, and systemic invariants.
* **Routing:** Read \`config.yaml\` (the \`knowledge_categories\` section) to know what categories exist.
  * If the file implements a standard pattern: Do not describe the pattern locally. Add a \`knowledge\` reference in \`node.yaml\` to the existing pattern.
  * If the file reveals an undocumented global invariant or decision: Ask the user to confirm it. If confirmed, create it under \`.yggdrasil/knowledge/<category>/\` so all future nodes inherit it.

**THE COMPLETENESS CHECK:**
Before finishing a mapping, ask yourself: *"If I delete the source file and give another agent ONLY the output of \`yg build-context\`, can they recreate it perfectly based on the configured artifacts, AND will they understand EXACTLY WHY this code exists and why it was designed this way?"* 
- If no -> You missed a local constraint, a relation, or you failed to capture the user's provided rationale.
- If yes, but the local files are bloated -> You failed to deconstruct knowledge into Tags, Aspects, Flows, and Hierarchy. Fix the routing.

---

## 8. CLI TOOLS REFERENCE (\`yg\`)

Always use these exact commands.

* \`yg owner --file <file_path>\` -> Find owning node.
* \`yg build-context --node <node_path>\` -> Assemble strict specification.
* \`yg tree [--root <node_path>] [--depth N]\` -> Print graph structure.
* \`yg deps --node <node_path> [--type structural|event|all]\` -> Show dependencies.
* \`yg impact --node <node_path> --simulate\` -> Simulate blast radius.
* \`yg status\` -> Graph health metrics.
* \`yg validate [--scope <node_path>|all]\` -> Compile/check graph. Run after EVERY graph edit.
* \`yg drift [--scope <node_path>|all]\` -> Check code vs graph baseline.
* \`yg drift-sync --node <node_path>\` -> Save current file hash as new baseline. Run ONLY after ensuring graph artifacts match the code.

*(Iterative mode only)*
* \`yg journal-read\`
* \`yg journal-add --note "<content>" [--target <node_path>]\`
* \`yg journal-archive\`
`;
