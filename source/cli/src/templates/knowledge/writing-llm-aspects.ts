export const summary =
  'How to write content.md for the LLM reviewer: rule structure, scope (per-file is file-local only), prompt limits, false-positive path with aspect-test as the sanctioned diagnostic';

export const content = `# Writing LLM aspects

LLM aspects ship a \`content.md\` describing the rules in prose. The reviewer
receives \`content.md\` + any reference files + resolved companion files (from
\`companion.mjs\`, per unit) + the unit's subject files and returns approved or
refused. The verdict is cached in the lock keyed by the
\`(aspect, unit)\` pair.

## content.md format

A \`content.md\` file is a Markdown document with:
- A top-level heading naming the aspect
- One H2 section per rule
- Each section answers: WHAT must be true, WHY it matters, HOW a passing
  implementation looks

\`\`\`markdown
# Aspect Name

Brief one-sentence description of the aspect's purpose.

## Rule: Emit audit log before mutation

Every public method that mutates state must emit an audit log entry
before returning.

### Why

Regulatory requirement: all state changes must be traceable for 7 years.

### What passing looks like

\`\`\`typescript
async function updateUser(id: string, data: UserData): Promise<User> {
  await auditLog.emit({ action: 'user.update', id, actor: ctx.userId });
  return this.repo.update(id, data);
}
\`\`\`
\`\`\`

## Writing the rules

Rules are the heart of the aspect. Write them so a reviewer can make a
binary pass/fail decision by reading the code.

**One rule per heading.** Mixing multiple constraints in one paragraph
causes the reviewer to miss violations or produce inconsistent judgments.

**State what must be true, not what should be avoided.** "Every mutation
must log" is stronger than "don't forget to log". The reviewer checks
whether the positive constraint holds.

**Be specific about scope.** "Every function" is too broad. "Every public
method that mutates state" is precise enough for the reviewer to distinguish
violating from non-violating code.

**Never invent rationale.** If you don't know why a rule exists, ask. The
reviewer surfaces the rule's reason to the developer who must comply. Wrong
rationale = wrong fix guidance.

**Do not put cross-cutting rules in one node's content.md.** If the same
rule applies across many nodes, extract it into a shared aspect and
attach it to those nodes. A rule buried in one node's prose never reaches
the others.

## Choosing scope: per node vs per file

An aspect declares \`scope.per: node\` (default) or \`scope.per: file\`, optionally
narrowed by \`scope.files\`.

\`per: file\` is correct ONLY for **file-local rules** — ones a reviewer can judge
from a single file alone ("every handler validates its input"). Rules that need
cross-file context — "correlation ID propagates across calls", "exactly one file
exports X" — must stay \`per: node\`. A per-file reviewer cannot see the rest of
the node and will produce false verdicts in both directions, silently. Cross-file
rules against a **static shared contract** can use \`per: file\` + \`references:\`
(the contract travels in every prompt).

**Pre-flight ritual before switching an aspect to \`per: file\`:** generate one
per-file prompt and read it —

\`\`\`bash
yg aspect-test --aspect <id> --node <representative> --dry-run
\`\`\`

If the rule cannot be judged from that single file plus references, it is not
file-local; leave it \`per: node\`. This guidance is load-bearing and cannot be
enforced deterministically.

A \`scope\` edit (either \`per\` or \`files\`) invalidates EVERY pair of the aspect —
it cascades like a \`content.md\` edit. Narrowing \`scope.files\` to exclude tests
is still a full re-verification. Run \`yg impact --aspect <id>\` first.

## Cost considerations

Each effective non-draft LLM pair = at least one reviewer call during
\`yg check --approve\`, multiplied by the tier's consensus count. With \`per: file\`,
multiply again by the subject-file count, and references are loaded into every
per-file prompt. Deterministic aspects cost ZERO LLM calls. Draft aspects produce
no pairs (zero cost, no verdict) — but remain testable with \`yg aspect-test\`
(\`--dry-run\` is free; a live run makes a real reviewer call).

Before creating a new LLM aspect:
1. Check if an existing aspect covers the rule (\`yg aspects\`)
2. Run \`yg impact --aspect <id>\` on similar existing aspects to understand
   the scale of review calls this will generate
3. Consider whether a deterministic aspect would serve the same purpose for free

When an aspect touches many pairs, verification is expensive. Prefer narrow,
precise aspects over broad catch-all ones.

## Prompt-size gate

Each tier may set \`max_prompt_chars\`. An assembled LLM prompt (scaffold +
content.md + references + resolved companion files + subject files + node
descriptor) exceeding the resolved tier's limit is a blocking
\`prompt-too-large\` error — checked deterministically at \`yg check\`, and the
pair is skipped by \`--approve\`. Remedies, in safety order:

1. Narrow \`scope.files\` — safe when the overflow is non-target payload (fixtures,
   generated files, docs).
2. Switch the aspect to \`per: file\` — ONLY if the rule is file-local (above).
3. Split the node.
4. Raise \`max_prompt_chars\` on the current tier, or re-point the aspect's
   \`reviewer.tier:\` to a higher-limit tier. Raising the limit on the SAME tier
   invalidates NOTHING — tier config (including \`max_prompt_chars\`) is excluded
   from the pair hash; it simply lets a previously oversized, unverified pair get
   reviewed for the first time on the next \`--approve\`. Re-pointing THIS aspect's
   \`reviewer.tier:\` to a differently-named tier invalidates only this aspect's own
   pairs (other aspects already on that tier are untouched — their \`reviewer.tier:\`
   did not change); confirm with the user.

## False-positive mitigation

LLM reviewers can produce false positives: refusing code that is actually
correct. Causes:
- Rules stated ambiguously — reviewer interprets differently than intended
- Rules that are too strict — no room for valid alternative implementations
- Rules that conflict with each other within the same aspect

To reduce false positives:
- Include "what passing looks like" examples in each rule section
- Include "what a false positive looks like" notes when ambiguity is known
- Preview the prompt with \`yg aspect-test --aspect <id> --node <path> --dry-run\`
- If a reviewer consistently refuses correct code, sharpen the rule text —
  knowing this re-verifies EVERY node using the aspect (run \`yg impact --aspect\`
  first).

A refusal in the lock is cached and final for unchanged inputs — re-running
\`yg check --approve\` re-renders it, it does not re-roll. When you believe a
refusal is a false positive, \`yg aspect-test\` is the sanctioned diagnostic: it
runs the reviewer live WITHOUT writing the lock.

\`\`\`bash
yg aspect-test --aspect <id> --node <path>
\`\`\`

If aspect-test repeatedly approves what the lock refuses, the rule text is
ambiguous for this reviewer. Two sanctioned exits: sharpen \`content.md\`
(cascades — check \`yg impact\`), or propose a \`yg-suppress\` to the user. There is
deliberately no verdict-drop command, and a cosmetic edit purely to force a
re-roll is forbidden laundering.

When a reviewer refuses code you believe is correct:
1. Read the refusal carefully — it tells you exactly what rule it applied
2. If the code is correct and the rule is wrong, update the rule text (cascades)
3. If the rule is right and the code needs changing, fix the code
4. Use \`yg-suppress\` only for intentional, documented exceptions with user approval

## Choosing a reviewer tier

LLM aspects may opt into a specific reviewer tier from \`yg-config.yaml\`:

\`\`\`yaml
# .yggdrasil/aspects/test-quality/yg-aspect.yaml
name: TestQuality
description: Tests verify correct behavior, not just coverage.
reviewer:
  type: llm
  tier: deep        # one of the keys under reviewer.tiers in yg-config.yaml
\`\`\`

When \`tier:\` is omitted, the aspect uses the tier named by \`reviewer.default\`
(or the sole tier, if only one is configured).

Use a higher-capability tier (e.g. \`deep\`) when the aspect interprets nuanced
semantics, a false approval is much more costly than the higher per-call price,
or the rules are ambiguous enough that a cheaper model gives flaky judgments. Use
the cheaper default tier for narrow, well-defined contracts.

Only the tier's NAME is folded into an LLM pair's hash — not its config. Changing
\`reviewer.tier:\` on an aspect (pointing it at a differently-named tier) invalidates
every pair using it and re-verifies on the next \`yg check --approve\`. Editing the
referenced tier's own \`provider\` / \`consensus\` / \`config\` does NOT invalidate any
verdict — the config is the reviewer's private business, so a named tier can be
re-pointed at a different model or provider without re-verifying. Run
\`yg impact --aspect <id>\` before swapping a tier on a widely-used aspect.

## When to prefer a deterministic aspect over LLM

If the rule is expressible as "this identifier must / must not appear" or
"imports from X are forbidden in Y" — use a deterministic aspect instead. It is
deterministic, produces no false positives, and costs nothing per call.

## Companion files (companion.mjs)

An LLM aspect may ship an optional \`companion.mjs\` alongside \`content.md\`.
The companion hook is a per-unit resolver that selects 0..N companion files
injected into the reviewer prompt for that unit only. Use it when the files
relevant to the review differ per unit — for example, each feature file has
a paired requirements doc, or each test file maps to a specific scenario
description.

### Contract

\`\`\`javascript
// .yggdrasil/aspects/my-rule/companion.mjs
export async function companion(ctx) {
  // ctx is the same ctx a deterministic check.mjs receives, including ctx.subject
  // (that field is shared — both runners build it from one factory, not companion-only).
  // ctx.subject is always File[] (never a bare File).
  //   scope.per:file  → single-element array [file].
  //   scope.per:node  → the full subject set (same as ctx.files).
  //
  // Read files via ctx to DECIDE which paths to return.
  // Return Array<{ path: string, label?: string }>.
  // Return [] when no companion applies to this unit (valid).
  // Throw to assert a requirement — becomes an infra-fail (pair stays unverified).
  return [];
}
\`\`\`

The hook may be async. Returned paths may be absolute or relative; the runner
normalizes each to repo-root-relative POSIX, deduplicates, and sorts. For
\`scope.per: node\`, a returned path that equals a unit subject file is silently
skipped and not recorded.

### When to use companion files vs references

- **\`references:\`** — static files that apply to ALL units of the aspect
  (e.g. an error-code catalogue, a shared contract). Declared once in
  \`yg-aspect.yaml\`; included in every prompt.
- **\`companion.mjs\`** — per-unit files resolved at review time (e.g. a
  requirements doc paired with the specific source file being reviewed).
  The hook runs once per unit and can return a different set each time.

### Allowed reads

The companion hook shares the same read boundary as \`check.mjs\`: own
mapping, declared-relation targets, ancestors, and own descendants.
Attempting to read outside this set is an allowed-reads violation and causes
an infra-fail (nothing written, pair stays unverified).

A companion's verdict folds in **everything the hook reads to decide** — not
only the paths it returns. So read narrowly: resolve the single file you need
with \`ctx.fs.read\`/\`ctx.fs.exists\` on a specific path. Do NOT materialize a
whole related node via \`ctx.graph.node(...)\` to inspect it — that reads the
entire node's content into **every** per-file pair's verdict, so any edit
anywhere in that node re-verifies (and re-bills) every pair, defeating
per-unit isolation.

### Purity requirement

Like \`check.mjs\`, the companion hook must be pure — no file writes, no network
calls, no \`process.exit\`. An impure hook yields non-deterministic observations;
the runner retries once and then fails closed (reported as
\`aspect-companion-runtime-error\`).

### Assembly failure

If the hook throws, returns a bad shape, returns a path that does not exist,
returns a path outside the allowed-reads set, or produces an observation set
that stays inconsistent across two runs, the pair fails closed: nothing is
written, the pair stays unverified, and \`yg check --approve\` reports the
per-pair what/why/next message with the token
\`aspect-companion-runtime-error\`. A summary line is also emitted at the end
of the fill run: "N companion resolution(s) failed to run at fill time —
left unverified (aspect-companion-runtime-error)." This mirrors the
deterministic \`aspect-check-runtime-error\` pattern exactly. The hook never
judges code — any judgment logic belongs in the LLM reviewer via \`content.md\`.

### yg-suppress in companion files

\`yg-suppress\` markers in companion files are IGNORED. Suppression is scoped
to subject files only.

### Example: pairing each test file with its scenario document

\`\`\`javascript
// .yggdrasil/aspects/scenario-coverage/companion.mjs
// For each test file, locate the paired scenario doc by convention.
// Test files are named foo.test.ts; scenarios live at docs/scenarios/foo.md.
export async function companion(ctx) {
  // ctx.subject is always File[]. per:file scope → single-element array.
  const [file] = ctx.subject;
  const stem = file.path.split('/').pop().replace(/\\.test\\.ts$/, '');
  const scenarioPath = \`docs/scenarios/\${stem}.md\`;
  if (ctx.fs.exists(scenarioPath) === 'file') {
    return [{ path: scenarioPath, label: 'scenario document' }];
  }
  // No scenario doc found — return [] and let the reviewer decide
  return [];
}
\`\`\`

### Frontmatter parsing

There is no dedicated frontmatter helper. To extract YAML frontmatter
embedded in a Markdown file, use a regex on the \`---\` block — because the
companion file's \`.content\` is raw Markdown (frontmatter + body), and
\`ctx.parseYaml\` does NOT parse a raw inline string. A string argument to
\`ctx.parseYaml\` is treated as a FILE PATH (the runner reads it from disk);
a File argument parses \`file.content\`. Use \`ctx.parseYaml\` to parse
separate YAML/JSON files, not embedded frontmatter blocks:

\`\`\`javascript
// Reading frontmatter from a Markdown file's .content: use a regex.
function parseFrontmatter(content) {
  const m = content.match(/^---\\n([\\s\\S]*?)\\n---/);
  return m ? m[1] : null;
}

// Reading a separate YAML config file by path: ctx.parseYaml(pathString).
// The string is a file path — the runner reads the file from disk and parses it.
const data = ctx.parseYaml('docs/config.yaml');
\`\`\`

### Validator errors

- \`aspect-companion-without-content\` — \`companion.mjs\` is present but
  \`content.md\` is absent. Companion files require an LLM aspect.
- \`aspect-companion-with-check\` — \`companion.mjs\` is present alongside
  \`check.mjs\`. Companion files are an LLM add-on only.

### Testing companion hooks

Use \`yg aspect-test --aspect <id> --node <path> --dry-run\` to run the hook
live and inspect the resolved companion paths and assembled prompt without
making a reviewer call or writing the lock. (The ad-hoc \`--files\` mode is
unavailable for companion aspects — they need a node's relations to resolve;
always use \`--node\`.)

### Cost

- **Editing \`companion.mjs\`** re-verifies ALL pairs of the aspect (same as
  editing \`content.md\`). Run \`yg impact --aspect <id>\` first.
- **Editing a resolved companion file** re-verifies only the pairs that
  observed it — like editing a subject file, not a full re-bill.
- **\`companion.mjs\`** appears in the aspect's \`read:\` listing (\`yg context\`).
- To see which pairs read a specific companion file (its re-verification
  fan-out): \`yg impact --file <path>\`.

Because the verdict folds everything the hook reads to decide, editing any
read-to-decide file (not only a returned one) re-verifies its readers.
\`yg impact --file <path>\` previews this precisely — including cold
companion-backed pairs with no lock entry yet (it runs the resolver, no LLM
call).

## Reference files

An LLM aspect may declare \`references:\` in yg-aspect.yaml — supporting
files (lookup tables, catalogues, contracts) loaded into the reviewer
prompt alongside content.md. References answer questions like "what's the
exact list of valid error codes?" without requiring content.md to embed
data that lives elsewhere.

### When to use references

Use when the rule depends on data that:
- Lives outside the aspect (catalogue, enum, ID list).
- Changes independently of the rule itself.
- Would otherwise force the author to either duplicate it into content.md
  or describe it abstractly and hope the reviewer infers correctly.

Do NOT use references for:
- The rule statement itself — that's content.md.
- Source code under review — that comes from the node's mapping.
- Ambient project context — that belongs in rules / knowledge files.

### Format

\`\`\`yaml
references:
  - docs/error-codes.md                            # shorthand string
  - path: source/cli/src/errors/codes.ts           # explicit form with description
    description: "Source of truth for error code constants."
\`\`\`

Two equivalent entry forms. The description (when present) helps both the agent
and the reviewer understand the reference's role, and it is folded into the LLM
pair's hash — editing it re-verifies.

### Composition with implies

References attach to the aspect's effective presence on a node. Each
aspect is reviewed independently — A's prompt does NOT contain B's
references, even when A implies B. If A's content.md says "see catalogue
in B", declare the same reference on A or move it onto A directly.

### Composition with when

If an aspect has a \`when\` predicate that filters it out on a particular node,
its references are also filtered out on that node — references attach to the
aspect's effective presence, not its declaration.

### Cost

Editing a referenced file invalidates every pair where the referring aspect is
effective. Run \`yg impact --file <ref>\` before editing a widely-referenced file.
A reference's bytes count toward the prompt-size gate — there is no separate
reference byte cap; the prompt limit bounds the whole payload.

## Aspect status

LLM aspects declare \`status: draft | advisory | enforced\` (default \`enforced\`).
Status is rendering only. Draft produces no pairs (zero cost). Advisory and
enforced both verify; they differ only in how a refused or unverified pair
renders. The authoring ladder mirrors deterministic aspects: start at \`draft\`,
iterate with \`yg aspect-test\` (\`--dry-run\` previews the prompt for free; a
live run calls the reviewer), promote when the rule is stable.
See: \`yg knowledge read aspect-status\`.
`;
