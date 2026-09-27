export const summary =
  'Log purpose (WHY-first), opt-in gate, positive-closure cycle, source-fingerprint gate, lock as baseline home, format constraints, Supersedes, type decision logs, typo recovery, revert recipe, git-merge resolution, large logs';

export const content = `# Log management

Per-node \`log.md\` captures business reasoning, gotchas, and constraints
that the reviewer does not see but future agents need.

## Purpose — WHY first

The log carries WHY a change was made — the intent behind it. WHAT changed is the
diff and the aspect content; do not duplicate it. The gate exists to force intent
capture where the team decided it matters.

## When a log entry is required — the opt-in gate

\`log_required\` defaults to \`false\` per node type. It is enabled on types whose
changes carry business intent worth capturing (\`yg knowledge read
working-with-architecture\` is the home for that guidance). To know whether a node
needs an entry, check its type in \`yg-architecture.yaml\`, or read the node's log
state line in \`yg context --node\`.

A fresh log entry is required whenever BOTH hold:

- the node's type has \`log_required: true\`, AND
- the node's mapped source changed since its last positive closure (or this is the
  first verification and the node owns source files).

"Fresh" means newer than the entry recorded at that closure — one fresh entry per
closure cycle. The requirement depends ONLY on the type flag and the source
change. It is INDEPENDENT of aspect status AND of whether the node has any aspects
or pairs at all — a node that owns source but has no effective (non-draft) aspects
still needs an entry when its source changes. A node with no source change
(cascade-only re-verification — an aspect was edited, the source untouched) needs
no new entry.

The requirement is enforced READ-ONLY. A missing entry is a blocking
\`log-entry-missing\` error surfaced by plain \`yg check\` itself — computed live
from each node's source fingerprint, like the relation-conformance check, at zero
LLM cost — not merely a \`--approve\`-time gate. So a CI run on plain \`yg check\`
catches an unlogged source change on a \`log_required\` node even when that node
produces no pairs to fill. \`--approve\` only WRITES (records the closure baseline
once the entry exists); it never gets a chance to bypass the requirement, because
its own final re-check surfaces the same error.

## Positive closure — the cycle

Positive closure is the moment a \`yg check --approve\` run ends with every
ENFORCED pair of the node SETTLED. At closure the lock records the node's source
fingerprint and the log freshness baseline.

A pair is settled when it passed this run — script rules and reviewer rules
uniformly — or when the run was deliberately told not to buy it. The second case
arises only under progressive mode: a run measured against a change leaves the
reviewer work the change is not accountable for, and those pairs stay unverified.
Treating them as settled is what stops the cycle from staying open forever, which
would let ONE entry answer for every later edit, including edits nobody described.

Corollaries:
- Advisory refusals do NOT prevent closure.
- A node with only advisory aspects or script rules, or no pairs at all, closes
  vacuously — BUT only once the log requirement is satisfied: a \`log_required\`
  node whose source changed with no fresh entry does not close, and \`yg check\`
  flags it red regardless of its (lack of) pairs.
- A red enforced pair of either kind keeps the cycle OPEN — the same log entry
  stays valid through every retry until the node is actually green. Intent does
  not change between retries; only execution does. So does a pair left unverified
  by anything OTHER than that deliberate skip — a check that failed to run, a
  provider that could not be reached. Only "we were told not to buy it" settles a
  pair nobody looked at.
- Only a run that writes the COMMITTED files can close a cycle at all.
  \`yg check --approve --only-deterministic\` writes just the gitignored cache, so
  it records no closure, for any node, on any project. Where that free gate is a
  project's ONLY fill, no cycle ever ends: the node's newest entry keeps
  satisfying the requirement for every later source change, and a second entry is
  never asked for. Nothing about progressive mode causes this and turning the mode
  off does not change it — but it is worth knowing when a pipeline leans on the
  free gate. Where each round of work must carry its own reason, a full
  \`yg check --approve\` has to run somewhere.
- A node that closes with an unbought pair records a fingerprint that attests
  something correspondingly narrower: every enforced rule the run was ASKED to
  settle saw these bytes — not that every rule on the node did. A node with four
  passed rules and one unbought one did have its source read, for those four.
  Only at the extreme — every reviewer rule on the node outside every
  change so far — does the fingerprint stand for source no reviewer has read. In
  every one of these cases the unbought rules stay unverified and are still
  reported as such, so nothing about the node reads as green.

## The source fingerprint and the lock

The gate's "mapped source changed" test is computed from a per-node **source
fingerprint** — one sha256 fold over the sorted \`[path, sha256(bytes)]\` list of
ALL the node's mapped files (the full mapping, not the scope-filtered subject
sets; binaries included by bytes). It lives in \`yg-lock.logs.json\` under
\`nodes.<path>.source\`, written by every full fill: for a \`log_required\` node at
positive closure, for any other node whatever its verdicts say — so a type that
opts in later is measured from its code as it already stood, at the cost of the
committed logs lock changing whenever a full fill sees moved source. A node that
owns a \`log.md\` also holds its append-only \`log\` baseline (boundary datetime +
prefix hash). When the section is empty (no log_required
node, no \`log.md\`), \`yg-lock.logs.json\` is not written at all — an empty committed
husk is removed. There is no separate per-node state file.

The basic workflow:

  1. Edit source files
  2. \`yg log add --node <path> --reason "<justification>"\`
  3. \`yg check --approve\`

If you forget step 2, plain \`yg check\` raises a blocking \`log-entry-missing\`
error for that node (caught read-only, regardless of whether the node has pairs).
At \`--approve\`, if a node the run would fill a pair of owes an entry, the run
fills NOTHING — no pair on any node, related or not, is verified — until that
entry exists. A changed node the run fills nothing of (no pairs, or only reviewer
pairs this run leaves alone: \`--only-deterministic\`, or outside a measured
change) does not stop it; the run records nothing over its code, and plain
\`yg check\` keeps it red until its entry exists. Add the entries and re-run.

An entry comments on a change to the node's OWN source, and only that: editing
a rule, a relation, the lock or a verdict re-opens pairs but owes no entry. The source is the set of files the mapping names, so a changed mapping (a file
moved between nodes) owes one. Switching a type to \`log_required\` does not:
every full fill records every node's fingerprint, so the first entry is owed at
the node's first real source change after the switch. A node with no recorded
fingerprint at all (a new node, or one no full fill has run over since this
release) owes its first entry. If a pair is refused, iterate on
the code WITHOUT adding new log entries — one entry covers all edits until the node
reaches closure. Under progressive mode a node can reach closure while some of its
reviewer work is deliberately left unbought, so the next source change there needs
its own entry, exactly as it would after an ordinary closure.

Only a full \`yg check --approve\` records closure; \`--only-deterministic\` never writes the committed logs file. So a \`log_required\` node with nothing left to fill whose source moved past its recorded baseline, while its log has entries, shows a \`log-cycle-open\` WARNING on plain \`yg check\`: its newest entry keeps answering for every edit until a full run records the baseline. It never blocks. It is expected between \`yg log add\` and that full run on a node with no pairs pending; on a project whose only fill is the free gate it means the requirement has stopped asking for new entries, and a full run somewhere has to close it.

The log's own integrity is checked on every \`yg check\`, as blocking errors: \`log-conflict\` (git conflict markers left in log.md — \`yg log merge-resolve\`), \`log-integrity\` (the recorded history was rewritten, or entries were inserted before the last recorded one, the shape a merge leaves — \`yg log merge-resolve\` after a merge, otherwise restore log.md from git), and \`log-format\` (log.md does not parse as entries: text before the first header, a header or datetime that does not parse, a \`## \` line inside a body, entries out of order or sharing a datetime, an unclosed code fence). Under progressive mode each of them — and \`log-entry-missing\` — on a node your change did not touch is reported as its non-blocking \`-outside\` warning.

## Self-contained entry — worked example

The rules for self-contained entries are in the agent operating manual
(\`yg prime\`, Log management section). This example illustrates them in
practice.

Avoid:

\`\`\`
Plan Task 3.2. Generate IDs client-side as discussed in the design doc.
Matches the pattern used by the existing order-create handler.
\`\`\`

A reader cannot find the plan, the design doc, or the handler in its
original form. None of the references survive the next iteration.

Prefer:

\`\`\`
Order IDs are generated client-side (UUIDv7) instead of via a database
sequence. UUIDv7 keeps inserts roughly time-ordered for index locality
while removing the round-trip needed to fetch the next sequence value
before publishing the order to downstream services. Collision risk at
expected volume is negligible and accepted in exchange for the simpler
write path.
\`\`\`

Same decision, all rationale embedded in the entry.

## Format constraints

Enforced in two places: \`yg log add\` refuses a malformed \`--reason\` before a byte is written (an empty reason, a line-start \`## \` outside a code fence, an unclosed fence), and \`yg check\` validates the file as a whole as \`log-format\`: those same rules plus text before the first entry header (\`invalid_start\`), a header that does not parse (\`invalid_header\`), a datetime not in the exact \`YYYY-MM-DDTHH:MM:SS.mmmZ\` form (\`invalid_datetime\`), entries out of order (\`out_of_order\`) and two entries sharing one datetime (\`duplicate_datetime\`).

- Entry headers \`## [<ISO datetime UTC with milliseconds>]\` are reserved.
- Use \`###\` or deeper for sub-headings in your \`--reason\`. Only the level-2 \`## \` is refused (below); a level-1 \`# \` line passes both commands, but reads as a heading above the entry's own, so avoid it.
- Do not put a level-2 heading (\`##\`) at the start of any line in your
  \`--reason\` content. Only a real line-start level-2 heading is the
  problem — a \`## \` that appears inside a BACKTICK-fenced code block (three
  or more backticks to open, at least as many to close) is allowed. Tilde
  fences (\`~~~\`) and indented code blocks are NOT recognized as fences, so a
  \`## \` line inside one is still a \`level2_header_in_body\` violation.
- Every backtick fence you open inside \`--reason\` must be closed with a
  matching one. An unbalanced fence swallows every following
  \`## [datetime]\` entry header into this entry's body for later readers, so
  \`yg log add\` refuses the entry outright ("Reason contains an unclosed code
  fence") and \`yg check\` reports it as a blocking \`unclosed_code_fence\`
  \`log-format\` error.
- Multi-line content via bash \`$'multi\\nline'\` or via \`--reason-file <path>\`.
- Datetimes must be strictly ascending across entries.

## Correcting a previous entry that turned out wrong

Append-only blocks editing historical entries. To supersede an earlier
entry, append a new entry that names it:

\`\`\`bash
yg log add --node <path> --reason "<what holds now, and why>" --supersedes <prior ISO datetime>
\`\`\`

The entry opens with one \`### Supersedes: <prior ISO datetime>\` line per
replaced entry (repeat the flag to replace several). The flag refuses a datetime
that is not an entry of this log, and one a later entry already replaced — name
that later entry instead. Both entries stay in the file; \`yg log read\` marks
the replaced one, so future agents know which entries no longer hold. An entry
written by hand in the same \`### Supersedes:\` shape reads the same way when the
entry it names exists.

## A node type's decision log

\`yg log add --type <type> --reason "<the decision>"\` records an explicit
decision about the whole area a node type stands for, in
\`.yggdrasil/types/<type>/log.md\`. It is never required and invalidates no
verdict. It has the same entry rules, \`--supersedes\`, integrity, format and
conflict checks and \`yg log merge-resolve --type <type>\` as a node's log; its
baseline (in the committed \`yg-lock.types.json\`) moves with each add,
so an add refuses a rewritten or conflicted log. \`yg log read --type <type>\`
prints the decisions in force; \`--all\` adds the replaced ones. A log whose
type the architecture no longer defines is reported as \`type-log-orphaned\`.

An add lists the decisions in force for the type and the types above it, and
when any exists it needs \`--supersedes <datetime>\` (the one it replaces) or
\`--adds\` (it replaces none); with neither it is refused as
\`type-log-choice-missing\`.

When both sides of a merge superseded the SAME entry, \`yg log merge-resolve\`
keeps every entry and records the baseline but exits with
\`log-merge-supersedes-conflict\`: two successors would both be in force. Finish
the merge, then add one entry that supersedes both and says which holds — ask
the user which one that is.

## Recovery from typo in a fresh entry (BEFORE its baseline is recorded)

If you just ran \`yg log add\` and notice a typo, and no baseline has been recorded over the typo'd entry yet:

\`\`\`bash
git checkout .yggdrasil/model/<path>/log.md
yg log add --node <path> --reason "<correct text>"
\`\`\`

When the entry was the log's first and \`log.md\` is not tracked by git yet, there is nothing to check out: delete the file instead, then re-add.

The window is short, and it depends on the node's type. For a \`log_required\` node it lasts until the node reaches positive closure (the full \`yg check --approve\` that records its fingerprint). For any other node it lasts only until the next full \`yg check --approve\` in the repository — any run, on any node, even one with nothing to fill: every full fill records the newest entry of every such node as its baseline. Inside the window the log baseline in the lock is unchanged, so checking out just \`log.md\` is safe and integrity remains intact. Once a baseline covers the typo'd entry, restoring \`log.md\` breaks integrity (\`log-integrity\`, \`boundary_missing\`) — use the Supersedes convention instead.

## Reverting a change you regret

Do NOT add a "correction" entry to \`log.md\` — that would still leave the wrong
code in place. There is no per-node state file to roll back, and the lock holds
EVERY node's verdicts — so NEVER check out the whole lock to revert one node;
that would clobber every other node's verdicts. Revert source and log via git:

\`\`\`bash
git checkout HEAD~1 -- \\
  src/file.ts \\
  .yggdrasil/model/<path>/log.md
yg log add --node <path> --reason "Tried X, reverted because Y"
yg check --approve
\`\`\`

The reverted source files change the node's subject hashes, so its pairs
invalidate and \`yg check --approve\` re-verifies just this node — accept that one
re-verification. The new log entry records the revert; closure re-establishes the
node's baseline.

## After a git merge, rebase or cherry-pick

If both sides added log entries to the same node, git stops with conflict
markers in its \`log.md\`. Run, right there, with the operation still stopped:

\`\`\`bash
yg log merge-resolve --node <path>
\`\`\`

It reads the two sides from git: a merge's \`HEAD\` and \`MERGE_HEAD\`; a rebase's
or cherry-pick's \`HEAD\` (the side being built on) and \`REBASE_HEAD\` /
\`CHERRY_PICK_HEAD\` (the commit being replayed — it contributes the entries it
added over its own parent, nothing more). It **writes the union** — the entries
both logs start with, then every entry either side holds after them, each
byte-for-byte with its original date, oldest first — verifies it, and records the
node's \`log\` baseline into the lock. The shared part is read off the two logs,
not off the merge-base commit, so a log an earlier merge put in date order merges
again; the merge base only checks that neither side lost an entry it had. Then \`git add\` the log and
\`yg-lock.logs.json\` and finish the operation (\`git commit\`, \`git rebase
--continue\`, \`git cherry-pick --continue\`); a rebase stops once per replayed
commit, and each stop resolves the same way.

**Whether the merge owes an entry.** An entry comments on a change to the
component's own source. When the merge brought the other side's code into the
component, its source is now a combination no entry has commented on yet, so a
\`log_required\` component owes one entry of its own: the reason for the merge.
Only whoever merged knows it — ask the user, never infer it from the diff.
merge-resolve says so: its \`next:\` is then \`yg log add\` instead of \`git add\`.
Add the entry before finishing the operation, then \`yg check --approve\`. A
merge that changed only the log — the component's source is exactly as its
recorded closure saw it — owes nothing.

On a log that is already whole (the merge commit, or a hand resolution) it verifies without rewriting the log — it cannot silently drop or fabricate entries — and, like every successful run, records the log's baseline in the committed lock file (\`yg-lock.logs.json\`; a type's in \`yg-lock.types.json\`), which is staged with the merge. It compares the log byte for byte with git's copies of both sides, which is why \`yg init\` pins every log.md to LF in \`.gitattributes\` (\`/.yggdrasil/**/log.md text eol=lf\`) — keep that line. Do NOT manually
concatenate the two log histories or keep one side and re-add entries — integrity
hashes break, and re-added entries lose their original dates.

Until it is reconciled, \`yg check --approve\` refuses to run (\`log-conflict\`,
ABORTED before anything is filled): recording the node's baseline over a
conflicted log would close its cycle over entries nobody reconciled. The same
holds for a rewritten history (\`log-integrity\`) and a log that does not parse
(\`log-format\`). \`--only-deterministic\` and \`--dry-run\` record no baseline and still run.

When BOTH \`log.md\` and \`yg-lock.logs.json\` conflicted, the order is: resolve the lock
(take ONE side wholesale — during a rebase \`--ours\` is the upstream) → \`yg log merge-resolve --node <path>\` per conflicted
log → \`yg log add\` for each component whose code the merge combined (merge-resolve
names them) → \`yg check --approve\`. (Lock merge mechanics:
\`yg knowledge read verification-and-lock\`.)

A merge that left no merge commit (a merge script, a squash, a finished rebase) names its
two sides instead:

\`\`\`bash
yg log merge-resolve --node <path> --ours <ref> --theirs <ref> [--base <ref>]
\`\`\`

\`git merge-file --union\` and a \`merge=union\` attribute join the two sides
without sorting them: when entries interleave by date, put them in date order
before running merge-resolve. Until then \`yg check\` reports \`prefix_modified\`;
when the recorded history survived and only whole entries were added before its
last one, the message points at merge-resolve, not at restoring the file.

## Never edit log.md directly

Integrity verification catches any modification of historical entries (entries
before the last closure). Edit only via \`yg log add\`. The exceptions above (typo
recovery, revert) operate on the file but via git, not by hand-editing.

## Large logs

When \`log.md\` is large (rough threshold: >50 entries OR >5000 tokens), do not
load full content into your context.

Reach for the built-in bounded reader FIRST:

\`\`\`bash
yg log read --node <path>                  # the 10 newest entries, newest-first
yg log read --node <path> --top 3          # just the 3 newest
yg log read --node <path> --with-verdicts  # interleave this node's verification events
yg log read --node <path> --all            # full history (cannot combine with --top)
\`\`\`

Only when even the bounded output is too large or too verbose for the task at
hand, delegate a summarization pass to a subagent:

\`\`\`
Read .yggdrasil/model/<path>/log.md, summarize relevant context for
task: <task description>. Return key decisions, constraints, and
gotchas only.
\`\`\`

Use the returned summary, not the full log.

## Log add does not verify

\`yg log add\` does NOT invalidate any verdict or run the reviewer. You can append
context entries between code changes freely. Only source-file changes in the
mapping require entries paired with \`yg check --approve\`.
`;
