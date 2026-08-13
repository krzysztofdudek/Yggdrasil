export const summary =
  'Three-level aspect status (draft / advisory / enforced) — rendering only, severity by status incl. unverified, verdict reuse across flips, declaration sites, max() rule, implies propagation';

export const content = `# Aspect status

Aspect status controls how a verdict renders in \`yg check\` and whether it blocks.
Status is RENDERING only — it never changes a verdict's validity. Three levels:

| Status      | Expected pairs | Refused renders as | Unverified renders as | Blocks \`yg check\`? |
|-------------|----------------|--------------------|-----------------------|----------------------|
| \`draft\`   | none (removed) | n/a                | n/a                   | no                   |
| \`advisory\`| yes            | warning            | warning               | no                   |
| \`enforced\`| yes            | error              | error                 | yes                  |

Status colors verdicts that exist; it never substitutes for verification.

- A recorded **advisory** refusal never blocks. A recorded **enforced** refusal
  blocks.
- An **unverified** pair blocks by its effective status too — enforced unverified
  is an error, advisory unverified is a warning. Flipping an aspect to advisory
  does NOT make an unverified enforced pair go green; the pair is still
  unverified, just now a warning. \`yg check --approve\` is what fills it.
- ONE exception to "enforced blocks", and only when progressive mode is on (the
  project sets \`progressive.reference\`): an enforced finding the current change
  did not reach renders as a warning, and \`yg check --full\` blocks on it again.
  Status is not what moved — the pair is still enforced, still verified and cached
  identically, and blocks the moment a change reaches it. On a project that names
  no branch, the table above is the whole story.
- ONE exception to "advisory never blocks": the \`prompt-too-large\` assembly gate
  is emitted at error severity regardless of status. An advisory LLM pair whose
  assembled prompt exceeds the resolved tier's \`max_prompt_chars\` blocks
  \`yg check\` all the same — it can never be verified, so status cannot soften it.
- Only **\`draft\`** removes a pair from the expected set entirely. Both keyless
  exits from a blocking pair are status flips (relevant in a keyless-CI
  emergency): \`draft\` removes the pair altogether; demoting to \`advisory\`
  keeps it visible as a warning.
- Draft dormancy applies to \`yg check\` / \`--approve\` only. Status never gates
  \`yg aspect-test\`: a draft aspect still runs there live (diagnostic only, the
  lock is never written) — the authoring ladder "start at draft, iterate with
  aspect-test" holds for both reviewer kinds.

## Verdict reuse across status flips

Status is NOT a hash input, so verdicts survive every flip:

- \`advisory ↔ enforced\` re-colors an existing verdict without re-verifying — an
  enforced→red overnight can happen if a refused verdict existed, but no reviewer
  runs.
- A \`draft\` round-trip preserves surviving verdicts: re-enabling an aspect whose
  pairs' inputs are unchanged revives the cached verdicts — no fresh look. An
  agent "parking and unparking" an aspect to force a re-review gets nothing.

To PARK an aspect, use \`status: draft\`, never a \`when\` edit — garbage-collection
prunes when-excluded pairs but keeps draft pairs.

## Declaration sites

\`\`\`yaml
# yg-aspect.yaml — aspect-level default
status: enforced              # default 'enforced' if absent
implies:
  - id: companion
    status_inherit: strictest # default 'strictest'; alternative 'own-default'

# yg-node.yaml — channel 1 (own) or 2 (cascade to descendants)
aspects:
  - id: rule
    status: enforced

# yg-architecture.yaml — channel 3 (own type) / 4 (ancestor type)
node_types:
  command:
    aspects:
      - id: cli-contract
        status: enforced

# yg-flow.yaml — channel 5
aspects:
  - id: correlation
    status: enforced

# yg-node.yaml ports — channel 6
ports:
  charge:
    aspects:
      - id: tracking
        status: enforced
\`\`\`

## Effective status rule

For each (node, aspect):
1. Collect every channel that attaches the aspect (after \`when\` filtering).
2. Effective status = max() across cascading channels 1–6, where
   draft < advisory < enforced. Channel 7 (implies) does not carry a
   \`status:\` of its own — it propagates via \`status_inherit:\` (see below).
3. If a channel's EXPLICIT declaration on channels 1–6 is lower than the
   cascade would yield without that declaration, the validator emits
   \`aspect-status-downgrade\` — downgrade attempts are validator errors.
   This is the "bump up OK, downgrade is error" rule.

\`yg check\` computes effective status live each run, so the SAME stored verdict
renders at whatever status is effective now.

## Implies propagation

For aspect A implies aspect B on node N:
- If A's effective status on N is \`draft\` → B is NOT propagated via implies
  (draft aspects are dormant). B may still arrive via another channel.
- Else:
  - \`status_inherit: strictest\` (default): B contributes max(A_effective, B_default)
  - \`status_inherit: own-default\`: B contributes B_default

## Status and verdicts

- Status is NOT folded into a verdict's hash. A verdict stays valid across every
  \`advisory ↔ enforced ↔ draft\` flip.
- \`draft → advisory/enforced\`: a pair that has never been verified appears as
  \`unverified\` (severity by the new status). A pair whose inputs match a surviving
  verdict is immediately valid — no re-verification.
- \`advisory → enforced\`: does NOT re-verify, but may flip CI from green to red if
  a refused verdict exists.
- \`advisory or enforced → draft\`: the pair leaves the expected set; its entry is
  pruned by garbage-collection on the next \`yg check --approve\` only if it would
  not be expected with draft included — draft pairs' entries are kept, so a round
  trip revives them.

## When to use which status

| Status   | When |
|----------|------|
| draft    | Content.md / check.mjs is still being authored, or the rule is unclear. Zero cost, zero enforcement, no expected pairs. |
| advisory | Rule is complete but you want to gather signal across the repo without blocking CI. Refused and unverified both render as warnings. |
| enforced | Rule is vetted; violations should block. Refused and unverified both block check. |

## See also

- [[aspects-overview]] — when to create aspects in general
- [[verification-and-lock]] — the lock, hashing, caching, the three exits from a refusal
- [[conditional-aspects]] — \`when\` predicates (orthogonal to status)
- [[writing-llm-aspects]] / [[writing-deterministic-aspects]] — authoring guide
`;
