export const summary =
  'Full yg command reference: check, check --approve, context, aspect-test, drill, impact, tree, aspects, flows, find, log, owner, type-suggest, init, knowledge, schemas';

export const content = `# CLI reference

All commands assume you are in the repository root with a \`.yggdrasil/\`
directory. Run \`yg init\` to bootstrap if missing.

## yg check

Unified gate. By default: writes nothing, validates the lock, structure, and
coverage; runs no aspect reviewers and makes no LLM calls. It does recompute
the built-in relation-conformance check live (parse + resolve), at zero LLM
cost. Exception: if \`auto_approve\` is configured in \`yg-config.yaml\`, bare
\`yg check\` auto-fills — \`deterministic\` mode behaves like \`--approve
--only-deterministic\`, \`full\` mode like \`--approve\`. Explicit CLI flags
(\`--approve\`, \`--no-approve\`, \`--only-deterministic\`) ALWAYS override
\`auto_approve\`. CI and pre-commit should always use the explicit flag form to
stay key-free and deterministic regardless of project config.

\`\`\`bash
yg check
\`\`\`

Reports: unverified pairs (no valid verdict — new, edited, tampered, or
fill-failed), cached refusals (rendered from the lock), validation errors,
coverage gaps (\`unmapped-files\` errors under required roots,
\`uncovered-advisory\` warnings outside them), type-when mismatches, strict
orphans/misplaced files, \`prompt-too-large\`, \`lock-invalid\`. Severity of a pair
follows its effective status: enforced → error (blocks), advisory → warning.

When at least one pair is verified, the PASS/FAIL header shows how many green
pairs are deterministic (machine-checked locally, zero LLM cost) vs LLM-reviewed
— e.g. \`12 verified (9 deterministic, 3 LLM)\` — so a clean run never hides how
much of it was actually reviewed by an LLM versus checked for free.

Exit 0 = clean. Exit 1 = errors found. CI runs it cheap and keyless.

### Default grouped output

The default \`yg check\` output is grouped: issues that share the same rule are
collapsed into one block — the shared why + fix is shown once, and the affected
nodes are listed beneath. The header shows \`Errors (N) in M groups:\` when there
is more than one group. \`unverified\` pairs collapse to one group per aspect
(node lines only, no repeated explanation). The \`Next:\` line is annotated with
a residual count when the suggested command will not clear every error.

### Triage views: \`--top [N]\`, \`--summary\`, \`--aspect <id>\`, and \`--details\`

Four read-only flags give alternative views of the same issue set. All are
mutually exclusive with each other, and all are incompatible with \`--approve\`
(which has its own \`--dry-run\` cost preview). Explicit CLI flags override
\`auto_approve\` config.

\`\`\`bash
yg check --top 5           # print only the 5 highest-priority GROUPS
yg check --top             # print only the single suggested-next group (no value)
yg check --summary         # print per-node counts only — no per-issue blocks
yg check --aspect <id>     # drill into one rule: show only that rule's group
yg check --details         # ungrouped per-issue view (one block per pair, old style)
\`\`\`

\`--top N\` renders the N highest-priority GROUPS (in the same priority order the
\`Next:\` line draws from); a bare \`--top\` (no value) renders exactly one group —
the suggested-next one. \`--summary\` prints one line per node —
\`K unverified (J deterministic-free, L LLM), M refused\` — plus a named bucket
for non-pair errors (coverage / log / relation / structural) so per-node totals
reconcile with the header. \`--aspect <id>\` shows the single group for that rule
with full per-node details; its \`Next (this group):\` line is the bare command
to run. \`--details\` reverts to the old ungrouped per-pair layout — useful when
you need every individual reviewer reason visible at once.

Guardrail: EVERY view always prints the true aggregate \`Errors (N)\`/\`Warnings (N)\`
header and preserves the real exit code, so a narrowed view can never read as a
clean build. When a \`--top\` slice leaves a section (Errors or Warnings) with a
true count > 0 but no chosen groups, a parenthetical note is printed beneath
that subheader instead of leaving it dangling empty. An invalid \`--top\` value
(negative, fractional, non-numeric, or an explicit \`0\`) is a guided error,
never a silent full dump — for the single suggested-next group use bare
\`--top\`. Read the raw output — never pipe it through \`| grep\`,
\`| head\`, or \`| tail\`: those silently drop lines and the count you act on stops
matching the count the build enforces. Orient with \`--summary\`/\`--top\`, drill
with \`--aspect\` or plain \`yg check\`.

## yg check --approve

Fill every unverified pair, then report. The only writer of verdicts (alongside
\`yg log merge-resolve\`, which writes the per-node log baseline). Explicit flags
(\`--approve\`, \`--no-approve\`, \`--only-deterministic\`) always override any
\`auto_approve\` setting in \`yg-config.yaml\`.

During filling, progress is streamed to **stderr** (stdout holds only the clean
final report). A heartbeat keeps the output from looking hung on long runs.
Pass \`--quiet\` / \`-q\` to silence the progress stream entirely — useful when
piping the report or running in environments where stderr noise matters.

\`\`\`bash
yg check --approve                      # fill everything (deterministic, then LLM), then report
yg check --approve --only-deterministic # fill ONLY deterministic pairs (free, keyless); the CI / pre-commit gate
yg check --approve --dry-run            # free cost preview — print the budget + per-node breakdown, write NOTHING, exit 0
yg check --approve --quiet              # fill everything but silence stderr progress
\`\`\`

When \`auto_approve\` is set to \`full\` in \`yg-config.yaml\`, bare \`yg check\`
triggers a full fill and the PASS header shows \`(auto-filled)\` to distinguish it
from a clean read-only pass. A pre-run banner on stderr warns that reviewer
calls will be made.

Verification is repo-wide and all-or-nothing. The one scoping flag is
\`--only-deterministic\`: it runs the deterministic fills only (no LLM, no key) and
writes ONLY the gitignored deterministic cache — the committed lock files are
never touched (positive closure is skipped, GC is scoped to the cache), so a CI or
pre-commit run produces zero committed-lock churn. A fresh checkout has no
deterministic cache, so this rematerializes it; it also re-hashes the committed
LLM verdicts, so the trailing report still catches a stale committed LLM verdict.

The full-run order: a pre-dispatch header (\`Filling N unverified pairs across M
nodes — D deterministic (no cost), K reviewer calls (consensus included)\`); the
per-node log gate; deterministic fills first (free); the deterministic gate (a
node with an enforced deterministic refusal has its LLM fills skipped this run);
then LLM fills. A real verdict (approved or refused) is written to the lock; every
infra disposition writes nothing and the pair stays unverified. Refusals are
cached and FINAL for unchanged inputs. Interrupting is safe — finished pairs
persist, the next run resumes.

When nothing was unverified, the summary says \`0 reviewer calls made — all
expected pairs hold valid verdicts\`. Under \`--only-deterministic\` the header and
summary instead name the LLM pairs left unverified — they are skipped by design,
not reviewed — and point at a full \`yg check --approve\` to review them, so a
deterministic-only run never reads as if it verified everything. Use \`yg impact\`
to predict cost before editing.

\`--dry-run\` (with \`--approve\`) is a free cost preview: it runs the same
structural gate, pair classification, and budget computation, prints the
pre-dispatch header plus a per-node / per-aspect breakdown (each deterministic
pair labelled free; each LLM pair labelled with its consensus call count), then
exits 0 WITHOUT calling the reviewer, running any \`check.mjs\`, or writing a
single byte to any lock file. The reviewer-call number is an UPPER BOUND — a
node with an enforced deterministic refusal has its LLM fills skipped, and a
fresh refusal or an infrastructure disposition can leave a pair unfilled, so the
real \`--approve\` bills at most that many calls. The preview always exits 0, even
when enforced pairs are unverified; it never blocks. Only a broken
configuration (the step-1 structural gate) aborts the preview — it surfaces the
same blocker a real \`--approve\` would hit. A cost estimate never demands a fresh
log entry, so the preview never HARD-STOPS on the per-node log gate — it previews
the budget even on \`log_required\` nodes whose source changed since their last
closure, where a real \`--approve\` would require the entry first. (The preview's
trailing read-only check report still SURFACES that requirement as a
\`log-entry-missing\` error, exactly as plain \`yg check\` does — it just exits 0
and writes nothing.) \`--dry-run\` requires
\`--approve\`; on its own it is a usage error (plain \`yg check\` is already a free,
no-write read).

## yg context

Show the graph context for a file or node.

\`\`\`bash
yg context --file src/orders/handler.ts
yg context --node orders/handler
\`\`\`

File form shows: owning node, effective aspects with \`read:\` paths,
dependencies. Node form shows: aspects (with per-aspect subject-file counts,
including \`0 files — vacuous\`), flows, dependents, source files, and the log
state line (\`log entry required before --approve: yes/no; fresh entry present:
yes/no\`).

Read the files listed under \`read:\` before editing any source file — they
contain the rules the reviewer will check your code against.

## yg aspect-test

Diagnostic — run a check or reviewer LIVE without writing the lock. Works for
both reviewer kinds.

\`\`\`bash
# Deterministic: run check.mjs against a node or ad-hoc files
yg aspect-test --aspect sibling-test-file --node orders/handler
yg aspect-test --aspect no-sync-fs --files src/orders/handler.ts
yg aspect-test --aspect sibling-test-file --node orders/handler --check-determinism

# LLM: run the reviewer, or preview the assembled prompt
yg aspect-test --aspect test-quality --node orders/handler
yg aspect-test --aspect test-quality --node orders/handler --dry-run

# LLM: measure how consistently the reviewer judges the SAME prompt
yg aspect-test --aspect test-quality --node orders/handler --repeat 5

# LLM: dry-fit the SAME pairs under a different named reviewer before a model swap
yg aspect-test --aspect test-quality --node orders/handler --tier premium
\`\`\`

Every run carries a one-line verdict stamp \`yg aspect-test:
satisfied|refused|incomplete|dry-run\` — leading on deterministic runs, as a
trailing summary after the per-unit lines on LLM runs (\`incomplete\` means some
unit could not be verified — fail closed, exit 1). Every run that produces a
result ends with the footer \`diagnostic only — lock unchanged; yg check judges
the lock against your files, not this run\`. On an LLM run against a tier with
consensus > 1, each per-unit line also carries the vote split \`[votes 2/3]\` —
how many of the passes were satisfied — so a bare-majority verdict is visible as
such. Exits 0 when clean, 1 on violations,
refusals, or an incomplete run. Aspect status never gates aspect-test: a draft
aspect runs here exactly like an enforced one (drafts stay dormant only in
\`yg check\` / \`--approve\`). Use \`--dry-run\` for a zero-cost prompt preview
while authoring; a run without \`--dry-run\` makes a real reviewer call.
\`--dry-run\` prints the assembled prompt(s) including resolved companions, runs
the companion hook live (if present), but makes no reviewer or LLM calls and
does not write the lock.
\`--check-determinism\` runs a deterministic check twice and fails if the
violation sets differ. If aspect-test repeatedly approves what the lock refuses,
the rule text is ambiguous — sharpen \`content.md\` (cascades; check
\`yg impact\`) or propose a \`yg-suppress\`; there is deliberately no
verdict-drop.
\`--repeat <N>\` (LLM aspects only, N >= 2) re-runs each unit N times against the
SAME prompt and reports a per-unit \`stability: k/N satisfied\` line — how often
the reviewer returned the same verdict. Each run is forced to consensus 1 (one
vote, no aggregation), so the figure measures the judge's raw self-consistency,
NOT correctness: a rule can be consistently wrong, and \`3/3 satisfied\` says
only that the reviewer agreed with itself, not that the code is right. The total
reviewer-call budget (\`repeat N × units\`) prints before the first call.
Provider-error runs are excluded from the k/N denominator and reported
separately; any single refused run marks the unit refused (exit 1), and a unit
whose runs ALL erred is incomplete (fail closed). \`--repeat\` is rejected with
\`--dry-run\` (no call to repeat), with \`--files\`, and for deterministic aspects
(a local check is already exactly reproducible — use \`--check-determinism\`
there). Use it while authoring an LLM rule to catch a prompt so ambiguous the
reviewer flips its own verdict run to run.
\`--tier <name>\` (LLM aspects only, with \`--node\`) re-runs the SAME pairs under
a named reviewer tier from the merged config (\`yg-config.yaml\` plus the local
\`yg-secrets\` overlay), OVERRIDING the tier the aspect would normally use — the
dry-fit for "does this still pass under the model I'm about to switch to?" It is
purely diagnostic: no graph edits, no lock writes. An unknown tier name is an
error listing the tiers that exist. \`--tier\` is rejected with \`--files\` and on
deterministic aspects, and MAY combine with \`--repeat\` (each of the N runs then
goes through the chosen tier).

Every LLM \`aspect-test\` run that actually calls the reviewer records one line of
LOCAL diagnostic telemetry — which reviewer judged the unit and how it voted —
appended to a gitignored sidecar under \`.yggdrasil/\`. A plain \`--node\` run,
\`--repeat\`, and \`--tier\` all record alike; \`--repeat\` just adds one line per
repeated run and \`--tier\` re-points which reviewer is recorded (\`--dry-run\`
makes no reviewer call, so it records nothing). It is write-only observability for
later judge-stability / model-swap analysis; nothing in \`yg check\` ever reads it
back, and the lock is never touched.

## yg drill

Re-run ONE aspect's rule over its per-aspect case corpus — a library of example
files whose directory prefix encodes the expected verdict — and report whether
the rule still behaves. A \`violates-*\` case MUST be refused; a \`satisfies-*\`
case MUST pass. Drills are REGRESSION FIXTURES for sharpening a rule, NOT a
sensitivity/specificity measurement: the committed case set is visible to the
author by definition. The lock is NEVER written.

\`\`\`bash
# Drill an aspect's in-repo corpus (aspects/<id>/drills/{violates-*,satisfies-*}/**)
yg drill --aspect no-direct-minimatch

# Run only matching case labels (repo-relative POSIX glob)
yg drill --aspect no-direct-minimatch --case 'violates-*/**'

# Drill against an EXTERNAL holdout corpus (data only — case files, never imported)
yg drill --aspect no-direct-minimatch --dir ../holdout-cases --corpus holdout-v1
\`\`\`

Corpus layout: each source file under a \`violates-*\` / \`satisfies-*\`
directory is one case; its label is the file's corpus-relative POSIX path with
the extension stripped (e.g. \`violates-namespace-import/star-minimatch\`).

Each case resolves to one of five outcomes:

- \`pass\` — the rule produced the expected verdict.
- \`MISS\` — a \`violates-*\` case the rule FAILED to refuse (the rule under-fires;
  a real hole).
- \`FALSE-ALARM\` — a \`satisfies-*\` case the rule wrongly refused (the rule
  over-fires).
- \`unrun\` — the case could not be evaluated (a check runtime error, or an LLM
  prompt over the tier's \`max_prompt_chars\`); infra, recorded, not scored.
- \`unsupported\` — the rule needs context a drill cannot supply (a deterministic
  check that reads graph context, or an LLM aspect that ships \`companion.mjs\`);
  a capability gap, recorded, never counted as pass/fail.

Deterministic aspects run locally and FREE. LLM aspects go through the same
production prompt path the reviewer uses and BILL the reviewer — the
reviewer-call budget (\`<L> LLM case(s) × consensus <c>\`) prints BEFORE the first
call. Exit is \`1\` on any MISS or FALSE-ALARM, else \`2\` if any case is unrun,
else \`0\`. Failure output shows only the corpus label, content hashes, and
pass/fail — never the case source. \`yg drill\` writes only a local, gitignored
results log (\`.yggdrasil/.drill-results.jsonl\`) plus, for LLM cases, one
telemetry line each; it never touches the verification lock. The doctrine "no
drill, no enforced" is advisory — a missing corpus never gates \`yg check\`.

## yg impact

Show blast radius before a change — which pairs an edit would invalidate.

\`\`\`bash
yg impact --node orders/handler        # dependents, flows, affected pairs
yg impact --file src/orders/handler.ts # pairs whose subject set includes this file
yg impact --aspect audit-logging       # all pairs of this aspect
yg impact --flow order-processing      # all pairs of nodes in this flow
yg impact --type service               # all nodes of this type + coverage
\`\`\`

For \`--node\`, the output ends with a one-line cost summary (\`Editing this node
re-verifies: N LLM pair(s) = M reviewer call(s); D deterministic = free; G
currently-green verdict(s) re-rolled\`). For \`--file\`, it ends with a precise
\`Total to re-verify:\` block -- billed reviewer calls, free deterministic pairs,
and currently-green verdicts re-rolled -- preceded by a per-node breakdown tagged
with why each node is affected (own pairs / references this file / companion
observes this file / deterministic check observes this file). To compute this
precisely even before the first fill, \`yg impact\` runs the companion resolver for
cold companion-backed pairs -- it makes no LLM call, never runs \`check.mjs\`, and
writes nothing. A companion whose hook fails is listed under \`Unresolved\` (cost
unknown; it will infra-fail at fill). Editing a graph file under \`.yggdrasil/\`
redirects you to \`yg impact --aspect <id>\`.

## yg tree

Browse the graph structure.

\`\`\`bash
yg tree                        # full tree from root
yg tree --root orders          # subtree from orders/
yg tree --depth 2              # limit depth
\`\`\`

## yg structure

Read-only structural dashboard over the graph. It reports the shape of your
dependencies in three sections:

- **Tunnels** — the dependencies that reach farthest across the hierarchy, each
  named with how many levels of the tree it jumps and whether it crosses through
  a declared contract.
- **Modules** — at each level of the tree, how the component groups depend on one
  another: how many groups, how many dependencies between them, and whether those
  dependencies all flow one way or some form a cycle.
- **Change reach** — from an average component, how much of the system is
  reachable by following dependencies.

The edges it reports are the union of your declared structural relations (calls /
uses / extends / implements) and the dependencies detected statically in the
source; event relations (emits / listens) are excluded. This is an instrument,
not a gate: it never reads or writes the lock, never calls a reviewer, and always
exits 0 as long as the graph loads — even when \`yg check\` is red. It only fails
to run when there is no graph to load.

\`\`\`bash
yg structure
\`\`\`

## yg aspects

List all aspects with usage counts and reviewer type. Output is a custom
human-readable line format, not YAML.

\`\`\`bash
yg aspects
yg aspects --health
\`\`\`

\`--health\` prints one row per aspect: **aspect** (id), **kind** (llm /
deterministic / aggregate), **status**, **nodes** and **pairs** (the review
surface — distinct nodes and total review units), **refused** (refusals whose
recorded result still matches the current code — a stale or never-checked unit is
excluded here), **suppresses** (live \`yg-suppress\` markers targeting this aspect;
wildcard markers are summarized on their own line, not attributed per-aspect), and
**errs** (a deterministic check's error-direction label), and **age** (how long
ago this aspect's rule source was first added to version control, as a coarse
duration such as \`3mo\` or \`1y\`, so you can weigh a rule's track record), and —
the newest columns — **catch** and **exposure** (how many times this rule has
actually refused a unit, against how many times a reviewer genuinely exercised it;
a cached re-render never counts, and the two reviewer kinds are counted separately
because their false-alarm behaviours differ), plus a plain-words read of how
confident that ratio is (few observations reads as a wide, honest uncertainty
range rather than a false-precise number), and a **label**: \`active\` (it is
catching things), \`quiet\` (little exercised), or \`decorative?\` (enforceable yet
never violated). A \`decorative?\` rule whose own examples still pass is reported as
*possibly deterring the very violations it would catch* rather than assumed
useless — and a rule is only ever suggested for demotion when several independent
signals agree, never on the catch count alone. Honesty
rule: when units have no valid result on record the **refused** cell reads
\`unverified\`, NEVER \`0\` — an unchecked unit is not a clean one; likewise **age**
reads \`unknown\` when that history is unavailable (a shallow clone or no
repository), never a fabricated \`0\`. The age lookup runs only in this view — the
plain \`yg aspects\` listing is unchanged. Read-only: it makes no changes and never
calls a reviewer.

## yg flows

List all flows with participants and aspects. Output is a custom
human-readable line format, not YAML.

\`\`\`bash
yg flows
\`\`\`

## yg owner

Find which node owns a source file.

\`\`\`bash
yg owner --file src/orders/handler.ts
\`\`\`

## yg find

Locate entry-point nodes/aspects by natural-language query.

\`\`\`bash
yg find "order cancellation"
yg find "authentication middleware"
\`\`\`

Returns ranked candidates. Scores are RELATIVE — the top result is always
\`1.00\` and the rest are its fraction, not an absolute confidence. A large
gap from #1 to #2 (e.g. \`1.00\` then \`0.40\`) signals a confident winner;
closely-clustered scores (\`1.00\`, \`0.95\`, \`0.90\`) mean the query is
ambiguous — verify the top few with \`yg context\`. \`yg find\` indexes nodes
and aspects only — not flows.

## yg log

Append and read per-node business-context log entries.

\`\`\`bash
yg log add --node orders/handler --reason "Added cancellation at billing cycle end"
yg log add --node orders/handler --reason-file entry.md   # multi-line reason from a file
yg log read --node orders/handler              # top 10 entries, newest first
yg log read --node orders/handler --top 5
yg log read --node orders/handler --all
yg log read --node orders/handler --with-verdicts   # interleave verification outcomes
yg log merge-resolve --node orders/handler     # after git merge with conflicting logs
\`\`\`

Use \`--reason-file <path>\` instead of \`--reason\` to supply multi-line entry
content from a file. On \`yg log read\`, \`--top\` and \`--all\` are mutually
exclusive — you cannot combine them.

\`--with-verdicts\` interleaves the node's recent verification outcomes with its
log entries into one newest-first timeline. The outcomes come from the local,
git-ignored telemetry \`yg check --approve\` records for every verdict; only this
node's own outcomes are shown (a verdict keyed by the node itself or by one of its
mapped files), under a \`local telemetry since <timestamp>\` header. The reader is
deliberately forgiving of that append-only telemetry — unknown line versions,
unfamiliar entry kinds, and malformed lines are skipped, not errored — so an older
or partially written file still reads. If the telemetry file has been committed
(git-tracked) the header drops the "local" wording and says so, since a tracked
file is shared history rather than local-only telemetry. Plain \`yg log read\` is
unchanged.

## yg advise

Read-only attention layer over the graph. With no subcommand, \`yg advise\` prints
two fixed sections and exits 0 whenever the graph loads (a graph that does not
load exits non-zero via the standard loader error). It **never** gates: it makes
no reviewer calls, writes no verdict, changes no exit code, and never appears in
\`suggestedNext\`.

\`\`\`bash
yg advise            # the two-section feed
yg advise --all      # remove the 10-item cap; also list dismissed / deferred items
yg advise --ids      # print each item's stable id (for dismiss / defer)
\`\`\`

- **Attention** — one aggregate line per class of signal, with no per-instance
  ranking (rankings stay inside the instrument commands like \`yg structure\`). In
  v1 the single class is dependency tunnels: how many dependencies reach across
  distant parts of the architecture.
- **Nominations** — up to ten ranked, evidence-backed suggestions in a fixed
  priority order: a regression case a rule no longer catches, a risky waiver, a
  rule effective nowhere, an orphaned rule, a rule past its review-by date, and —
  below all of those — history-derived suggestions such as promoting a clean-record
  advisory rule or sharpening an inconsistently-judged rule. Each item states WHAT
  it found, WHY (with the underlying repo text quoted verbatim as data with its
  provenance — never echoed as an instruction), and the exact human NEXT step,
  which always ends by noting it requires your approval. The list is capped at ten
  with a footer counting what the cap hid; \`--all\` removes the cap. Suggestions
  drawn from local history are labelled honestly when the evidence is thin.

The two acknowledgement subcommands act on a nomination's id (\`--ids\` prints it):

\`\`\`bash
yg advise dismiss <id> --reason "reviewed, keeping as-is"
yg advise defer <id> --until 2027-01-31 --reason "revisit next quarter"
\`\`\`

- **dismiss** hides the item until its underlying evidence changes. The decision
  is bound to the exact evidence the item carries right now, so the moment that
  evidence moves the item returns to the feed as new — a dismissal is never a
  permanent silence over a changed situation.
- **defer** hides the item until the given date, then it returns on its own.
  \`--until\` is a bare calendar day (\`YYYY-MM-DD\`); a date that is not a real day
  is rejected.

\`--reason\` is **mandatory** on every decision — recorded precedent must carry a
human-signed justification, so an empty reason is rejected and nothing is written.
An id that matches no current item is rejected with the list of current ids.
\`yg advise\` never changes a verdict, the lock, or whether \`yg check\` passes —
it only decides what the attention feed shows you.

Every dismiss and defer is recorded as one line in \`.yggdrasil/advise-decisions.jsonl\`.
That file is **committed** (not gitignored): the record is case law — a decision made
on one machine is honored on every clone, and the file carries a \`merge=union\`
attribute so two branches that each add decisions merge cleanly with no conflict.
Dismissing or deferring is **human-signature territory, the same authorization class
as \`yg-suppress\`**: the agent records a decision only on your explicit instruction and
with a reason you supply — it never dismisses or defers a nomination on its own.

**Cadence pattern (optional, for adopters).** A read-only, keyless job can publish the
feed on a fixed rhythm: a weekly CI workflow that runs \`yg advise --all\` and upserts a
single pinned issue gives you one place to review the attention items. This is a
**documented pattern to copy, not a shipped default** — \`yg init\` never scaffolds it,
and the feed never appears in \`yg check\`'s suggested next step.

## yg suppressions

Read-only inventory of all active \`yg-suppress\` markers in the repository's
source files. Lists each marker's aspect path, location, reason, and kind
(single-line, bracket, wildcard, or **file-level**). Exits 0 always — it is a
read-only inspection tool.

\`\`\`bash
yg suppressions
\`\`\`

Emits non-blocking warnings for:
- **Unknown aspect-id** — the aspect path in the marker does not match any known aspect.
- **Wildcard suppress** (\`*\`) — suppresses all aspects in range; any aspect added later is also silently waived.
- **Unbounded range** — a \`yg-suppress-disable\` marker with no matching \`yg-suppress-enable\`, placed below the file head; usually a forgotten closing \`yg-suppress-enable\`, so the suppression runs to end of file by accident.

A bare \`yg-suppress-disable\` with no matching \`yg-suppress-enable\` is the
sanctioned way to waive an entire file — but only when it sits at the top. When
the marker is within the first five lines of the file that carry any
non-whitespace text (blank lines do not count; a shebang and each header-comment
line do), the inventory classifies it \`file-level\`, lists it under that label,
and does **not** warn. Placed lower, the same unclosed marker reads as an
**Unbounded range** warning, since there it is usually an accidental omission.
This is a classification-and-reporting distinction only — what each reviewer
actually waives (the resolved suppressed line ranges) is identical either way.

Use \`yg suppressions\` to audit accumulated waivers before a release or a new aspect rollout. It does not affect \`yg check\` or the lock.

## yg type-suggest

Suggest which node_type a file fits based on architecture \`when\` predicates.

\`\`\`bash
yg type-suggest --file src/orders/handler.ts
\`\`\`

## yg knowledge

Browse embedded knowledge topics.

\`\`\`bash
yg knowledge list              # list all topics with summaries
yg knowledge read <name>       # print full topic content
\`\`\`

## yg schemas

Browse the embedded graph-element schema references — the field reference for
each graph element. Graph-independent: works without a \`.yggdrasil/\` present.

\`\`\`bash
yg schemas list                # list the schemas (node, aspect, architecture, config, flow)
yg schemas read <name>         # print one schema's field reference
\`\`\`

## yg init

Bootstrap or refresh \`.yggdrasil/\` setup. In a terminal with no flags it opens
an interactive wizard; every flag combination below also runs non-interactively
(Docker, devcontainer, CI) — flags are authoritative, so a fully-specified
command never opens the wizard, even from a terminal.

\`\`\`bash
yg init                        # interactive wizard (TTY only)
\`\`\`

**Fresh repo (no \`.yggdrasil/\` yet):**

\`\`\`bash
yg init --platform <name>                              # keyless bootstrap — no judge configured
yg init --platform <name> --provider <name> [--model <m>] [--endpoint <url>]   # bootstrap with a judge
\`\`\`

\`--platform <name>\` alone scaffolds the graph and installs that platform's
rules file with no \`reviewer:\` section at all. Script rules, dependency
control, and the CI gate all work immediately, at zero cost and with no API
key. Add \`--provider\` (same command, or a later \`yg init --provider ...\` on
the now-existing repo) to configure a judge once a judgment (LLM) rule exists.
A non-interactive run naming no \`--platform\` errors with guidance rather than
guessing which agent platform to install.

**Existing repo (\`.yggdrasil/\` already present):**

\`\`\`bash
yg init --provider <name> [--model <m>] [--endpoint <url>]   # configure/replace the judge
yg init --platform <name>                                    # switch the platform rules file
yg init --upgrade --platform <name>                          # refresh rules/platform files + .gitattributes; lift version bookkeeping
\`\`\`

Any combination of \`--provider\` and \`--platform\` may be given together; each
flag applies its own operation independently (configure the judge, switch the
platform, or both). With neither flag and a TTY, the interactive
reconfiguration menu opens (upgrade / configure reviewer / change platform);
with neither flag and no TTY, the command reports that there is nothing to do
and lists the available flags rather than guessing.

\`--provider\` on an existing repo REPLACES the entire \`reviewer:\` section — it
writes a single \`standard\` tier from the given flags, it does not merge into
or preserve an existing hand-authored multi-tier config. If the repo already
has more than one named tier (e.g. a cheaper tier for bulk checks alongside a
stronger one for hard aspects), running \`yg init --provider ...\` discards
that setup; edit \`yg-config.yaml\`'s \`reviewer.tiers\` by hand instead to keep
multiple tiers.

**Model and endpoint defaults:** \`--model\` defaults to \`sonnet\` only for
provider \`claude-code\`; every other provider (\`codex\`, \`gemini-cli\`,
\`ollama\`, \`anthropic\`, \`openai\`, \`google\`, \`openai-compatible\`) requires
\`--model\` explicitly — there is no universal default. \`--endpoint\` defaults to
\`http://localhost:11434\` for \`ollama\` only; \`openai-compatible\` has no default
endpoint and requires \`--endpoint\`. \`--model\`/\`--endpoint\` without
\`--provider\` is an error (nothing to configure).

**Credentials are env-only, never a flag.** There is no \`--api-key\` (or
similarly-named) flag. An API provider's key is read only from its own
environment variable (\`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`,
\`GOOGLE_API_KEY\` — \`openai-compatible\` also reads \`OPENAI_API_KEY\`) at
init time. A missing key is non-fatal: the config is written anyway and can be
fixed later by exporting the variable (or editing \`yg-secrets.yaml\`) before
\`yg check --approve\`. This keeps API keys out of shell history — there is no
flag-based alternative to set a credential, by design.

\`yg init\` maintains \`.gitattributes\` so the committed lock files
(\`yg-lock.*.json\`) are marked \`linguist-generated\`. Run from repository root only.
Never from a subdirectory.

## Validator issue codes — verification and status

The validator (\`yg check\`) emits the following issue codes:

| Code | Severity | Meaning |
|------|----------|---------|
| \`unverified\` | error (enforced) / warning (advisory) | Expected pair has no valid verdict. Next: \`yg check --approve\`. |
| \`aspect-violation-enforced\` | error | Enforced aspect refused (valid refused lock entry — cached) |
| \`aspect-violation-advisory\` | warning | Advisory aspect refused |
| \`aspect-check-runtime-error\` | error (\`--approve\` report) | \`check.mjs\` failed to import/run at fill time — fail closed; plain check shows the pair as \`unverified\` |
| \`aspect-companion-without-content\` | error | \`companion.mjs\` present without \`content.md\` — companion files require an LLM aspect |
| \`aspect-companion-with-check\` | error | \`companion.mjs\` present alongside \`check.mjs\` — companion files are an LLM add-on only |
| \`aspect-companion-runtime-error\` | error (\`--approve\` report) | \`companion.mjs\` failed to resolve/run at fill time (hook threw, bad return shape, missing path, path outside allowed-reads, or observations stayed inconsistent) — fail closed; plain check shows the pair as \`unverified\` |
| \`prompt-too-large\` | error | Assembled prompt exceeds the resolved tier's \`max_prompt_chars\` |
| \`lock-invalid\` | error | Lock unparseable, garbled, conflict-markered, or unknown version — fail closed |
| \`relation-undeclared-dependency\` | error (always) | Built-in relation-conformance check: node depends on another node's code without a declared, sanctioned relation. Not an aspect — not status-governed, not suppressible. Next: declare the relation in \`yg-node.yaml\` or remove the dependency. |
| \`log-entry-missing\` | error | \`--approve\` log gate fired |
| \`aspect-status-invalid\` | error | Declared status is not one of \`draft\\|advisory\\|enforced\` |
| \`aspect-review-by-malformed\` | error | Declared \`review_by:\` is present but not a calendar-valid bare ISO date (\`YYYY-MM-DD\`; e.g. \`2027-13-40\` or \`2027-02-30\`). Blocking parse-time error, fired ONLY on the aspect that carries the field. |
| \`aspect-review-overdue\` | warning | A rule's standing \`review_by:\` date has passed (compared against the CLI clock) — the rule is running unreviewed. Status-independent. Never writes the lock, changes a verdict, or gates \`--approve\`. Next: ask the user to renew (new \`review_by:\`) or retire (demote) the rule; never change the date without their approval. |
| \`aspect-status-downgrade\` | error | Declared status is lower than cascade would yield (bump up OK, downgrade is error) |
| \`implies-status-inherit-invalid\` | error | \`status_inherit:\` value not one of \`strictest\\|own-default\` |
| \`aspect-effective-nowhere\` | warning | Dead-attach linter: an aspect that ships a rule source (\`content.md\` or \`check.mjs\`) and is not draft, yet is effective on ZERO nodes after the full cascade + every \`when\` — a rule that looks enforced but is never verified anywhere. Silent while the model has no nodes. Next: \`yg impact --aspect <id>\`; fix the attach sites / \`when\`, or set \`status: draft\` until the node/type it targets exists. |

For detailed semantics of status: \`yg knowledge read aspect-status\`. For the lock,
verification, and caching: \`yg knowledge read verification-and-lock\`.
`;
