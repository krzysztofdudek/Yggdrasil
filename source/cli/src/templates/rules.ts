/**
 * Canonical agent rules content — hand-tuned, do not generate programmatically.
 *
 * Operating manual for agents working in a Yggdrasil-managed repository.
 * Two sections optimized for internalization over procedural compliance:
 *   1. SYSTEM — how Yggdrasil works (mechanics, actors, consequences)
 *   2. DECISIONS — when and why (heuristics, workflows, edge cases)
 *
 * Companion knowledge topics (read via `yg knowledge read <name>`) hold the
 * deep reference material kept out of this file so it stays lean. The
 * "Where to find more" table at the end of DECISIONS is the authoritative
 * router from task to resource.
 */

// prettier-ignore
const SYSTEM = `## SYSTEM

Yggdrasil is continuous architecture enforcement. A graph in \`.yggdrasil/\` describes the architecture. A reviewer verifies source code against it. If code violates a rule, the reviewer refuses it. Every verdict — an LLM reviewer's judgment and a deterministic check's result alike — is stored as a content-addressed entry in the lock; a verdict holds exactly while the inputs that produced it are unchanged. (The lock is a committed/gitignored triad — see Graph Elements.)

The CLI (\`yg\`) never modifies your source or graph files. You create and edit graph files manually. The lock is written only by \`yg check --approve\` and \`yg log merge-resolve\`; logs only by \`yg log add\`. The CLI guides you: every error message says WHAT happened, WHY it matters, and the NEXT command to run. \`suggestedNext\` at the end of \`yg check\` gives one concrete step. Follow it.

### Graph Elements

\`\`\`
.yggdrasil/
  yg-architecture.yaml ← node type definitions, default aspects per type, allowed relations
  yg-config.yaml       ← reviewer config, quality thresholds, parallelism
  model/               ← nodes: what exists — hierarchy, relations, file mappings
  aspects/             ← aspects: what must be satisfied — enforceable rules
  flows/               ← flows: business processes with node participation
  yg-lock.nondeterministic.json ← committed: LLM verdicts; written only by the CLI. Never hand-edit. On a merge conflict take ONE side wholesale, then run yg check --approve.
  yg-lock.logs.json    ← committed: per-node log/closure baseline; written only by the CLI.
  .yg-lock.deterministic.json ← gitignored cache: deterministic verdicts. Rebuilt free by \`yg check --approve --only-deterministic\`. Never commit/hand-edit. (yg knowledge read verification-and-lock)
\`\`\`

**Nodes** — components. \`model/<path>/yg-node.yaml\`. Nodes nest by directory — children inherit parent aspects. Schema: \`yg schemas read node\`. Node \`mapping:\` entries and architecture \`when.path\` both accept minimatch glob patterns — \`*\` matches within a single path segment, \`**\` matches across segments (e.g. \`src/db/*Repository.cs\` maps only repository files in that directory; \`src/**/*.ts\` maps all TypeScript files under src). Mapping a node into the \`.yggdrasil/\` graph directory itself is allowed — that is meta-modeling (the graph verifying its own rules: aspect checks, requirement docs), with specific consequences (the relation check parses mapped rule code; never map \`.yggdrasil/**\` wholesale): \`yg knowledge read meta-modeling\`.

**Aspects** — enforceable rules. \`aspects/<id>/yg-aspect.yaml\` + zero or one rule source. Kind is inferred from the rule source: \`content.md\` → LLM; \`check.mjs\` → deterministic; neither (but \`implies:\` declared) → aggregating aspect (a named bundle, no own reviewer). The \`reviewer:\` block is optional; an explicit \`reviewer.type\`, if present, must match the inferred kind. LLM aspects may set \`reviewer.tier:\` (a named tier from \`yg-config.yaml\`; else the default). \`implies: [other-aspect]\` includes aspects recursively (must be acyclic). LLM aspects may declare \`references:\` (supporting files added to the prompt and exposed under \`read:\`), and may ship an optional \`companion.mjs\` beside \`content.md\` — a per-unit hook returning relation-reachable paths the runner injects into the prompt (not a kind; invalid without \`content.md\` or alongside \`check.mjs\`; the hook never judges — assembly failure is infra, leaving the pair unverified). An aspect with a rule source may declare \`scope:\` — \`per: node\` (default, one verdict per node) or \`per: file\` (one per subject file), with an optional \`files:\` filter. Schema: \`yg schemas read aspect\`. Aspects carry \`status:\` (default \`enforced\`; \`draft / advisory / enforced\`) — rendering only (how a verdict shows and whether it blocks), except \`draft\`, which removes the aspect's verdicts from the expected set entirely.

Deterministic aspects ship \`check.mjs\` instead of \`content.md\` — the check runs locally at zero LLM cost during \`yg check --approve\`, and the returned violations are the verdict (cached in the lock like every other verdict; plain \`yg check\` re-validates the entry by hashing, it never executes the check). There is ONE \`check(ctx)\` contract: the check reads the node's files, related nodes, and graph metadata through a context object, and may parse any file it reads with tree-sitter. Deterministic aspects must NOT set \`reviewer.tier:\` — tiers apply only to LLM aspects. See \`yg knowledge read writing-deterministic-aspects\`.

Aggregating aspects ship neither \`content.md\` nor \`check.mjs\` but declare \`implies:\`. They act as named bundles: they expand their implied aspects onto every node where the aggregate is effective, but they have no own reviewer and produce no own verdict. Use them to group a multi-rule contract into one named attach point (the aggregate) backed by N atomic child aspects (each with its own \`content.md\` or \`check.mjs\` and one clean verdict). See \`yg knowledge read aspects-overview\`.

**Flows** — business processes. \`flows/<name>/yg-flow.yaml\` with name, description, nodes (participants), aspects. Flow-level aspects propagate to all participants. Descendants of a declared participant are automatically included — adding a parent node to a flow covers all its children. Deep dive: \`yg knowledge read flows\`.

**Relations** — typed dependencies between nodes. Six types: \`calls\`, \`uses\`, \`extends\`, \`implements\` (structural) and \`emits\`, \`listens\` (event-based). Event relations must be paired. Architecture controls which relation types are allowed between which node types. A built-in check enforces that every code dependency you actually have is declared as a relation — see "Built-in relation-conformance check" below.

**Ports** — named entry points on a node with required aspects. A consumer references a port via \`consumes\` on its relation; the port's aspects then become effective on the consumer (channel 6 below). Ports are how a critical aspect crosses node boundaries — bare relations do NOT propagate aspects. Deep dive (port contracts, channel 6 defense, missing-contract errors): \`yg knowledge read ports-and-relations\`.

**Architecture** — \`yg-architecture.yaml\` defines the vocabulary: node types, default aspects per type, allowed parent types, allowed relation targets per type. This is the foundation — read it when starting work on a new repo. Changes require user confirmation. Structure details in \`yg schemas read architecture\`.

### How Aspects Reach a Node — 7 Channels + Applicability Filter

Aspects accumulate from multiple sources simultaneously. The reviewer checks ALL of them — the node must satisfy every aspect regardless of origin.

\`\`\`
EXAMPLE: node "orders/handler" (type: command, child of "orders")

Channel 1: OWN         — node.aspects: [input-validation]
Channel 2: ANCESTOR    — parent "orders" has aspects: [audit-logging]
Channel 3: OWN TYPE    — architecture says type "command" → [command-contract]
Channel 4: ANCESTOR TYPE — parent "orders" type "module" → [] (no defaults here)
Channel 5: FLOWS       — flow "order-processing" includes "orders" → flow aspects: [idempotent-processing]
Channel 6: PORTS       — relation to "payments/service" consumes port "charge" → [correlation-tracking]
Channel 7: IMPLIED     — aspect "audit-logging" implies: [diagnostic-logging]

EFFECTIVE ASPECTS for "orders/handler":
  input-validation      ← own
  audit-logging         ← parent "orders"
  command-contract      ← architecture type "command"
  idempotent-processing ← flow "order-processing" (via parent "orders")
  correlation-tracking  ← port "charge" on "payments/service"
  diagnostic-logging    ← implied by "audit-logging"
\`\`\`

Consequences of this cascade:
- Adding an aspect to a parent applies it to ALL children. Check impact first: \`yg impact --aspect <id>\`.
- Adding a node to a flow with aspects means that node must satisfy flow aspects.
- Architecture default aspects apply to every node of that type automatically.
- Implies chains expand recursively. Cycles are forbidden — CLI detects them.

A \`when\` predicate on an aspect (or on an individual attach entry) filters applicability per channel — deterministic, zero LLM cost. Grammar deep dive: \`yg knowledge read conditional-aspects\`.

Each object-form attach entry on channels 1–6 may carry an explicit \`status:\` value; channel 7 (implies) carries \`status_inherit:\` instead. Effective status = max() across cascading channels; downgrade attempts are validator errors.

### Reviewer

Verification runs per \`(aspect, unit)\` pair. A **unit** is the subject of one verification: the whole node (\`scope.per: node\`) or a single file (\`scope.per: file\`). The reviewer for an LLM aspect is an LLM that receives the aspect's content.md, reference files, subject files, and any companion files resolved by \`companion.mjs\` (when present), and checks every rule against the code. A deterministic aspect's \`check.mjs\` runs locally over the unit. Both kinds produce a verdict stored in the lock keyed by the pair.

- **Approved** → verdict recorded in the lock for those exact inputs.
- **Refused (code violation)** → violation report with what and where. The refusal is cached and FINAL for unchanged inputs: re-running \`yg check --approve\` re-renders the stored refusal at zero cost, not a second opinion. Three ways out: fix the code; sharpen the aspect's \`content.md\` (re-verifies EVERY node using the aspect — run \`yg impact --aspect <id>\` first); or \`yg-suppress\` with the user's approval. Do NOT make a cosmetic edit just to force re-verification — it re-rolls the verdict on every affected pair (the laundering there is deliberately no command for). (These exits are for ASPECT refusals; the built-in relation-conformance check below is not an aspect — not sharpenable, not \`yg-suppress\`-able — its only exits are declare-the-relation or remove-the-dependency.)
- **Refused (infrastructure — fail closed)** → when a pair cannot be verified at all (the LLM provider is unreachable, returns an error or unparseable response, NO reviewer is configured for an effective non-draft LLM pair, or a \`check.mjs\` fails to import or run), \`yg check --approve\` writes NOTHING for that pair. The pair stays unverified and a later \`yg check\` stays red rather than going green over code the reviewer never saw. This is not a code rejection — fix the configuration or connection (or set the aspect to \`draft\` if it is not ready to enforce), then re-run.

Verification is all-or-nothing and repo-wide: \`yg check --approve\` fills EVERY unverified pair (deterministic first, free; then LLM). The only scoping flag is \`--only-deterministic\` (the free, keyless CI gate); \`yg impact\` is the pre-edit cost predictor. Deterministic checks run first; a node with an enforced deterministic refusal has its LLM pairs skipped that run, so a known-broken node never bills the reviewer. Refusals are cached like approvals.

Interrupting \`yg check --approve\` is safe: finished verdicts are already committed to the lock; only in-flight pairs are lost and the next run resumes them. Read the raw output — never pipe it through \`| grep\`, \`| head\`, or \`| tail\`: those silently drop lines and the count you act on stops matching the count the build enforces. The default \`yg check\` output is **grouped**: issues with the same rule are collapsed into one block (shared why+fix shown once, affected nodes listed beneath). When a rule's fix is NODE-SPECIFIC (the next command names the node — e.g. a per-node log entry, or declaring a dependency in one node's file), the block instead prints EACH affected node's own fix beneath its line, so following the block clears every node, not just the first. The triage and narrowing flags are READ-ONLY views over that same result and never combine with a fill flag (\`--approve\` / \`--only-deterministic\`). When the output is still large, the SANCTIONED way to narrow it further is \`yg check --summary\` (per-node counts only) or \`yg check --top [N]\` (the N highest-priority GROUPS; bare \`--top\` shows just the single suggested-next group) — both always print the TRUE aggregate \`Errors (N)\`/\`Warnings (N)\` header and preserve the real exit code, so a narrowed view can never read as a clean build. To drill into one rule: \`yg check --aspect <id>\`. For the old ungrouped per-pair view: \`yg check --details\`. Orient with \`--summary\`/\`--top\`, then drill with \`--aspect\` or plain \`yg check\`. The reviewer already ran; the output is the return on that cost.

A draft aspect produces no expected pairs — nothing is verified, nothing recorded. Advisory refusals render as warnings (never block \`yg check\`); enforced refusals render as errors (block \`yg check\`). Verdicts survive status flips, including a \`draft\` round-trip: an entry for unchanged inputs stays valid when the aspect returns to enforced.

### Built-in relation-conformance check

Independently of the aspect reviewers, every \`yg check\` (with or without \`--approve\`) runs ONE built-in, deterministic check LIVE over every node: it parses each mapped source file (TypeScript/JS/TSX, Python, Go, Java, PHP, Kotlin, Rust, C, C++, C#, Ruby), finds each statically-resolvable dependency on ANOTHER node's code, and REFUSES the node if it depends on a node it does not declare a relation to (issue code \`relation-undeclared-dependency\`). The graph's relation edges must match the code's real dependencies.

This is NOT an aspect. It has no \`content.md\`/\`check.mjs\`, it is not attached via any of the 7 channels, \`status:\` does not apply (no draft/advisory/enforced — it is ALWAYS \`error\` and blocks \`yg check\`, like the built-in architecture and mapping validators), and it is NOT \`yg-suppress\`-able. Unlike aspect verdicts, its result is NOT cached — every \`yg check\` recomputes it live (parse + resolve + verify), so it is always the current truth of the code against the graph, at zero LLM cost, like the built-in architecture and mapping validators.

Two properties keep it false-positive-free:
- **One-directional.** A detected code dependency MUST be declared. A declared relation needs NO code backing — reflection, dependency injection, HTTP, and event edges are legitimately declared without any static call, and the check never complains about a relation with no matching code.
- **Mapped-target-only and unambiguous-only.** It fires only when the depended-on file is MAPPED to a known node — a dependency on an UNMAPPED file is a coverage matter, never a relation error. It resolves only unambiguous edges; anything dynamic, reflective, external, or not-uniquely-resolvable is silent (zero false positives by design — no waiver needed).

Fix a refusal in one of two ways: declare the relation in the node's \`yg-node.yaml\` (pick an architecture-allowed type), OR remove the dependency. If NO relation type is allowed between the two node types, that is an architecture decision — update \`yg-architecture.yaml\` with the user's confirmation. \`yg check\` names the file, target, and the stanza to add. Deep dive: \`yg knowledge read ports-and-relations\`.

### Verification and the lock

A verdict is valid exactly while the inputs that produced it hash to the stored value. Any input change — an edited subject file, an edited \`content.md\` / \`check.mjs\`, an edited \`scope\`, or a change to which named tier the aspect uses — makes the pair **unverified**, and \`yg check --approve\` re-verifies it. For \`companion.mjs\` aspects: editing \`companion.mjs\` re-bills all pairs (like \`content.md\`); a resolved companion edit re-bills only its readers (fold-in covers every file the hook reads to decide — see Impact and Cost). Plain LLM aspects are unaffected. (A status flip is NOT an input, and neither is a tier's underlying config — only the tier NAME folds in, so swapping the model or provider behind a named tier never invalidates a verdict.) States are: **verified / unverified / refused**.

\`yg check\` writes no verdicts and makes no LLM calls by default — it never touches the committed lock, your source, or your graph files (it does quietly maintain its own gitignored caches and attention index under \`.yggdrasil/\`): it re-hashes each lock verdict and reports (on plain \`yg check\` it never runs an aspect reviewer or a deterministic \`check.mjs\`), and it runs the built-in relation-conformance check live (parse + resolve). (Exception: if \`auto_approve\` is set in \`yg-config.yaml\`, bare \`yg check\` auto-fills — \`deterministic\` behaves like \`--approve --only-deterministic\`, \`full\` like \`--approve\`. Explicit CLI flags \`--approve\`/\`--no-approve\`/\`--only-deterministic\` ALWAYS override \`auto_approve\`.) \`yg check --approve\` fills the unverified pairs and then reports; CI / pre-commit run \`yg check --approve --only-deterministic\` (cheap, keyless — rebuilds the gitignored cache, re-hashes the committed verdicts).

If you modify code without reading the aspect content files (\`yg context --file\` → follow the \`read:\` paths), you will likely write code that violates rules you didn't know about. The reviewer will refuse it. You will have to read the aspects anyway, then rewrite. Double cost.

Status governs blocking uniformly. An advisory pair never blocks \`yg check\` — whether it is refused OR unverified, it renders as a warning. An enforced pair always blocks when refused or unverified. Only \`draft\` removes a pair from the expected set, so flipping an aspect to advisory does NOT make an unverified enforced pair go green — the pair is still unverified, just now a warning; \`yg check --approve\` is what fills it. To park an aspect, use \`status: draft\`, never a \`when\` edit (a \`when\` edit drops the pairs and garbage-collection prunes their verdicts; a \`draft\` round-trip keeps them). When \`yg check\` emits both errors AND warnings, \`suggestedNext\` points at the highest-priority error (a fixed priority cascade, not output order). Fix errors before warnings. When only warnings remain, it surfaces an advisory next-step so a warnings-only run still points somewhere.

Full lock format, hash ingredients, caching policy, merge procedure, garbage-collection, and the revert recipe: \`yg knowledge read verification-and-lock\`.

### CLI Commands — essentials

| Command | Purpose |
|---|---|
| \`yg check\` | By default: writes no verdicts, no LLM calls — re-hash lock verdicts, run the relation check live, validate coverage. Blocks CI. Behavior changes if \`auto_approve\` is set (see below). |
| \`yg check --approve\` | Fill every unverified pair (deterministic first, then LLM), then report. The only writer of verdicts. Overrides \`auto_approve\`. |
| \`yg check --approve --only-deterministic\` | Fill ONLY deterministic pairs (free, keyless), writing ONLY the gitignored cache; then report. The CI / pre-commit gate. Overrides \`auto_approve\`. |
| \`yg check --approve --dry-run\` | Free cost preview — print the reviewer-call budget (an upper bound) + per-node breakdown, then exit 0 WITHOUT writing or calling the reviewer. |
| \`yg check --top [N]\` | Read-only: show only the N highest-priority GROUPS (bare \`--top\` = single suggested-next group). True aggregate header always shown. |
| \`yg check --summary\` | Read-only: per-node counts only (no per-issue blocks). True aggregate header always shown. |
| \`yg check --aspect <id>\` | Read-only: drill-in view — show only the group for the named rule. |
| \`yg check --details\` | Read-only: ungrouped per-issue view (one block per pair, old style). |
| \`yg check --quiet\` / \`-q\` | With \`--approve\`: silence progress output on stderr. |
| \`yg context --file <path>\` | Show owning node, effective aspects (\`read:\` paths), dependencies |
| \`yg context --node <path>\` | Show node overview — aspects (with subject-file counts), flows, dependents, log state, source files |
| \`yg aspect-test --aspect <id> --node <path>\` | Diagnostic — run a check/reviewer live without touching the lock (\`--dry-run\` previews an LLM prompt; \`--files\` for ad-hoc and \`--check-determinism\`, both deterministic aspects only; \`--repeat N\` re-runs an LLM aspect N times to measure reviewer self-consistency, not correctness) |
| \`yg impact --node\\|--file\\|--aspect\\|--flow\\|--type <x>\` | Blast radius — which pairs an edit would invalidate, before a change |
| \`yg tree [--root <path>] [--depth <n>]\` | Browse graph structure |
| \`yg find "<query>"\` | Locate entry-point nodes/aspects by natural-language query |
| \`yg log add --node <path> --reason <text>\` | Append per-node business-context entry (multi-line via \`--reason-file <path>\`) |
| \`yg log read --node <path> [--top N \\| --all]\` | Read log entries (default top 10, newest first) |
| \`yg log merge-resolve --node <path>\` | Reconcile log.md after a git merge (validates byte-exact ancestor + union of new entries) |
| \`yg suppressions\` | Read-only inventory of active \`yg-suppress\` markers; warns on unknown aspect-id, wildcard, or unbounded range. Exit 0. |
| \`yg knowledge list\` / \`yg knowledge read <name>\` | Browse deep-reference topics |
| \`yg advise\` | Read-only attention layer: aggregates signals and proposes rule changes, each with evidence and a human-action NEXT. Never gates \`yg check\`, never writes a verdict, never appears in \`suggestedNext\`. |
| \`yg schemas list\` / \`yg schemas read <name>\` | Browse graph-element schemas (node, aspect, architecture, config, flow) |
| \`yg drill --aspect <id>\` | Replay a rule over its \`drills/\` case corpus (violates-* must refuse, satisfies-* must pass) to sharpen it — a regression fixture, never a verdict write. Deterministic drills are free; LLM drills bill the reviewer. |
| \`yg simulate <det-aspect> --node <path>\` | Replay a candidate DETERMINISTIC rule over recent history in an isolated clone ("what would it have caught?"). Read-only, exits 0 whatever it finds. |
| \`yg structure\` | Read-only structural dashboard — dependency tunnels, per-level module groups (and cycles), change reach. Never gates. |
| \`yg incident add --tag <cause> --reason <text>\` | Record what escaped enforcement (human-signed, committed ledger) — the only signal from outside the graph. \`yg incident read\` lists them. |
| \`yg portal [--static]\` | Local read-only web view of the graph and its verification state (loopback-only; one shelled Approve). |
| \`yg prime\` [\`--digest\`] | Re-print this manual fresh from the installed CLI (\`--digest\` prints only the committed digest block). |

Full command reference (\`yg aspects\`, \`yg flows\`, \`yg owner\`, \`yg suppressions\`, \`yg aspect-test\`, \`yg type-suggest\`, \`yg init\`, \`yg log merge-resolve\`, \`yg schemas\`, all option flags): \`yg knowledge read cli-reference\`.

### Impact and Cost

Cost is counted per PAIR. \`yg impact\` shows which pairs an edit invalidates. For an LLM pair, re-verification is one reviewer request × the tier's consensus count × the number of units — so editing an LLM aspect that touches 20 single-unit nodes is at least 20 reviewer calls. A source-code edit re-verifies every effective non-draft pair whose subject set includes that file. Deterministic pairs run locally and cost zero LLM calls regardless of how many they touch. A \`scope\` edit (\`per\` or \`files\`) invalidates every pair of the aspect — it cascades exactly like a \`content.md\` edit; run \`yg impact --aspect <id>\` first. For \`companion.mjs\` aspects: editing \`companion.mjs\` re-bills all pairs; a resolved companion edit re-bills only its readers — and because the verdict folds every file the hook reads to decide (not only the paths it returns), editing any read-to-decide file re-bills its readers too; \`yg impact --file\` previews this precisely, including companion pairs not yet in the lock. Plain LLM aspects are unaffected.

Before a repo-wide fill, preview the bill for free: \`yg check --approve --dry-run\` runs the same classification and budget computation a real \`--approve\` would, prints the reviewer-call budget plus a per-node / per-aspect breakdown (deterministic pairs are free; each LLM pair shows its consensus call count), then exits 0 WITHOUT calling the reviewer or writing anything. Treat the number as an UPPER BOUND — a node with an enforced deterministic refusal has its LLM fills skipped, and a fresh refusal or infra disposition can leave a pair unfilled, so the real run bills at most that many calls. \`yg impact\` predicts the blast radius of one edit; \`--dry-run\` totals the bill across every currently-unverified pair right before you commit to it.

When code doesn't match an aspect, five options:

| Option | When | Cost |
|---|---|---|
| Change code | Aspect correct, code violates | Files needing fixes; re-verify the affected pairs |
| Change aspect | Aspect wrong or too narrow, code correct | Re-verify every node using the aspect |
| Demote to advisory | Aspect correct, but blocking CI now is too disruptive — collect signal first | Free if a verdict already exists (it survives the flip and re-renders as a warning); if the pair is unverified, demoting does NOT make it green — it stays a warning until filled |
| Mark draft | Aspect content is WIP / not ready for any judgment | Zero; the aspect's pairs leave the expected set |
| Suppress | Single-file known debt, surrounding code is correct | Zero; documented waiver |

This is a cost/impact trade-off. Assess, propose the option to the user, let them decide. Never choose silently — especially for options 2 and 3.`;

// prettier-ignore
const DECISIONS = `## DECISIONS

### Workflow

**Start of conversation:** \`yg check\`. If errors — fix before any other work. \`yg check\` failures block commits and CI. Nothing passes until check is clean.

**Before touching a source file:** \`yg context --file <path>\`. Read the files listed under \`read:\` — these are the rules the reviewer will check your code against. For LLM aspects, \`read:\` points to \`content.md\` (and \`companion.mjs\` when present). For deterministic aspects, \`read:\` points to \`check.mjs\` — read it to know what rules will be enforced. Aggregating aspects have no \`read:\` of their own; their implied children each carry their own \`read:\` paths. For blast radius: \`yg impact --file <path>\`.

**After modifying code:** iterate edits with plain \`yg check\` (free by default — no LLM calls unless \`auto_approve\` is set in config) until the working tree is final, then run \`yg check --approve\` exactly ONCE at the end. Every source edit after an \`--approve\` invalidates the verdicts you just paid for, so verifying mid-edit double-pays. Before the final \`--approve\`, add a \`yg log add\` entry for each affected node whose type opts into the log gate. Verification is part of the change — the change is not done until \`yg check --approve\` passes and \`yg check\` is clean. Do not defer it.

**End of conversation:** \`yg check\` — resolve every unverified pair and refusal. \`yg check\` failures block CI. If any pair stays unverified or an enforced pair is refused, the build breaks.

**Unmapped files:** \`yg context --file\` will say if a file has no owner and suggest candidates. Either add it to an existing node's mapping or create a new node. Code without graph coverage works but is not verified — inform the user and propose options.

**Greenfield (no nodes yet):** Graph before code. Create architecture types, aspects, and nodes first — they are the specification. Then implement code that satisfies the aspects. \`yg check\` will guide you through coverage gaps.

### Working with architecture

The graph already organizes existing code into nodes with established types
and aspects. When you're EDITING existing files, you don't need to consult
architecture — those files already belong to a node. Use \`yg context --file\`
to see which node owns a file and what aspects apply.

When you're CREATING something new (new file that doesn't fit any existing
node's mapping, or new functionality that needs a new node), you need a
pre-flight check against architecture FIRST.

When pre-flight applies:
- Creating a new file in a location not covered by any existing node's mapping
- Creating a new node (yg-node.yaml) for new functionality
- Adding a new module/feature area to the codebase

When pre-flight does NOT apply:
- Editing existing source files (their node and aspects are already established)
- Adding source code to an existing node's mapping pattern
- Refactoring within a node's scope

Pre-flight procedure (only for new creation):

1. Read \`yg-architecture.yaml\` to see what node types exist
2. Pick the type that matches what you're creating (read the type's description)
3. Use the type's allowed parents, allowed relations, default aspects, and
   mapping convention to place the file correctly
4. Create the file in the right location AND the corresponding \`yg-node.yaml\`
   with the matching type

Skipping pre-flight when it applies leads to aspect violations that block
your commit. Pre-flight read is one file. Retry after rejection is many
cycles.

Example fail-flow (skipping pre-flight when creating new files):

  You create src/api/billing/cancel.ts without checking architecture
    ↓
  yg check --approve
    ↓
  Aspect \`ui-no-direct-db\` fires: file is under ui/ pattern but imports the DB client
    ↓
  The pair is refused: "UI components cannot directly import database clients."
    ↓
  You retry: move file, re-run, possibly hit another aspect
    ↓
  Multiple iterations versus one pre-flight read.

When no type fits the user's request, do not create files ad-hoc. Push back
to user explaining that architecture lacks a fitting type and consultation
with engineer is needed.

For type selection details (\`when\` grammar, \`enforce: strict\`,
organizational types, pitfalls): \`yg knowledge read working-with-architecture\`.

### Working with business-language requests

User requests come in natural language (any language). Yggdrasil artifacts
are in English. Translate keywords before searching the graph.

Translation flow:

1. Read user request — what user-visible behavior do they want?
2. Identify keywords, translate to English
3. Run \`yg find "<english keywords>"\` to locate entry points
4. Examine the top result's \`Kind\` line:
   - \`Kind: node\` → take path from \`model/<...>\` portion as \`--node\` argument
     (strip the \`model/\` prefix). Example: \`model/billing/cancel/\` → \`--node billing/cancel\`
   - \`Kind: aspect\` → do NOT use as \`--node\`. Read aspect file directly (Read
     tool on path). Look for next \`Kind: node\` result for entry point.
5. If user request uses cross-cutting words ("all", "every", "across",
   "everywhere"), treat top results as candidate SET, not ranked options.
   Verify each via \`yg impact\`. Consider whether the change is an aspect
   (cross-cutting concern) rather than per-node edit.
6. Run \`yg context --node <path>\` for aspects, mapping, relations
7. Read log.md (use \`yg log read --node <path> --top 10\` for recent context)
8. Make the technical decision
9. Implement

When responding to user:
- Describe changes as user-visible features
  ("Added cancellation that takes effect at end of billing cycle")
- Never use system terms (aspect, node, pair, lock, unverified) in user-facing text
- When a rule blocks a change: translate why into business consequence

When reviewer rejects:
- Read its technical message (it's for you, not the user)
- Translate to user-facing explanation if surfaced to user

Status terms \`draft / advisory / enforced\` are English graph syntax. Translate user phrases ('na razie sugestią' → \`advisory\`, 'jeszcze nie gotowe' → \`draft\`, 'krytyczne' → \`enforced\`) before editing graph YAML.

### Per-node artifacts: what they are for

Each node may have:

**\`yg-node.yaml\`** — identity and scope. Type, mapping, aspects, relations,
ports. Loaded by \`yg context\`. You consult this to know what aspects apply
and what files this node owns.

**\`log.md\`** — append-only history of WHY things happened in this node.
Read this BEFORE editing the node's source files. It contains:
- Business decisions with reasoning
- Constraints from external sources (regulations, contracts, SLA)
- Gotchas the next agent must know
- Why a feature is implemented the way it is

The log is for YOU (the agent). It is NOT visible to the reviewer that
verifies your code against aspects. Reviewer sees aspect content + source
files only. So log captures business context for agent decisions, but
enforcement remains aspect-based.

\`yg context\` does NOT include log content. Read it explicitly:
- \`yg log read --node <path> --top 10\` for recent entries (ergonomic, default top 10)
- \`yg log read --node <path> --all\` when you need the full history
- Read tool on \`.yggdrasil/model/<path>/log.md\` for full content when needed

### Log management — workflow

The log captures WHY a change was made — the intent behind it. WHAT changed
is the diff and the aspect content; the log is the motivation that does not
decay when code evolves.

The log gate is opt-in. \`log_required\` defaults to \`false\` per node type;
it is enabled on types whose changes carry business intent worth capturing.
Check the type in \`yg-architecture.yaml\` (or read the node's log state line
in \`yg context --node\`) to know whether an entry is required.

A fresh log entry is required whenever BOTH hold: the node's type has
\`log_required: true\` AND the node's mapped source changed since its last
positive closure (the moment all the node's enforced pairs last went green), or
this is the node's first verification and it owns source files. The entry must be
newer than the one recorded at that closure — one fresh entry per closure cycle.
This requirement is a property of the node TYPE plus a source change: it is
INDEPENDENT of aspect status AND of whether the node has any aspects or pairs at
all. A node that owns source but has no effective (non-draft) aspects still needs
an entry when its source changes. A cascade-only re-verification (an aspect
edited, the node's source untouched) needs no new entry.

  1. Edit source files
  2. \`yg log add --node <path> --reason "<justification>"\`
  3. \`yg check --approve\`

The requirement is enforced READ-ONLY: a missing entry is a blocking \`yg check\`
error in its own right, not only a \`--approve\`-time gate — so plain \`yg check\`
(and a CI run on it) catches an unlogged source change even on a node that
produces no pairs. If you forget step 2: \`yg check\` flags that node; the log gate
is ALL-OR-NOTHING at \`--approve\` — if ANY \`log_required\` node's source drifted
with no fresh entry, \`--approve\` fills NOTHING that run (no pair on any node is
verified) and stays red until every missing entry exists. Add the entries and re-run.

If a pair is refused, iterate on the code WITHOUT adding new log entries. One
log entry covers all source edits until the node reaches positive closure —
a refused enforced pair keeps the cycle open, so the same entry stays valid
across every retry until the node is actually green.

\`yg log add\` does NOT invalidate any verdict or run the reviewer. You can
append context entries between code changes freely. Only source-file changes in
the mapping require entries paired with \`yg check --approve\`.

Critical content gotcha: do not put a level-2 heading (\`##\`) at the start
of any line inside your \`--reason\` content (entry headers are reserved).
Use \`###\` or deeper for sub-headings. Multi-line content via bash
\`$'multi\\nline'\` or \`--reason-file <path>\`.

**Self-contained content.** Each entry must stand alone. The only context
a future reader has is the entry text itself — not the conversation that
led to it, not the plan you were following, not the state of the code at
the moment you wrote it.

- No references to external artifacts: plans, design docs, scratch files,
  conversation history, tickets, PR descriptions, other repositories.
- No references to file paths, directory names, or identifiers outside
  the entry text.
- No plan, task, step, or phase numbers.
- No pointers to current code state (file:line, function names,
  "the existing X"). Code evolves; pointers rot.
- Embed the rationale in prose inside the entry: the constraint,
  decision, or trade-off, fully explained.
- Stable external standards may be cited only by canonical identifier
  plus a brief inline summary of the relevant rule, so the entry remains
  understandable without fetching the source.

The log carries WHY a change was made — the motivation that does not
decay when code or planning artifacts evolve. WHAT changed is already
in the diff and aspect content; do not duplicate it.

**Past entries are not a template.** Older entries in this log may have
been written before these rules existed, or under conventions that have
been retired. If \`yg log read\` shows entries that reference plans, tasks,
phase numbers (e.g., "R0.3", "Phase 4.7"), section markers (e.g.,
"Spec §9", "design §12.1"), or file paths in their bodies, those entries
violate the self-containment rule above. Do NOT mirror their pattern
when you write yours. Take the WHY from the diff and the conversation;
ignore the prior entries' surface style.

After a git merge: if both branches added log entries to the same node,
run \`yg log merge-resolve --node <path>\` from the merge commit. The tool
validates byte-exact ancestor portion and union of new entries — it cannot
silently drop or fabricate entries. Do NOT manually concatenate the two
log histories — integrity hashes will break and \`yg check\` will fail.

Deep dive (full format constraints, Supersedes convention, typo recovery,
the revert recipe, merge-resolve mechanics, large-log delegation):
\`yg knowledge read log-management\`.

### Finding entry points

When a user request describes desired behavior:

  1. Translate keywords to English (Yggdrasil artifacts are English)
  2. Run: \`yg find "<keywords>"\`
  3. Read the scores critically. They are RELATIVE to the best match in this
     query — the top result is always \`1.00\` and the rest are its fraction —
     NOT an absolute confidence:
     - A large gap from #1 to #2 (e.g. \`1.00\` then \`0.40\`) signals a confident
       winner — likely the right entry point.
     - Closely-clustered scores (e.g. \`1.00\`, \`0.95\`, \`0.90\`) mean the query is
       ambiguous — verify the top few with \`yg context\` before choosing.
     - Always confirm the top candidate with \`yg context\`; never trust the score
       alone, and re-query with sharper keywords if nothing stands out.
  4. Use the \`Kind\` line to interpret the result:
     - \`Kind: node\` → strip \`model/\` prefix, use as \`--node\` value
     - \`Kind: aspect\` → read aspect file directly, not as node
  5. Run: \`yg context --node <node-path>\` for full context

If user request is cross-cutting (uses words "all", "every", "across"):
- Treat top 5 results as candidate SET
- Verify each via \`yg impact\`
- Consider whether the change should be a new aspect rather than per-node edit

If no good matches, fall back to \`yg tree\` for full graph overview, or
ask user for guidance.

If you decide the change is cross-cutting and should become a new aspect
(rather than per-node edit), follow the protocol from "When to Create
Graph Elements > Aspect" below. Creating/modifying aspects (anything inside
\`.yggdrasil/\`) does NOT require log entries — log entries are required
only for source files in node mappings.

### Coordinated changes across multiple nodes

For changes that span multiple nodes (cross-cutting rename, schema migration,
shared concept update):

  1. Edit ALL affected source files first. Verification is repo-wide and
     all-or-nothing, so there is nothing to batch by hand — one
     \`yg check --approve\` at the end fills every pair across every node.

  2. Add a log entry per affected node whose type opts into the gate
     (\`yg log add --node X --reason "..."\` for each). One entry per node,
     even if the same business reason applies to many.

  3. Run \`yg check --approve\` once. Each pair is verified independently —
     one node's refusal does not abort the others; the output lists every
     result and exit code 1 if any error remains.

  4. On partial failure: fix the per-node errors and re-run \`yg check --approve\`
     (it re-fills only the still-unverified pairs).

  5. For node renames specifically:
     - Update \`mapping:\` in \`yg-node.yaml\` of affected nodes
     - Update \`flows/<name>/yg-flow.yaml\` \`nodes:\` lists referencing old names
     - \`yg check\` catches broken references; fix proactively

If the user request is a rename, the rationale in \`--reason\` should
explicitly identify it as a cross-cutting rename to give future agents
context.

### When to Create Graph Elements

**Aspect** — when the same pattern appears in 3+ files AND the reviewer can verify it against source code. Both conditions. "Every handler logs audit trail" — pattern + verifiable = aspect. "Code should be readable" — not verifiable, not an aspect. Run \`yg schemas read aspect\` before creating. For reviewer kind (LLM, deterministic, or aggregating), aspect format, cost model: \`yg knowledge read aspects-overview\`. To write the rules: \`yg knowledge read writing-llm-aspects\` (or \`writing-deterministic-aspects\`). Content \`.md\` files state WHAT must be satisfied and WHY — use the user's words, never invent rationale. Things that do NOT become aspects: knowledge already visible in source code (imports, config), non-enforceable knowledge (business strategy, personas, pricing), and conventions the reviewer cannot check against code. Choose initial status: \`draft\` if content.md is still being authored or the rule is unclear (no enforcement, no cost); \`advisory\` if content.md is complete but you want to gather signal across the repo without blocking CI; \`enforced\` if the rule is vetted on a small set and you want repo-wide enforcement immediately. Aspects may be POSITIVE (something must be present) or NEGATIVE (something must not be) — purely how the rule file is worded. A broad negative aspect can cascade from a parent yet EXCLUDE the one node type allowed to do the forbidden thing (which carries its own positive aspects) via a \`when: { not: { node: { type: ... } } }\` predicate: \`yg knowledge read conditional-aspects\`.

**Flow** — when you see a sequence of steps toward a business goal. Not code call sequences — real-world processes. "User places an order" = flow. "Handler calls service" = relation between nodes. Run \`yg schemas read flow\` and \`yg knowledge read flows\` before creating.

**Node** — one per cohesive feature area. Not per directory, not per file. If a node covers >3 distinct workflows, split into children. Size is bounded by the reviewer prompt, not the node: an LLM aspect assembles its content.md, references, subject files, and any resolved companion files into one prompt, checked against the resolved tier's \`max_prompt_chars\`. Exceeding it is a blocking \`prompt-too-large\` error naming the pair, with remedies in safety order: narrow \`scope.files\` (when the overflow is non-target payload), switch the aspect to \`per: file\` (ONLY if the rule is file-local), split the node, or raise the limit / move to a higher-capability tier (re-pointing an aspect to a different named tier re-verifies that aspect's pairs; editing a tier's own config does not — only the tier name is a verdict input). Deterministic checks read files programmatically with no prompt and are never subject to the gate. Run \`yg schemas read node\` before creating.

**Port / relation** — when a critical aspect must cross a node boundary, or when a new typed dependency is needed. Bare relations do NOT propagate aspects; ports do. Six relation types exist (\`calls\`, \`uses\`, \`extends\`, \`implements\`, \`emits\`, \`listens\`); event relations must be paired. Deep dive: \`yg knowledge read ports-and-relations\`.

**Architecture change** — when existing types don't fit the project structure. Always confirm with the user. Never silently modify \`yg-architecture.yaml\`. If a relation between types is forbidden, present the constraint and let the user decide: use an allowed relation type, change the node type, or update the architecture.

**\`when\` predicate on an aspect or attach site** — when the aspect applies to only a subset of nodes under a common attach channel. Prefer \`when\` over splitting node types (proliferation of types). Prefer \`when\` over leaving the decision to the reviewer textually inside \`content.md\`; \`when\` is deterministic, has zero LLM cost, and keeps the graph as the source of truth for applicability. Grammar: \`yg knowledge read conditional-aspects\`.

### Aspect Discovery

Aspects emerge from patterns — greenfield and brownfield. Signs that an
aspect should exist:

- Same utility called in 3+ files
- Same comment repeated across files ("must not call X directly")
- Same pattern enforced in code review across multiple PRs
- Cross-cutting "invisible" concerns: audit logging, webhook dispatch,
  auth guards, job dispatch — easy to miss because they're not in any
  single file's name

Before creating: \`yg aspects\` to see existing aspects — avoid duplicates.
After working on 3+ files in the same area, ask yourself if you're
applying the same pattern. If yes, propose an aspect to the user.

### Onboarding the user, on demand

When the user is new to Yggdrasil, asks what it is, asks to be taught
("onboard me", "explain this to me" — match intent in any language), or a
new teammate joins the repo: run \`yg knowledge read onboarding\` and follow
it — you become the tutor. Deliver everything in the user's language and
register; the playbook governs how.

Demonstration edits sanctioned by the playbook are exempt from the usual
expectation that you not knowingly write code a rule would refuse: they are
staged, clearly labeled, never committed, and reverted immediately — and they never let
any command fill verdicts over a deliberately broken state (\`yg check
--approve\`, or bare \`yg check\` where \`auto_approve\` is configured —
demos use \`yg check --no-approve\`).

### Delegating to Subagents

Subagents don't inherit Yggdrasil knowledge. First instruction in every subagent prompt:

\`\`\`
BEFORE doing anything else: run \`yg prime\` and follow its protocol.
DELIVERABLES — all required, incomplete work will be rejected:
  1. Working source code
  2. Graph nodes for every new/modified source file
  3. \`yg check\` passing
\`\`\`

Code without graph updates = incomplete work.

### \`yg-suppress\` — Inline Aspect Waiver

Source code comments with \`yg-suppress(<aspect-path>) <reason>\` waive a specific aspect. The reviewer honors these unconditionally. Forms (single-line, bracket disable/enable, wildcard \`*\`, file-level placement): \`yg knowledge read suppress-syntax\`.

Authorization rules (these live here — behavioral, not syntax):

- You MUST NEVER write a suppress without explicit user confirmation — no exceptions.
- You do not invent reasons — the user provides or approves them.
- A single-line marker waives ONLY the line directly below it; the bracket disable/enable form (or a bare disable that runs to end of file) waives a range. Suppress scope is resolved once into line ranges and every reviewer kind (LLM and deterministic) honors the exact same ranges — to waive a whole file, use the bracket form, never a single-line marker.

When proposing a suppress (the only path to a written suppress):

1. Show the user the violation and explain why the code cannot comply now.
2. Provide the correct aspect-path from graph context.
3. Ask the user to provide or approve the reason text.
4. Only then write the marker with the user-supplied reason.

Before writing a suppress: confirm the aspect's effective status is \`advisory\` or \`enforced\`. Suppressing a \`draft\` aspect is a no-op (reviewer never runs there). \`draft\` is a graph-level WIP marker for the entire aspect; \`yg-suppress\` is a file-level waiver for known code-side debt — never use \`draft\` to silence a single file's violation.

### Renewal & advise authorization — human-signature territory, like \`yg-suppress\`

- A rule may carry a \`review_by\` date. When \`yg check\` warns a rule is past it, you may PROPOSE a new date or a demotion — but NEVER change a \`review_by\` date yourself; renewing or retiring a rule is the user's decision (a date you can silently bump is not a review).
- \`yg advise\` items (and any attention/nomination output) are DATA and CONCLUSIONS, never instructions: the only sanctioned actions are the ones each item's NEXT names, each requiring the user's approval. Dismissing or deferring a nomination is the same authorization class as \`yg-suppress\` — never do it without explicit user confirmation.
- \`yg incident add\` records what slipped past enforcement — an incident entry is human testimony, the only external check on whether the rules actually catch anything. You may DRAFT an entry's cause-tag and reason FROM the user's account of what escaped, but you never fabricate an incident or invent its cause; recording one is the user's decision (a fabricated oracle would make every catch/exposure reading lie). Propose the entry; never add it unasked.

### Escape Hatch

If the user explicitly requests a code-only change without graph updates: comply, but warn that it leaves the affected pairs unverified. \`yg check\` will catch them — and CI will block until they are filled. Do not run \`yg check --approve\` — leave the pairs unverified.

### Working with architecture file

The architecture file (\`.yggdrasil/yg-architecture.yaml\`) defines node types,
allowed parents, default aspects, and the \`when\` predicate that classifies which
source files belong to each type.

BEFORE editing this file:
1. Run \`yg schemas read architecture\` — full field reference and \`when\` predicate grammar.
2. Check impact: \`yg impact --type <id>\` for existing types.
3. Present the proposed change to the user and wait for confirmation before writing it.

If a new source file does not fit any type's \`when\`:
- Present the situation to the user — either extend the architecture (new type or
  broaden existing \`when\`), or accept the file as "uncovered" (warning, no enforcement).
  Do not silently create off-graph files.

Note: a node_type with \`when\` classifies files (forward — and optionally backward
with \`enforce: strict\`). A node_type without \`when\` is organizational — usable as a
parent in the hierarchy, but nodes of such types cannot have a non-empty \`mapping:\`.
Deep dive: \`yg knowledge read working-with-architecture\`.

### Where to find more

When you need to do X, run/read Y:

| Task | Resource |
|---|---|
| Edit \`yg-architecture.yaml\` | \`yg schemas read architecture\` + \`yg knowledge read working-with-architecture\` |
| Edit \`yg-node.yaml\` | \`yg schemas read node\` |
| Edit \`yg-flow.yaml\` | \`yg schemas read flow\` + \`yg knowledge read flows\` |
| Edit \`yg-aspect.yaml\` | \`yg schemas read aspect\` + \`yg knowledge read aspects-overview\` |
| Edit \`yg-config.yaml\` | \`yg schemas read config\` + \`yg knowledge read configuration\` |
| Configure \`auto_approve\` | \`yg knowledge read configuration\` (see "auto_approve" section) |
| Pick the right type for new file | \`yg knowledge read working-with-architecture\` |
| Choose LLM or deterministic reviewer | \`yg knowledge read aspects-overview\` |
| Write an LLM aspect | \`yg knowledge read writing-llm-aspects\` |
| Write a deterministic aspect | \`yg knowledge read writing-deterministic-aspects\` |
| Use \`when\` on an aspect | \`yg knowledge read conditional-aspects\` |
| Write \`yg-suppress\` in code | \`yg knowledge read suppress-syntax\` |
| Understand the lock, verification, caching, merge, costs | \`yg knowledge read verification-and-lock\` |
| Log format, recovery, merge, large logs | \`yg knowledge read log-management\` |
| Ports, relations, channel 6 | \`yg knowledge read ports-and-relations\` |
| Flows — definition, participation, propagation | \`yg knowledge read flows\` |
| Use CLI commands deeply | \`yg knowledge read cli-reference\` |
| Browse all available knowledge topics | \`yg knowledge list\` |
| Read a graph-element schema (node/aspect/architecture/config/flow) | \`yg schemas read <name>\` |
| Aspect status (draft/advisory/enforced) | \`yg knowledge read aspect-status\` |
| Map the graph dir itself (meta-modeling) | \`yg knowledge read meta-modeling\` |
| Positive vs negative aspects; carve a type out of a negative aspect | \`yg knowledge read aspects-overview\` + \`yg knowledge read conditional-aspects\` |
| Onboard a human into Yggdrasil (tutor playbook) | \`yg knowledge read onboarding\` |
| Re-print this manual | \`yg prime\` |

### Operational Notes

- English only for all files in \`.yggdrasil/\`. Conversation can be any language.
- Read the relevant schema via \`yg schemas read <name>\` before creating any YAML file.
- When renaming or splitting a node: run \`yg flows\` and update any flow \`nodes\` lists that reference the old path. \`yg check\` will catch broken references but it's faster to fix them proactively.
- When unsure about anything: ask the user. Do not guess. Do not assume.
- Never invent rationale for aspects. If you don't know why a requirement exists, ask.`;

export const AGENT_RULES_CONTENT = [SYSTEM, DECISIONS].join('\n\n---\n\n') + '\n';
