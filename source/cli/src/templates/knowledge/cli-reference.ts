export const summary =
  'Full yg command reference: check, check --approve, context, aspect-test, drill, impact, tree, aspects, flows, find, log, owner, type-suggest, init, prime, knowledge, schemas, simulate, structure, advise, incident, suppressions, portal';

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

### \`--full\`: report the whole project

A project can name a branch that changes are measured against (the
\`progressive\` block — see \`yg schemas read config\`). When it does, a plain
\`yg check\` blocks only on what the current change is accountable for;
everything it inherited from that branch is still listed and still counted, as a
warning that does not fail the build. The header says how much sits outside the
change and what it was measured against.

When progressive mode is on, a run that RECORDS verdicts — \`--approve\`, or a
bare run on a project configured to approve automatically — is measured the same
way: it reports what a plain run reports, and it reviews only the rules the
current change is accountable for. It says how many reviewed rules it left
outside the change; \`yg check --full --approve\` is what reviews those. Checks
that run locally still cover the whole project, because they cost nothing.

One thing a recording run still answers for whole: if a component's type
requires a log entry and its source has moved past the entry its log records,
the run stops and asks for that entry — whoever moved the code. So a plain read
can PASS while \`--approve\` stops on a component the current change never
touched. That is not a contradiction: the read is telling you what your change
is answerable for, and the recording run is refusing to record over an edit
nobody described. Add the entry it names; do not re-run until it goes green.

\`\`\`bash
yg check --full            # answer for the whole project: everything blocks again
\`\`\`

Unlike the views above this one is NOT a triage view: it hides no finding, and
it combines freely with \`--approve\` and with any other flag. It only ever
tightens the gate — it can turn an inherited finding back into a blocking one,
never the reverse. On a project that names no branch there is nothing to measure
against, so every run already answers for the whole project and this flag
changes nothing at all.

An inherited finding is a finding, not someone else's problem: it is
non-blocking because this change did not cause it, never because it stopped
mattering. Do not silence one, and do not clear a pile of them under cover of an
unrelated change — \`yg check --full\` is how you look at all of it deliberately.

One consequence to plan a pipeline around, true whenever progressive mode is on:
ON THE BRANCH BEING MEASURED AGAINST, a plain \`yg check\` has nothing in scope —
nothing changed relative to it — so it reports every eligible finding as outside
the change and PASSES, however much is outstanding there. That is what measuring
against a branch means, not a threshold anyone can tune, and it is why the
integration leg must be \`yg check --full\`: it is the only run that answers for
that branch. What still blocks there: the graph's own integrity (an undefined
rule, a cycle, an unreadable file) and any finding the run could not attribute to
a file or component — neither is ever narrowed by the measurement.

### Silent structural-deviation index (attention only)

As a byproduct, a plain \`yg check\` also maintains a local, gitignored
\`.yggdrasil/.feature-field.json\`: a sparse list of source files that look
structurally unusual among their node's OTHER same-language files (measured on
the per-file structural counts the relation pass already computes — size,
nesting, and the six category counts). It is pure ATTENTION: it is NEVER an
issue, an exit code, or a suggested next step; it never gates \`yg check\`, and
it is computed from the warm parse cache at no extra cost. The write is
best-effort — a failure to write it never fails a check. Only the reporting
read path maintains it; \`--approve\`, \`--dry-run\`, and the internal fill
re-checks leave it untouched.

\`\`\`bash
yg check --attention-dump   # hidden: print the raw measurements, then exit 0
\`\`\`

\`--attention-dump\` is a calibration instrument: it prints each file's raw
structural counts grouped by node and language, marks the outliers "worth a
closer read", and exits 0. It runs over the warm cache (no new parse), writes
NOTHING, and makes no reviewer calls.

### \`--json\`: the run as one machine document

\`yg check --json\` prints one \`yg-check/1\` document on stdout instead of the
report — for a layer above the agent (a build step deciding what to schedule, a
dashboard, a release gate computing a quality index) that must never learn a
fact by parsing prose written to be read.

It carries what the report says: the project's counts, the exit code AND the
reason for it, coverage (files, covered, and whether anything is required to be
covered at all), totals by severity and by verdict, EVERY expected pair, every
finding as structured \`what\`/\`why\`/\`next\`, who judged outside the
configured reviewer, the standing floor when the project measures changes
against a branch, and \`suggestedNext\`.

Per pair: the rule, the subject (\`unit\`), the effective \`status\` that decides
whether a finding blocks, what the lock says (\`verdict\`), who answers
(\`reviewer\`: \`deterministic\` for a local check, the judge's name for a
verdict recorded outside the configured reviewer, otherwise the reviewer tier),
and the \`hash\` the verdict is bound to. \`unverified\` and \`stale\` are
SEPARATE here — never judged, versus judged over code that has since moved. Both
block; the report spends one word on both, a scheduler wants the difference.

Composes with the fill flags; every exit code is unchanged. Under \`--json\`
stdout carries the document ALONE — even \`--dry-run\`'s cost preview moves to
stderr. REFUSED with \`--top\`, \`--summary\`, \`--details\` and \`--aspect\`:
those narrow the text report, the document always carries the whole run, and a
trimmed document would read as a smaller problem rather than a smaller
rendering. Fields may be added within \`yg-check/1\`; only a change to an
existing field's shape takes a new schema number.

## yg check --approve

Fill every unverified pair the run answers for, then report. The only writer of verdicts (alongside
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

Verification is all-or-nothing: a run fills every pair it is answering for, or
(when the mandatory-log gate stops it) nothing at all. By default it answers for
the whole project. When progressive mode is on, it still runs every free
deterministic check project-wide but buys reviewer work only for the rules the
current change is accountable for, and names how many it left — see \`--full\`
above. \`--only-deterministic\` is a different lever again, and the only one that
is free: it runs the deterministic fills only (no LLM, no key) and
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

## yg adopt

Accept a proposed graph into this repository — the one step that turns a
proposal into the graph that governs the code.

\`\`\`bash
yg adopt <proposal-dir>
yg adopt <proposal-dir> --dry-run
yg adopt <proposal-dir> --replace
\`\`\`

\`<proposal-dir>\` is the staging directory a generator wrote (Grain writes
\`.yggdrasil-proposal/\` at the repository root by default) or the \`.yggdrasil/\`
directory inside it. Nothing else is accepted, and the command never searches
upward for a graph — so it can never propose to adopt this repository's own
graph over itself.

The steps, in order, and the whole thing is a transaction:

1. **Refuses to merge.** With a graph already here it stops and says what is
   there — components, rules, flows, and whether verdicts have been recorded
   against it. \`--replace\` accepts over it; the existing graph is MOVED ASIDE to
   \`.yggdrasil.replaced-<timestamp>/\`, never deleted.
2. **Checks that the proposal loads** with the same reader every \`yg check\`
   uses, and validates it. Blocking problems are named by code and nothing is
   moved. The checks that need the repository's own files (mapping paths,
   reference files) run again the moment the graph is in place; a failure there
   rolls the acceptance back and the repository is exactly as it was.
3. **Moves it into place**, and writes the \`.yggdrasil/.gitignore\` and the
   repo-root \`.gitattributes\` a fresh setup writes, so the local verdict cache
   is ignored from the first run.
4. **Records the acceptance** as a log entry on the graph's top component —
   what was accepted, from which proposal, at which commit, how many rules
   arrived at each status, and that it was mined rather than hand-written when
   the proposal says so.
5. **Baselines every rule that runs locally** — the same free, keyless fill
   \`yg check --approve --only-deterministic\` performs — so the first check is
   not a wall of unverified rules.

Then it prints what was accepted: the component/rule counts split by status, the
origin, HOW MANY SITES IN THE CODE ALREADY HERE the new rules refuse today
(\`existingViolations\` from each rule's own \`provenance.json\`, when the proposal
carries one — a graph can be perfectly well-formed and still refuse hundreds of
existing files, because a mined rule earns its status from how the code is
usually written, not from a check that the repository is clean), whether a
reference branch is configured (so a rule blocks only on what a change reaches),
where the acceptance was recorded, and where a replaced graph was kept.

\`--dry-run\` reports all of that and writes nothing at all. Exit 0 on acceptance
(the state of the graph afterwards is \`yg check\`'s business, not this command's),
1 on any refusal.

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

The file form may also end with ONE advisory line when the file is a structural
OUTLIER among its node's other same-language files:

\`\`\`
This file is structurally unusual among this node's other TypeScript files — worth a closer read; no action required.
\`\`\`

It is pure attention (drawn from the silent \`.feature-field.json\` index above),
never a rule and never blocking — \`yg context --file\` still exits 0. It appears
ONLY when the local index still describes the file's exact current bytes, so a
file edited since the last \`yg check\` stays silent (a stale index never speaks).
It is ON by default; silence it with \`signals: { attention: false }\` in
\`yg-config.yaml\` (\`signals\` is an optional mapping — its only key today is
\`attention\`, which must be a boolean).

\`--json\` renders the SAME package as one \`yg-context/1\` document on stdout
instead of the text view, for a tool rather than a reader — it works with both
\`--file\` and \`--node\`, and every exit code and every diagnostic (still on
stderr) is unchanged. The document names the subject, its \`owner\`, the
\`chain\` it inherits along nearest-first (a component and its type per link;
\`node: null\` plus a type for a file governed by its architecture type alone),
and every effective rule with its \`id\`, effective \`status\`, reviewer \`kind\`,
\`name\`, \`description\`, the \`channels\` it arrived through (numbered cascade
channel plus a machine origin such as \`type:command\` or \`flow:checkout\`), any
\`impliedBy\`, and its \`read\` paths. Every outcome answers in that form: a
type-covered file reports \`owner.kind: "type"\` with the chain-termination
sentence and a \`dropped\` list, a file no node maps reports
\`owner.kind: "none"\` with \`reason: "unmapped"\` (exit 1), and a path never
scanned reports the same shape with \`reason: "excluded"\` (exit 0). Under
\`--json\` stdout carries that document ALONE — the owner line is suppressed and
the attention sentence above becomes an \`attention\` field. Fields may be added
within \`yg-context/1\`; only a change to an existing field's shape takes a new
schema number.

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

# Drill an LLM aspect's cases in the shape a file with NO owning component
# receives (the prompt omits <node> entirely) instead of the default
# synthetic node — --nodeless has no effect on a deterministic aspect
yg drill --aspect has-doc-comment --dir .yggdrasil/aspects/has-doc-comment/drills/nodeless --nodeless --corpus nodeless-v1
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

## yg simulate

Replay a candidate DETERMINISTIC rule over the history it can honestly reach, to
answer "if I had shipped this rule, what would it have caught?" It replays the
candidate's \`check.mjs\` over recent commits in an ISOLATED temp clone — one fresh
subprocess per commit — strictly read-only. The real working tree is left
byte-for-byte unchanged.

\`\`\`bash
# Replay an existing deterministic rule over a node, across the most recent commits
yg simulate no-raw-sql --node data/repository

# Widen (or narrow) the window of most-recent commits considered (default 20)
yg simulate no-raw-sql --node data/repository --max-commits 50
\`\`\`

The \`<candidate>\` is the id of an aspect in this project that ships a \`check.mjs\`;
\`--node\` is the node whose files the candidate replays over at each commit. Each
commit resolves to one of three first-class outcomes — never a silent zero:

- \`ran-clean\` — the candidate ran and found nothing at that commit.
- \`violations (N)\` — the candidate refused N of that commit's files.
- \`non-comparable\` — the commit could not be honestly compared: it PRE-DATES
  \`yg init\` (no graph of its own), or its committed graph schema differs from the
  current one (it would need a migration this replay never performs). Reported
  explicitly, so a commit the replay could not reach never reads as a clean pass.

Guarantees that make the replay trustworthy: every checkout and the candidate
overlay happen in the throwaway clone (never in your tree); a clone-boundary guard
refuses to let the graph resolver escape the clone, so a pre-init checkout is
\`non-comparable\` rather than silently the real graph; only the candidate rule is
overlaid; and only commits whose committed schema EQUALS the current one are
replayed. An LLM- or companion-reviewed candidate is refused up front — a
language-model verdict is point-in-time testimony, not a reproducible replay; use
\`yg drill\` to test an LLM rule's falsifiability instead.

\`yg simulate\` is a REPORT tool: it exits \`0\` whatever it finds (a finding never
gates), and prints a survivorship-bias caveat — the old rule gate already refused
code that never landed, so a tightening replay is a LOWER bound on true catches and
a loosening one an UPPER bound. Only a precondition failure on the real project (no
graph, missing candidate, wrong candidate kind, or an inability to clone) exits
non-zero. It never writes the lock and never changes whether \`yg check\` passes.

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
observes this file / deterministic check observes this file / may observe this file
(cold-start)). To compute this
precisely even before the first fill, \`yg impact\` runs the companion resolver for
cold companion-backed pairs -- it makes no LLM call, never runs \`check.mjs\`, and
writes nothing. A companion whose hook fails is listed under \`Unresolved\` (cost
unknown; it will infra-fail at fill). Editing a graph file under \`.yggdrasil/\`
redirects you to \`yg impact --aspect <id>\`.

\`--json\` renders the component modes -- \`--node\`, and \`--file\` once it has
resolved the owning component -- as one \`yg-impact/1\` document on stdout instead
of the text report, for a tool rather than a reader. The document names the
\`subject\`; every port the component publishes under \`ports\` with that port's
\`version\`, \`test\` and the \`consumers\` that name it in a \`consumes:\` list;
every component that depends on it under \`dependents\`, each marked \`direct\`
(it declares a relation onto the subject, and \`relations\` names each relation's
type and the ports it consumes) or not (reached through other components, so
\`relations\` is empty); and, under \`transitive\`, each indirect dependent with
the \`via\` path it is reached through. Both target forms produce the SAME
document for the same component, byte for byte: stdout carries it alone, so the
owner-resolution line \`--file\` normally prints is suppressed and every redirect
that produces no document (a graph file, a path excluded by design, a file no
component owns) moves to stderr with its exit code unchanged. A \`--json\` run
that already has its component also skips the per-pair cost enumeration -- cost
is the text report's job, not the document's. \`--json\` is REFUSED for
\`--aspect\`, \`--flow\` and \`--type\`: their subject is not a component, and a
second document shape must not hide behind the same schema tag. Fields may be
added within \`yg-impact/1\`; only a change to an existing field's shape takes a
new schema number.

## yg node

Show one component's STRUCTURE -- what it is, not what it must satisfy.

\`\`\`bash
yg node orders/order-service          # text view, for a person
yg node orders/order-service --json   # one yg-node/1 document, for a tool
\`\`\`

Both views carry the same facts from the same document: the component's name,
type and description; the files it owns (\`mapping\`); the components it declares
a dependency on (\`relations\`, each with the ports it \`consumes\`); the ports it
publishes (\`ports\`, each with its \`description\`, contract \`version\`, contract
\`test\`, and the \`aspects\` a consumer of that port must satisfy); and where it
sits in the hierarchy (\`children\`, \`parent\`).

It carries NO rule set on purpose. What a subject must satisfy is
\`yg context\`'s answer -- assembled from the full seven-channel cascade, with
each rule's effective status -- and a partial copy here would give you two
places to learn one fact and one of them to get wrong. A port's \`aspects\` is
not that: it is the contract the port declares onto its consumers, part of the
component's own structure.

A path naming no component is refused with what/why/next and exit 1. Fields may
be added within \`yg-node/1\`; only a change to an existing field's shape takes a
new schema number.

## yg verdict

The external-judge channel. A judge outside the configured reviewer — a person,
or another tool already reading the change — takes the exact package a provider
would have received, decides, and records that decision under its own name,
bound to the same content hashes any verdict is. Use it where a prose rule has
to be settled and no provider is configured or reachable.

\`\`\`bash
yg verdict package --aspect <id> --node <path>   # or --file <path>
yg verdict record  --aspect <id> --node <path> --by <name> --verdict pass --hash <sha>
yg verdict record  --aspect <id> --node <path> --by <name> --verdict refused \\
  --report "<what is wrong and where>" --hash <sha>
yg verdict read [--by <name>] [--json]
\`\`\`

\`package\` prints one \`yg-review/1\` document — the rule's own text, the
subject files, any references and resolved companions, the tier's CONSTRAINTS
(name, consensus, prompt ceiling and this package's size; never the provider,
the model or a credential), and \`hashes\` with one entry per verdict token. It
is the SAME assembly the fill stage sends a provider, so what a judge sees and
what a filled verdict was judged on cannot drift apart.

\`record\` writes the judgement into the lock exactly as a provider verdict is
written, plus the judge's name. \`--hash\` is the hash from the package for the
verdict being recorded; if the working tree moved since, it is REFUSED rather
than re-bound. A refusal requires \`--report\` (or \`--report-file\`).

Recording is NOT approving. It fills one pending pair; \`yg check --approve\`,
\`yg-suppress\` and every status rule are untouched. \`yg check\` then treats the
verdict like any other: re-proved by hashing (no key, no judge), dropped the
moment the code it judged changes, and attributed — a standing line naming each
judge and how many pairs are theirs, plus the judge's name on the refusal
itself.

Four refusals, each with a reason: a rule that runs as a local check is
machine-only (run it free with \`yg check --approve --only-deterministic\`); a
pair already holding a verdict for exactly these inputs is not pending; a hash
that no longer matches means the judgement would attach to code the judge never
saw; a refusal with no report leaves the author nothing to fix.

\`read\` lists what has been recorded this way and whether each verdict still
holds — as text, or as a \`yg-verdicts/1\` document under \`--json\`.

## yg tree

Browse the graph structure.

\`\`\`bash
yg tree                        # full tree from root
yg tree --root orders          # subtree from orders/
yg tree --depth 2              # limit depth
\`\`\`

With \`coverage.type_level\` on, a summary line follows the node listing naming
how many files the type-level lattice satisfies with no component of their
own — never a synthetic tree entry (the listing above stays nodes only). The
count is always repo-wide, even under \`--root\`: a type-covered file has no
place in the graph hierarchy for that flag to narrow, so the line says
"repo-wide" instead of fabricating a scoped count. The total splits into how
many are actually checked by at least one rule, how many matched a type with
nothing that applies, and — only when it occurs — how many hit an aspect
\`implies\` cycle that stopped their type's rules from ever resolving, so the
bare total is never mistaken for "all of these are enforced." Absent when the
flag is off.

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

With \`coverage.type_level\` on, the universe widens: every statically-resolved
import touching a type-covered file joins it too (named by the file's own
path — it has no component id), and the change-reach line says "component or
type-covered file" instead of "component" so a file is never misnamed. The
Modules heading widens the same way, from "component groups" to "groups of
components and type-covered files", whenever the project has at least one
type-covered file at all — not only once one actually turns up among the
rendered groups, so it can print over "No dependencies between groups yet."
too, with zero groups shown. The
Tunnels ranking measures a type-covered file at a fixed, shallow depth rather
than its own on-disk directory nesting, so a deeply-nested file's edge can no
longer crowd out a genuine cross-module dependency just for living many
directories down. A malformed \`when:\` predicate degrades this widening to
the node-only view rather than crashing — flag off (or zero type-covered
files) renders exactly today's output.

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
signals agree, never on the catch count alone. The next column, **fp**, is the
false-block signal — how many of this rule's refusals a human LATER waived or
overturned (a live \`yg-suppress\` waiver now covers the refused code, or the block
was re-approved after a waiver moved rather than a genuine code fix — a real fix,
with no waiver, never counts). It is a COUNT with a plain-words small-sample label,
never a bare rate, and — like every signal here — never a gate: it feeds a human
retirement ritual (the false-block budget — each rule debits the repo by its shrunk
false-block rate, and retiring the worst offenders makes room for new rules), never
an automatic block. The last column, **wrong-rule**, is the per-rule incident join:
how many committed \`wrong-rule\` incidents name THIS rule via
\`yg incident add --aspect\` — an honest COUNT always carrying a \`(thin data)\` label,
because incident testimony is sparse and qualitative (there is no exposure denominator
to outgrow thin-ness). A \`wrong-rule\` incident recorded WITHOUT \`--aspect\` counts in
the \`yg advise\` aggregate but never surfaces per-rule here. Honesty
rule: when units have no valid result on record the **refused** cell reads
\`unverified\`, NEVER \`0\` — an unchecked unit is not a clean one; likewise **age**
reads \`unknown\` when that history is unavailable (a shallow clone or no
repository), never a fabricated \`0\`. The age lookup runs only in this view — the
plain \`yg aspects\` listing is unchanged. Read-only: it makes no changes and never
calls a reviewer.

### \`yg aspects --json\`

The rule INVENTORY as one \`yg-aspects/1\` document: per rule, its \`id\`,
\`name\`, \`description\`, reviewer \`kind\` and \`tier\`, \`status\`,
\`reviewBy\`, \`errs\`, \`implies\`, the \`usage\` it reaches (nodes, and the
channel each attachment came through, plus type-covered files) and its
\`drills\` corpus size (violates / satisfies / total — COUNTED, never run).
\`--health\` is a different and far more expensive projection and is refused
together with \`--json\` rather than folded into the same schema.

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

Locate entry-point nodes/aspects/type-covered files by natural-language query.

\`\`\`bash
yg find "order cancellation"
yg find "authentication middleware"
\`\`\`

Returns ranked candidates. Scores are RELATIVE — the top result is always
\`1.00\` and the rest are its fraction, not an absolute confidence. A large
gap from #1 to #2 (e.g. \`1.00\` then \`0.40\`) signals a confident winner;
closely-clustered scores (\`1.00\`, \`0.95\`, \`0.90\`) mean the query is
ambiguous — verify the top few with \`yg context\`. \`yg find\` indexes nodes
and aspects, plus type-covered files once \`coverage.type_level\` is on — not
flows.

With \`coverage.type_level\` on, a file satisfied by the type-level lattice (no
node of its own) is searchable too — its result prints \`Kind: file\`, a
\`Type:\` line naming the matched classifying type, and a \`Description\` taken
from that type's own description. \`yg find\` prints one terminal \`Next\` line
for the whole search, drawn from the single top-ranked result: when that
result is a type-covered file, \`Next\` reads \`yg context --file <path>\`,
never \`--node\` — a type-covered file has no \`yg-node.yaml\` to look up. When
a node or an aspect outranks the file, the file still appears in the list
with its own \`Kind\`/\`Type\`/\`Description\`, but \`Next\` follows the
higher-ranked entry instead.

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
git-ignored telemetry \`yg check --approve\` records for every verdict, unioned
with any events a committed shared stream contributes (older CLIs wrote verdicts
there before the local telemetry existed; when it contributes, a second line
reports how many events and why). Only this node's own outcomes are shown —
attributed by REAL ownership, the same hierarchy-first, exclusion-aware answer
\`yg owner --file\` gives, never by whether a path merely falls inside one of the
node's mapping strings: a directory-mapping ancestor's mapping text also
textually covers a descendant's own file, and text has no notion of an
exclusion, so neither a descendant's outcome nor an excluded file's outcome is
ever attributed to an ancestor. This is printed under a \`local telemetry since
<timestamp>\` header. The reader is deliberately forgiving of that append-only
telemetry — unknown line versions, unfamiliar entry kinds, and malformed lines
are skipped, not errored — so an older or partially written file still reads.
If the telemetry file has been committed (git-tracked) the header drops the
"local" wording and says so, since a tracked file is shared history rather than
local-only telemetry. Plain \`yg log read\` is unchanged.

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
  ranking (rankings stay inside the instrument commands like \`yg structure\`, and
  per-file detail stays in \`yg context\`). A structural class with a zero count prints
  no line; the incident reality-counter is the one exception — always shown. The classes:
  - **incidents on record** — the running count from the committed incident ledger,
    the only signal from OUTSIDE the graph. Always shown, even at 0, so the tower stays
    aware it has an outside reference at all; when any incident is tagged \`wrong-rule\`
    an extra line notes the rules themselves may be miscalibrated. See \`yg incident\`.
  - **dependency tunnels** — how many dependencies reach across distant parts of the
    architecture (run \`yg structure\` to see them).
  - **structural deviations** — how many files look structurally unusual among their
    same-language neighbours, counted only while the local structural index still
    describes each file's exact current contents (a file edited since the last check
    is not counted). It is a bare count that points you at \`yg context\` for the
    per-file note; it lists no files, names no measures, and ranks nothing.
- **Nominations** — up to ten ranked, evidence-backed suggestions in a fixed
  priority order: a regression case a rule no longer catches, a risky waiver, a
  rule effective nowhere, an orphaned rule, a rule past its review-by date, and —
  below all of those — history-derived suggestions such as promoting a clean-record
  advisory rule, sharpening an inconsistently-judged rule, reviewing a rule that has
  never once caught a violation, and flagging an **uncovered hot spot**: a component
  whose files change often across recent commits yet carry no enforced rule — the
  code most in motion with the least protection. A hot spot cites its churn count, a
  short sample of the changed files, and the commit window as its evidence, and clears
  itself the moment a rule or coverage lands there or the churn ages out of the
  window; the churn is read from git history, so a shallow or non-git checkout simply
  omits the class rather than guessing.

  Once a project turns on type-level coverage — treating an otherwise uncovered file
  as covered by matching an architecture type directly, no component required — the
  same churn signal also flags a **churning file the type tier alone carries**: such a
  file has no component of its own, so no node-level rule can ever attach to it —
  whatever enforcement it gets comes from its matched type alone. It fires once a file
  clears TWO conditions together: it appears in at least two of the last 200 commits —
  the identical window and git read the hot spot above already uses, so the same
  shallow-or-non-git silence applies here too, a busy file going as quiet as an
  untouched one — and its matched type genuinely enforces something on it; a file
  whose matched type enforces nothing is simply uncovered, not carried by anything, so
  it never appears here. Items rank by how much they have churned, busiest first. Two
  or more such files of the same type that import each other, each clearing both
  conditions on its own, upgrade the evidence from one busy file to a cluster naming
  every file in it — a partner that fails either condition is never named as carrying
  weight.

  Below even those sit two further suggestion classes:
  - **a candidate rule family** — a tight group of near-identical files that share no
    rule of their own, discovered by the offline structural-clustering pass and read
    from its local suggestions file. The item names the member files, the fitted scope
    pattern and its tightness (all quoted as data with the analysis timestamp as
    provenance), and proposes drafting a rule for exactly that scope — the rationale is
    always yours to supply, never invented. It appears only while the suggestions file
    is fresh for the current structural-analysis format; a moved format omits it rather
    than showing a stale group.
  - **an architecture cut** — two or more module groups that depend on each other in a
    loop, read straight from the committed graph's declared dependencies (so the same
    graph gives the same answer on any machine). The item names the groups plainly and
    proposes either a cut or a contract across the boundary. A loop is reported once, at
    the coarsest level it appears.

  Each item states WHAT it found, WHY (with the
  underlying repo text quoted verbatim as data with its provenance — never echoed as
  an instruction), and the exact human NEXT step, which names a human action requiring
  your sign-off. The list is capped at ten with a footer counting what the cap hid;
  \`--all\` removes the cap. That cap is shared across all classes — the two suggestion
  classes above compete for the same ten slots, they do not add their own. Suggestions
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

## yg incident

The **incident ledger** — a committed record of what escaped enforcement and how it
surfaced. It is the only signal that comes from OUTSIDE the graph: every other layer
(\`yg check\`, \`yg advise\`, catch/exposure health, structural attention) is the graph
reasoning about itself; an incident is a human recording a real miss. Recording one is
**human-signature territory, the same authorization class as \`yg-suppress\`**: an agent
records an incident only on your explicit instruction, with a tag and reason you supply —
it never invents one.

\`\`\`bash
yg incident add --tag wrong-rule --reason "a UI file reached the DB and no rule caught it"
yg incident read     # list recorded incidents (datetime + cause), oldest first
\`\`\`

The \`--tag\` names the CAUSE and is **mandatory** — one of \`no-rule\` (a concern shipped
with no rule at all), \`wrong-rule\` (a rule existed but was miscalibrated), \`judges-blind\`
(the reviewer could not see what mattered), \`single-judge-miss\` (a lone judge missed what
a panel would have caught), or \`not-enforcement\` (the escape was not an enforcement gap).
An unrecognized tag is rejected with the valid list and nothing is written. \`--reason\` is
also mandatory: the entry must say what escaped and how it surfaced.

\`--aspect <id>\` is **optional** and attributes the escape to one existing rule — mainly a
\`wrong-rule\` incident naming the miscalibrated rule. The id must name a declared aspect; an
unknown id is rejected exactly like an unknown \`--tag\` (with guidance, nothing written). When
given, the attribution is recorded on the entry and that rule's own \`wrong-rule\` count
surfaces in the **wrong-rule** column of \`yg aspects --health\`. Honesty boundary: a
\`wrong-rule\` incident recorded WITHOUT \`--aspect\` still counts in the \`yg advise\` aggregate
below, but names no rule and never surfaces per-rule.

Each \`add\` appends one \`## [<ISO UTC>] <tag>\` block to \`.yggdrasil/incidents.md\` with an
injected timestamp. The file is **committed** (not gitignored) — it is human testimony
that must survive across clones and be reviewed in a diff — but it is **not reviewed
source**: no aspect maps it and no reviewer ever reads it as code. Entries are append-only
and their datetimes are strictly ascending. There is **no content hash baseline** in v1:
the ledger must never be able to break CI, so the only integrity signal is a **non-blocking
\`yg check\` warning** when the datetimes are out of order (the signature of a hand-edit or
a reordering merge). An absent ledger is tolerated — no file, no warning. \`yg incident\`
never touches the lock and exits 0 (a rejected tag or a loader error is the only non-zero).

\`yg advise\` surfaces the ledger as a one-line reality counter in its Attention section —
\`N incidents on record …\`, shown even at 0 so the tower stays aware it has an outside
reference at all — and, when any incident is tagged \`wrong-rule\`, an aggregate line noting
that the rules themselves may be miscalibrated.

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

## yg portal

Local, read-only web view of the graph and its verification state. Serves on a
loopback-only address (default port 4317) and prints the link.

\`\`\`bash
yg portal                       # serve the live view on http://127.0.0.1:4317
yg portal --port 8080           # choose the loopback port
yg portal --no-write            # disable the one shelled Approve action (pure read-only)
yg portal --open                # also open the browser at it
yg portal --static              # write a single self-contained HTML file instead of serving
yg portal --static --out x.html # choose the static output path (default: yg-portal.html)
\`\`\`

The served view is read-only except for one clearly-labelled Approve action that
runs the same verification as \`yg check --approve\`; \`--no-write\` removes it. The
requests that do real work (approve, its cost preview, and the live data behind
them) are answered only for the portal's own page — a cross-origin request from
another site is refused — and the server binds loopback only. \`--static\` needs no
server and no network. Flags: \`--port <n>\`, \`--out <path>\`, \`--static\`, \`--open\`,
\`--no-write\`.

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

Agent rules install identically for every agent, in one universal set,
regardless of which agent CLI or IDE is in use: a hash-anchored digest block
inside markers in \`AGENTS.md\`, a \`@AGENTS.md\` import line added to
\`CLAUDE.md\` (Claude Code does not read \`AGENTS.md\` natively), and
\`.clinerules/yggdrasil.md\` (Cline's native rules location). There is no
platform question anymore — a fresh init always writes all three artifacts;
on an existing repo they are refreshed only on request (see below).

\`\`\`bash
yg init                        # interactive wizard (TTY only) — asks only for the reviewer
\`\`\`

**Fresh repo (no \`.yggdrasil/\` yet):**

\`\`\`bash
yg init --provider <name> [--model <m>] [--endpoint <url>]   # non-interactive bootstrap with a judge (Docker/devcontainer/CI)
yg init --no-reviewer                                        # non-interactive bootstrap with NO judge
\`\`\`

\`--no-reviewer\` performs a keyless universal bootstrap: it scaffolds the
graph and installs the agent rules with no \`reviewer:\` section at all. Script
rules, dependency control, and the CI gate all work immediately, at zero cost
and with no API key. It is flags-authoritative like every other combination
here — it works in a terminal and out of one alike. The interactive wizard
offers the same choice as the last option in its provider list ("None for
now"), and a bare non-interactive run (no \`--provider\`, no
\`--no-reviewer\`, no TTY) takes the keyless route by itself, since there is
nobody to prompt. Add \`--provider\` later (same command, or \`yg init
--provider ...\` on the now-existing repo) to configure a judge once a
judgment (LLM) rule exists.

\`--no-reviewer\` is REJECTED with a guided error when combined with
\`--provider\`/\`--model\`/\`--endpoint\` (opposite requests), with
\`--upgrade\` (which never touches reviewer configuration), or on a repo that
already has a \`.yggdrasil/\` — it chooses how to bootstrap a NEW project and
never removes a reviewer an existing one configured.

**Existing repo (\`.yggdrasil/\` already present):**

\`\`\`bash
yg init --provider <name> [--model <m>] [--endpoint <url>]   # configure/replace the judge
yg init --upgrade                                             # refresh agent rules + .gitattributes; lift version bookkeeping
\`\`\`

\`--upgrade\` always refreshes the three agent-rules artifacts to the
installed CLI's current content and sweeps away every artifact a retired
per-platform installer used to write — the CLI used to install a different
rules file per agent (13 installers in total); \`--upgrade\` removes all of
those legacy files, reported as "Legacy per-platform artifacts cleaned up" in
its output. With neither \`--provider\` nor \`--upgrade\` and a TTY, the
interactive reconfiguration menu opens (refresh agent rules / configure
reviewer); with neither and no TTY, the command reports that there is
nothing to do and lists the available flags rather than guessing.

\`--platform <name>\` no longer selects anything, but it is still accepted
everywhere it used to be, purely for backward compatibility, and always
prints a deprecation notice; its value (including any of the thirteen
retired platform names) never affects which files get written. On a FRESH
repo that notice is the only effect — the run proceeds exactly as if the
flag had been omitted. On an ALREADY-ADOPTED repo, though, passing
\`--platform\` non-interactively is still what triggers the same agent-rules
refresh it always did — deliberately, so a script that used to pass
\`--platform x\` to refresh the rules keeps working unchanged; dropping the
flag from such a command with no other reconfiguration flag instead reports
there is nothing to do. \`yg init --upgrade\` is the documented,
flag-explicit way to refresh and no longer requires \`--platform\`.

On a project that requires its whole tree to be mapped (an absent
\`coverage:\` block, or a \`coverage.required\` covering the root),
\`--upgrade\` additionally WARNS that the root files it maintains
(\`AGENTS.md\`, \`CLAUDE.md\`, \`.clinerules/yggdrasil.md\`,
\`.gitattributes\`) are unmapped and will block the next \`yg check\`, and
prints the exact \`coverage.excluded\` stanza that resolves it. It reports
only — it never edits \`yg-config.yaml\` — so the choice between excluding
them and mapping them to a node stays the user's.

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

## yg prime

Print the full agent operating manual, fresh from the installed CLI. This is
the canonical source of the workflow, vocabulary, and protocol every agent
follows in a Yggdrasil-managed repository — the manual no longer lives as a
file committed to the repository, so this is how an agent (re-)reads it at
any point in a session. Graph-independent: works without a \`.yggdrasil/\`
present, and always reflects the CLI version installed right now.

\`\`\`bash
yg prime            # print the full manual
yg prime --digest   # print only the canonical committed digest block
\`\`\`

\`--digest\` prints the exact standing summary that \`yg init\` commits inside
the \`<!-- yggdrasil:digest ... -->\` markers in \`AGENTS.md\`, and as the full
content of \`.clinerules/yggdrasil.md\`: a short block that mandates running
\`yg prime\` before any change, plus the handful of invariants no reviewer can
enforce (never write a suppression without approval, never change a
\`review_by:\` date, treat \`yg advise\`/incident actions as proposals, and so
on). \`yg check\` compares the committed digest's hash against this canonical
value and reports \`rules-digest-stale\` — a warning — whenever a project's
committed digest is missing, hand-edited, from an older CLI, or duplicated;
the fix is always \`yg init --upgrade\`.

## Validator issue codes — verification and status

The validator (\`yg check\`) emits the following issue codes.

SEVERITY BELOW IS THE WHOLE-PROJECT ANSWER: what \`yg check\` reports on a project
that names no reference branch (the default), and what \`yg check --full\` reports
on one that does. With progressive mode on (\`progressive.reference\` set), most of
these are listed as a non-blocking warning when the current change did not reach
them, whatever their severity below. The exceptions — the graph's own integrity
codes, anything that stops a recording run before it writes, the log gate at
recording time, and any finding the run cannot attribute to a file or a
component — never are; see \`yg knowledge read configuration\` (the \`progressive\`
section). \`error (always)\` in the column means NOT STATUS-GOVERNED — an error
whatever a rule's \`draft\`/\`advisory\`/\`enforced\` level says — not "unconditional
under every configuration".

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
| \`type-relation-forbidden\` | error (always) | With \`coverage.type_level\` on: a statically-resolved import between two classified endpoints (an explicit node and/or a type-covered file) has no relation type the architecture allows between their two node TYPES. Additive to \`relation-undeclared-dependency\`, not a replacement — this is the case that check cannot see because a type-covered endpoint has no \`yg-node.yaml\` to declare a relation in. Not an aspect — not status-governed, not suppressible, never cached. Next (cheapest first): allow the type pair in \`yg-architecture.yaml\`, give the target file an explicit node with a curated relation, or remove the dependency. |
| \`log-entry-missing\` | error | \`--approve\` log gate fired |
| \`aspect-status-invalid\` | error | Declared status is not one of \`draft\\|advisory\\|enforced\` |
| \`aspect-review-by-malformed\` | error | Declared \`review_by:\` is present but not a calendar-valid bare ISO date (\`YYYY-MM-DD\`; e.g. \`2027-13-40\` or \`2027-02-30\`). Blocking parse-time error, fired ONLY on the aspect that carries the field. |
| \`aspect-review-overdue\` | warning | A rule's standing \`review_by:\` date has passed (compared against the CLI clock) — the rule is running unreviewed. Status-independent. Never writes the lock, changes a verdict, or gates \`--approve\`. Next: ask the user to renew (new \`review_by:\`) or retire (demote) the rule; never change the date without their approval. |
| \`aspect-status-downgrade\` | error | Declared status is lower than cascade would yield (bump up OK, downgrade is error) |
| \`implies-status-inherit-invalid\` | error | \`status_inherit:\` value not one of \`strictest\\|own-default\` |
| \`aspect-effective-nowhere\` | warning | Dead-attach linter: an aspect that ships a rule source (\`content.md\` or \`check.mjs\`) and is not draft, yet is effective on ZERO nodes after the full cascade + every \`when\` — a rule that looks enforced but is never verified anywhere. Silent while the model has no nodes. Next: \`yg impact --aspect <id>\`; fix the attach sites / \`when\`, or set \`status: draft\` until the node/type it targets exists. |
| \`coverage-required-shadowed\` | warning | A plain (non-glob) \`coverage.required\` root sits entirely inside a plain \`coverage.excluded\` root — exclusion is absolute, so every file under that required root is silenced before the required/advisory split ever runs, and the required line can never make anything block. Next: remove the required line, or narrow the excluded root so it no longer contains it. |
| \`rules-digest-stale\` | warning | The committed agent-rules digest (\`AGENTS.md\` block, \`.clinerules/yggdrasil.md\`, or the \`CLAUDE.md\` \`@AGENTS.md\` import) is missing, was hand-edited, is from an older CLI, or is duplicated. Never cached, never suppressible — recomputed live on every \`yg check\`. Next: \`yg init --upgrade\`. |

For detailed semantics of status: \`yg knowledge read aspect-status\`. For the lock,
verification, and caching: \`yg knowledge read verification-and-lock\`.
`;
