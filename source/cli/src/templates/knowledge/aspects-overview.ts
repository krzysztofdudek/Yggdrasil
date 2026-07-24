export const summary =
  'What aspects are, when to create, LLM vs deterministic vs aggregating reviewer choice, scope, cost model per pair, directory organization, positive vs negative aspects';

export const content = `# Aspects overview

Aspects are enforceable rules attached to nodes. A reviewer (LLM or
deterministic) checks the subject files of a unit against the aspect, and the
verdict is cached in the lock.

## What an aspect is

An aspect pairs a description (\`content.md\` for LLM, \`check.mjs\` for
deterministic) with metadata (\`yg-aspect.yaml\`), and optionally reference files
(LLM aspects only) for supporting context. Verification produces \`approved\` or
\`refused\` with a violation report, cached in the lock keyed by the
\`(aspect, unit)\` pair — LLM verdicts in the committed \`yg-lock.nondeterministic.json\`,
deterministic verdicts in the gitignored \`.yg-lock.deterministic.json\` cache.

A verdict holds exactly while the inputs that produced it are unchanged. Editing
a subject file, the aspect's rule source, its \`scope\`, or its tier makes the pair
unverified, and \`yg check --approve\` re-verifies it. A status flip is not an
input — it never invalidates a verdict. (Full mechanics:
\`yg knowledge read verification-and-lock\`.)

For HOW aspects reach a node (the 7 propagation channels with concrete
example), see the SYSTEM section of the agent operating manual (\`yg prime\`)
— that mental model is loaded by default and is not duplicated here.

## When to create an aspect

Create an aspect when:
1. The same pattern appears in 3+ files AND
2. A reviewer can verify it against source code

Both conditions must hold. "Code should be readable" fails condition 2.
"Every handler must log an audit trail" satisfies both.

See the agent operating manual (\`yg prime\`) "Aspect Discovery" section for
the brownfield triggers (repeated patterns, "invisible" cross-cutting
concerns) — also not duplicated here.

While the rule is still being authored or is unclear, give the aspect
\`status: draft\` — a draft aspect produces no expected pairs, so nothing is
verified and it costs zero.

## Scope — node or file

An aspect with a rule source may declare \`scope:\`:

\`\`\`yaml
scope:
  per: node | file        # default: node
  files:                  # optional — file-predicate filter (path/content atoms)
    all_of:
      - path: "src/**/*.ts"
      - not: { path: "**/*.test.ts" }
\`\`\`

- \`per: node\` (default) — one verdict over the whole subject set. Editing a file
  OUTSIDE the filter does not change the subject set, so an irrelevant edit
  (a README, a fixture) leaves the code-rule verdict valid.
- \`per: file\` — one verdict per subject file. Correct only for **file-local**
  rules. Cross-file rules ("exactly one file exports X", "correlation ID
  propagates") must stay \`per: node\`. See
  \`yg knowledge read writing-llm-aspects\`.

A \`scope\` edit (either \`per\` or \`files\`) invalidates EVERY pair of the aspect —
it cascades exactly like a \`content.md\` edit. Run \`yg impact --aspect <id>\`
before changing scope on a widely-used aspect. Aggregating aspects have no rule
source and therefore no \`scope\` (a validator error if present).

## Three reviewer kinds

Three reviewer kinds exist: LLM, deterministic, and aggregating. The kind is
**inferred** from which rule source file is present in the aspect directory:
\`content.md\` → LLM; \`check.mjs\` → deterministic; neither file but \`implies:\`
declared → aggregating. The \`reviewer:\` block in \`yg-aspect.yaml\` is optional;
if present, an explicit \`reviewer.type\` must agree with the inferred kind.

**\`companion.mjs\` is an add-on to the LLM kind, not a fourth reviewer kind.**
An LLM aspect may ship \`companion.mjs\` alongside \`content.md\` to provide a
per-unit companion file resolver — a hook that selects 0..N files injected
into the reviewer prompt for each unit individually. Presence of
\`companion.mjs\` does not change the inferred reviewer kind (still LLM) and
is forbidden alongside \`check.mjs\`. See
\`yg knowledge read writing-llm-aspects\` for the full contract.

### Aggregating aspects

An aggregating aspect ships neither \`content.md\` nor \`check.mjs\`. It exists
purely to bundle other aspects under one named attach point. When an aggregating
aspect is effective on a node, all aspects in its \`implies:\` list are expanded
and verified individually. The aggregate itself has no own reviewer and produces
no own verdict. It never dispatches to an LLM and never runs \`check.mjs\`.

Use aggregating aspects to decompose a multi-rule contract: attach the aggregate
once (per node, per flow, per architecture type) and let each implied child carry
one concrete, independently-verdicted rule. An aspect with neither rule source
and no \`implies:\` is rejected by the validator.

### When to use LLM

Choose LLM (ship a \`content.md\`) when:
- The rule requires judgment ("no business logic in controllers")
- The rule involves semantics ("correlation ID must propagate across calls")
- The rule needs to understand intent rather than syntax
- The rule is hard to express as a structural pattern

LLM reviewers understand context, read prose rules, and can assess whether
code satisfies a nuanced requirement. They are slower and cost per call.

LLM aspects may declare \`reviewer.tier: <name>\` to opt into a specific reviewer
tier configured in \`yg-config.yaml\` (a higher-capability model for critical
aspects). If \`tier:\` is omitted, the aspect uses the tier named by
\`reviewer.default\` (or the sole tier, if only one is configured).

### When to use deterministic

Choose deterministic (ship a \`check.mjs\`) when:
- The rule is structural ("never import from \`db/\` in \`ui/\`")
- The rule is naming-based ("exported classes must be PascalCase")
- The rule is about graph or file-system shape ("every command node must have
  a sibling test file"; "every child of an engine node must be of type
  engine-component")
- You need zero false-positive tolerance and determinism
- The rule is "X must never appear" — forbidden API calls, banned imports

A \`check.mjs\` is one \`check(ctx)\` function: it reads the unit's files and may
reach related nodes, the file system, and graph metadata through \`ctx\`. It runs
locally during \`yg check --approve\` at zero LLM cost and returns exact,
deterministic results. Deterministic aspects do NOT use reviewer tiers —
\`reviewer.tier:\` is rejected on them.

\`check.mjs\` runs in the main Node process with full privileges — there is no
security sandbox. The read allow-list is a discipline that scopes observed
dependencies, not an isolation boundary. Only run aspects you trust.

### Decision tree

1. Can the rule be expressed as "this syntax pattern must (not) appear" or
   "this graph/file-system shape must hold"?
   → Yes: use deterministic
   → No: continue

2. Does the rule require understanding code intent or business logic?
   → Yes: use LLM

3. Is the rule about naming, import paths, structural shape, or cross-node
   consistency?
   → Yes: use deterministic

4. Does the rule need to assess whether semantics match a requirement?
   → Yes: use LLM

When in doubt: write a draft \`check.mjs\`, test it with \`yg aspect-test\`. If it
catches real violations without false positives, ship it as deterministic. If it
misses violations that require reading intent, switch to LLM.

To author a \`check.mjs\`: \`yg knowledge read writing-deterministic-aspects\`.

## Cost model

Cost is counted per PAIR.

- An LLM pair = at least one reviewer call during \`yg check --approve\`,
  multiplied by the tier's consensus count. An LLM aspect touching 20 single-unit
  nodes = at least 20 calls. With \`per: file\`, multiply by the subject-file count
  (and references travel in every per-file prompt).
- Deterministic pairs run locally at zero LLM cost, however many they touch.
- Aggregating aspects have no own reviewer call.
- A \`scope\` edit, a \`content.md\` edit, a reference-file edit, or a tier change
  invalidates pairs and re-bills them. Run \`yg impact --aspect <id>\` before
  modifying a widely-used aspect to see the re-verification cost.
- **Editing \`companion.mjs\`** re-verifies ALL pairs of the aspect (like a
  \`content.md\` edit). **Editing a resolved companion file** re-verifies only
  the pairs that read it — and the fold covers every file the hook reads to
  decide, not only what it returns.
  Use \`yg impact --file <companion>\` to see which pairs read a given file.

The prompt-size gate (\`max_prompt_chars\` per tier) bounds an LLM prompt, not the
node. For the full caching, hashing, and merge model:
\`yg knowledge read verification-and-lock\`.

## Aspect status

Aspects declare \`status: draft | advisory | enforced\` (default \`enforced\`).
Status is rendering only — it never changes a verdict's validity.

| Status   | Expected pairs | Renders as |
|----------|----------------|------------|
| draft    | none (removed) | n/a                      |
| advisory | yes            | warning (refused or unverified) |
| enforced | yes            | error — blocks \`yg check\`     |

Advisory never blocks; enforced always does; only \`draft\` removes a pair from the
expected set. Deep reference: \`yg knowledge read aspect-status\`.

## Organizing aspects in directories

An aspect's id is its directory path under the aspects root, so ids can be NESTED:
a rule file at \`<aspects-root>/logging/audit/\` has id \`logging/audit\`. A directory
that holds no rule file is a pure organizational GROUPER — it just namespaces the
aspects beneath it. Use this to keep a growing aspect set legible: group related
rules under a common prefix (\`logging/...\`, \`security/...\`) instead of a flat pile
of top-level ids, nesting as deep as the structure warrants.

Directory nesting is NAMING only — it does NOT create inheritance or a cascade
between aspects. A child-directory aspect does not inherit its parent directory's
rules; cascade comes from the NODE hierarchy and the attach channels, never from
where an aspect's files sit. When several aspects share a theme or attach point,
prefer grouping them in a directory (and, for a multi-rule contract behind one
name, an aggregating aspect) over leaving them scattered.

## Positive and negative aspects

An aspect can require something to BE present (positive — "every public handler
validates its input") or forbid something from being present (negative — "no
component reaches the data store directly"). This is purely how the rule file is
worded: an LLM aspect's prose states the prohibition, a deterministic check returns
a violation when the forbidden pattern appears. Both are first-class; neither needs
a special mechanism.

A common, powerful shape is a broad NEGATIVE aspect with a carved-out specialist.
Attach the prohibition at a parent node so it cascades to every descendant, then
EXCLUDE the one node type that is legitimately allowed to do the forbidden thing —
the type that carries its own POSITIVE aspects enforcing that it does so correctly:

\`\`\`yaml
# "no direct data-store access" — everywhere EXCEPT the data-access layer, which
# carries its own aspects ensuring it accesses the store correctly.
when:
  not:
    node:
      type: data-access
\`\`\`

The exclusion is a \`when\` predicate — deterministic, zero reviewer cost. The pattern
is general, not storage-specific: "no raw outbound HTTP except the gateway node",
"no logging-framework bypass except the logging adapter", and so on. Grammar:
\`yg knowledge read conditional-aspects\`.
`;
