# Progressive Mode

By default `yg check` answers for the whole project. Every rule that is not
verified, every refusal, every coverage gap fails the build — whoever caused it,
and whenever. That is the right default, and on a large repository that has just
adopted Yggdrasil it is also the thing that stops adoption: a rule you switch on
this afternoon is broken in two hundred places by the evening, and from then on
every unrelated change is red.

Progressive mode is the way through that. Name a branch for your work to be
measured against, and a plain `yg check` fails only on the obligations your
change actually reaches. Everything the change inherited from that branch is
still listed, still counted, and never hidden — as a warning that does not fail
the build. Debt stays visible and stops standing between a good change and a
green build.

::: warning Off unless you turn it on
Nothing on this page applies to a project that names no branch. With the
`progressive` block absent, every run answers for the whole project exactly as it
always has: the same findings, the same severities, the same exit code, and no
measurement of any kind.
:::

## Turning it on

In the committed `.yggdrasil/yg-config.yaml`:

```yaml
progressive:
  reference: origin/main
```

That one key is the whole switch. What it has to satisfy:

- **`reference` names something this clone can resolve.** A remote-tracking
  branch (`origin/main`) is the usual choice; a plain branch name works if every
  clone and every CI job has it. Whatever you name, the clone also needs enough
  history to reach the point your work branched off — see
  [In your pipeline](#in-your-pipeline).
- **It is read from the committed file only.** A local `yg-secrets.yaml` overlay
  can neither introduce this key nor re-point it, so how much of the project a
  run answers for is the same for everyone working on the branch.
- **The block must name `reference`, and nothing else.** A misspelled key, an
  empty value, and a block that names nothing at all (`progressive: {}`) are each
  refused outright rather than ignored — otherwise you would be reading a config
  that says the mode is on while every run behaved as if it were off.
- **Changing the block costs one full run.** The run that adds, edits, or removes
  it answers for the whole project, because a change that re-points the
  measurement could otherwise narrow the gate on its own authority.

## What a run looks like

The header gains one segment: how many obligations sit outside your change, what
they were measured against, and how many changed files the measurement
accounted for.

```text
yg check: FAIL  84 nodes · 1204/1204 files · 37 aspects · 6 flows · 613 verified (512 deterministic, 101 LLM) · 12 obligations outside your changes vs origin/main (7 changed inputs)
```

Findings your change reached are unchanged — same name, same severity, same
`Fix:` line, still red. Findings it did not reach read exactly like the finding
they mirror, with one phrase added:

```text
  unverified (not yet reviewed) (outside changes)  1 pairs  1 nodes
            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.
            - beta  aspect 'no-todo-comments'
```

The reason it fired is still there, because it is still true. What is missing is
the `Fix:` line: for this one finding that command would send you to review the
whole project, which is not the next step for someone who did not cause it.
Among warnings, inherited ones always sort last, so they can never bury a
warning your change is actually responsible for.

When nothing of yours is blocking, the run's single next step points at the
audit rather than at any one finding:

```text
Next: 12 obligations outside your changes — run 'yg check --full' for the complete audit
```

And on a checkout that carries no change at all, the header says so in words
rather than with a zero:

```text
yg check: PASS  84 nodes · 1204/1204 files · 37 aspects · 6 flows · 613 verified (512 deterministic, 101 LLM) · nothing in scope; 12 obligations outside your changes vs origin/main
```

That "nothing in scope" wording appears only when nothing is blocking; a run with
errors gets the plain shape, so the header can never contradict the list beneath
it.

## What decides whether a finding is yours

Your change is everything that differs from the named branch: every commit since
your work branched off it, **plus** everything uncommitted in your working copy —
files added, edited, deleted, untracked, and both names of a rename.

From those files:

- Every rule whose review subject includes a changed file is yours.
- The component that owns a changed file is yours — including a file you
  **deleted**, because ownership is resolved from the component's path patterns
  rather than from what is on disk.
- Any rule that recorded reading a changed file while it was being judged is
  yours, even though that file is not its subject.

Changes inside `.yggdrasil/` reach further, because the graph is what decides
which rules apply to what:

| You changed | What becomes yours |
| --- | --- |
| A rule's folder | Every use of that rule, plus every rule it pulls in through `implies` |
| Anything in a component's model folder except its `log.md` | That component, everything under it, everything above it, and every component that declares a relation to it |
| A flow | That flow's rules on every participant, descendants included |
| A component's `log.md` | That component's written-reason requirement, and nothing else about it |

The `log.md` line is deliberate: writing one entry must not put a whole subtree
back in scope, or `yg log add` on a shallow component would re-gate most of the
graph.

Three changes put the **whole project** back in scope for that run, because
nothing smaller can bound them:

- `yg-architecture.yaml` — types, their rules and their allowed relations all
  move at once.
- The part of `yg-config.yaml` that decides what the graph means: the schema
  version, the `coverage` block, the set of reviewer tiers, and which tier is the
  default. Ordinary configuration churn — prompt limits, parallelism, debug, a
  tier's own model or provider — reaches nothing.
- The `progressive` block itself.

Two more rules exist so that a gap can never read as a clean slate: a rule whose
recorded verdict your change **deleted** is always yours, and a check that has no
recorded result yet is yours as soon as your change touches anything within its
reach — so a fresh clone never reads as "everything was already verified".

Everything else falls on the safe side. A finding that cannot be tied to a file
or a component keeps blocking: "cannot tell" is never read as "not yours".

### A file git has been told to ignore still answers for itself

Git can be instructed to report a modified file as unmodified — that is what
`git update-index --assume-unchanged` and `--skip-worktree` do, and a file
carrying either mark is absent from `git status` and from every diff no matter
what its content says. Left there, that would be a way to edit a file and have
its findings reported as inherited debt.

So before any finding is set aside as not yours, the run checks the content of
the files it is about against the content the reference branch holds. If they
disagree, that finding is yours, whatever git said about it — and that holds
whichever way the finding names its subject: a rule check, a component, a file,
or a dependency between two files. This costs nothing you will notice: it looks
only at findings that are both failing and about to be set aside, and it reads
the reference branch's file list once for the whole run.

#### When this check has to be switched off, and how you will know

The comparison is between the bytes stored on the branch and the bytes in your
working copy. Anything that **rewrites files between those two points** makes
them differ for reasons that have nothing to do with your change, and then every
failing finding on every such file stays blocking, on every run. Two things do
that, and neither is confined to any one platform:

- a committed `.gitattributes` that sets `text eol=…` or a `filter=` driver — so
  continuous integration meets it exactly as readily as a laptop does;
- large-file storage, where the branch holds a pointer and your working copy
  holds the content.

When that happens the run says so, in a line of its own beneath the header:

```text
Content check: 12 findings kept in scope — the files behind them differ from
'origin/main' although git reports no change there. If that happens to
everything on every run, something is rewriting files between storage and your
working copy (a committed .gitattributes 'text eol='/'filter=', or large-file
storage) — nothing is then inherited, so 'yg check --approve' pays to review the
whole project.
```

That is the symptom of a project on which measuring changes cannot currently
narrow anything: everything inherited blocks, and — the part that costs real
money — a recording run has nothing left to leave out, so it reviews the whole
project exactly as it would on a branch that reached everything. It errs toward
gating more rather than less, and `yg check --full` reports the same set either
way, but if you see this on every run, measuring against a branch is buying you
nothing until the rewriting stops.

## What never becomes a warning

Progressive mode narrows what blocks; it never narrows what is checked, and some
findings are never eligible for it at all:

- **The graph's own integrity** — a component naming a rule that does not exist,
  a cycle, a port contract that is not honoured, a malformed file, a lock that
  cannot be read. These block wherever you run them. The test is whether the
  graph *contradicts itself*: that is something whoever wrote it can always fix
  on the spot, and there is no version of it that belongs to somebody else.
- **Anything that stops a recording run before it writes.**
- **Any finding the run cannot attribute** to a file or a component, as above.
- **The written-reason requirement, at recording time.** If a component's type
  asks for a log entry and its source has moved past the entry its log records, a
  recording run stops and asks for that entry — whoever moved the code, and
  whether or not your change went near it. Recording answers for the code as it
  stands, so it will not record over an edit nobody explained. A plain read of the
  same branch can pass while that run stops; both are true, and the message names
  the component it is waiting on.

Four findings look like they belong in the first bullet and do not. An
**undeclared dependency** between two components, an **import the architecture
forbids between two types**, a **file that matches two types at once**, and a
**mapped file that does not match its type's `when`** are all reported as
architecture-level errors, and all four are eligible. The graph is well-formed in
every one of those cases: what disagrees is the *code*, and a branch that never
touched that code did not cause the disagreement. They keep blocking the moment
your change reaches the code that carries them, and `yg check --full` blocks on
all of them regardless.

## Every state, and what the run does

The measurement is only ever made when it can be made honestly. Where it cannot,
the run answers for the whole project and says so on stderr — what happened, why,
and the specific fix — never a quietly empty scope. One state answers for the
whole project with the measurement having gone perfectly well: a change that
reaches the architecture or the meaning of the configuration. That one gets a
notice too, for the opposite reason — nothing went wrong, and a run that gates
everything while reporting `0 obligations outside your changes` should not leave
you wondering whether the mode had quietly stopped working.

| State | What the run does |
| --- | --- |
| `yg check --full` was asked for | Answers for the whole project. No measurement is attempted. |
| No branch named in the config | Answers for the whole project, exactly as before this feature existed. |
| An ordinary branch, or uncommitted edits sitting on the reference branch itself | Measured: your change blocks, the rest is listed as outside it. |
| Your change reached the architecture, the coverage scope, the schema version, the reviewer tiers, or the `progressive` block | Measured, and everything is in scope this run — plus a notice naming which of those it reached and saying plainly that there is nothing to fix. The next change that leaves those files alone is measured normally again. |
| Nothing has moved: your work is at or behind the reference and nothing is uncommitted | Nothing is in scope. Every eligible finding is reported as inherited and the run passes, quietly — no notice, because nothing went wrong. |
| Your branch committed something and then reverted to the reference's exact content, nothing uncommitted | The same: it is the same content, reached by a different route. |
| The named branch cannot be resolved (typo, renamed, never fetched) | Whole project, plus a notice naming the branch and telling you to fetch it or correct the key. |
| A shallow clone with no shared history | Whole project, plus a notice telling you to deepen the checkout — not to change the key, which is fine. |
| Git did not answer at all | Whole project, plus a notice to check that this is a git work tree. |
| The changed-file list could not be read | Whole project, plus a notice to check that `git status` and `git diff` succeed here. |
| The graph does not sit at the repository root (nested graph, monorepo subdirectory) | Whole project, plus a notice that says plainly there is nothing to fix — remove the key if you would rather not be told each run. |
| A submodule pointer is among the changed paths | Whole project, plus a notice; changes that leave the pointer alone are measured normally again. |
| The verdict record committed at the reference cannot be read | Whole project, plus a notice: repair that file on the reference branch. |
| Nothing appears to have changed, but nothing proved the working tree clean either | Whole project, plus a notice. Treated as a failed measurement, never as "nothing to do". |

## Recording verdicts under a measurement

A run that records verdicts — `yg check --approve`, or a bare `yg check` on a
project configured to approve automatically — is measured the same way as a plain
one. It reports what a plain run reports, and it asks the reviewer only about the
rules your change is accountable for. It says how many reviewed rules it left for
later, and `yg check --full --approve` is what reviews those.

The checks that run locally are not narrowed: they cost nothing, and what they
observe is what the next measurement reads, so they keep covering the whole
project on every recording run.

`yg check --approve --dry-run` prices exactly what the real run would buy — on a
change that reaches no reviewer-judged rule, that is nothing at all.

This changes one thing about the written reason a component owes. Where a type
asks for one, a component owes an entry whenever its source moves on from the
state its recorded verdicts covered, and that entry covers every edit until the
component next comes up clean. Under a measurement, a component comes up clean
when every rule the run was asked to settle is approved — a rule the run was
deliberately told not to buy counts as settled, because nobody is going to look at
it either way — so the next change to that component asks for its own reason,
exactly as after an ordinary clean run. What such a component's record attests is
correspondingly narrower: every rule the run was asked to settle saw those bytes,
not that every rule on the component did, and the ones it was told not to buy stay
openly unverified and are still reported that way. Anything else that leaves a
rule unsettled still holds the cycle open — a refusal, a check that could not run,
a reviewer that could not be reached — so the standing promise is untouched: a
change that fails a check and is then fixed still needs only the one written
reason.

## Two things to know before you rely on it

### Your reference branch is green by construction

On the branch you measure against, a plain `yg check` passes — however much
inherited debt is on it. Nothing has changed relative to that branch, so nothing
is in scope, so every eligible finding is reported as outside the change. This is
not a bug and not a threshold: it is what "measure against this branch" means.

The consequence is the one thing you must get right when you wire this into CI:
**a bare `yg check` on your integration branch proves nothing about that branch.**
`yg check --full` is the run that answers for it. (Findings that are never
eligible — the graph's own integrity, and anything the run cannot attribute —
still block there, so that branch is not free of gates; it is free of the ones
progressive mode narrows.)

### The free recording path never ends a written-reason cycle

`yg check --approve --only-deterministic` writes nothing but its own local,
gitignored cache — that is what makes it free and keyless. It therefore never
records the point at which a component came up clean, and a component's
written-reason cycle only ends at that point.

On a project whose only recording run is that free pipeline gate, no cycle ever
ends: the newest log entry a component has keeps satisfying the requirement for
every later source change, and no second entry is ever asked for. This is not
specific to progressive mode — it is true of any project whose recording is
free-only — but it matters here, because the pipeline below leans on that free
gate. If you want each round of work to carry its own written reason, a run that
records verdicts (`yg check --approve`) has to happen somewhere: on a developer's
machine before the change lands, or on a pipeline leg that has a reviewer
configured. See [The lock](/the-lock) for what such a run records.

## In your pipeline

Two legs. The one on a proposed change is measured; the one on the branch you
merge into asks for the whole project.

**On a pull request** — the measured leg:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0                # see the trap below

- name: Rebuild the local cache (free, no keys)
  run: npx @chrisdudek/yg check --approve --only-deterministic

- name: Check
  run: npx @chrisdudek/yg check
```

**On the branch you merge into** — the leg that answers for everything:

```yaml
- uses: actions/checkout@v4

- name: Check the whole project (free, no keys)
  run: npx @chrisdudek/yg check --full --approve --only-deterministic
```

`--full` skips the measurement entirely, so that leg needs no extra history and
no configuration beyond the flag. It only ever tightens the gate — it can turn an
inherited finding back into a blocking one, never the reverse — so it is always
safe to add, and it combines freely with every other flag.

### The fetch-depth trap

Most CI checkouts are shallow by default. GitHub's `actions/checkout`, for one,
documents `fetch-depth: 1` as its default — one commit of the ref being built, and
nothing else — and other runners default the same way. There is then no shared
history between your branch and the one you named, the measurement cannot be made,
and the run answers for the whole project instead — so a pull request that changed
one file fails on debt it never touched.

It is loud, not silent. The run prints the cause and the fix before the report:

```text
Notice: This change could not be measured against 'origin/main', so this run gated the whole project — every finding blocks, exactly as 'yg check --full' would report it.
no merge-base with the configured reference could be found, and this is a shallow clone — the common ancestor is likely outside the truncated history.
Deepen the history and re-run: `git fetch --unshallow` locally, or raise the checkout depth in the CI job (many default to depth 1).
```

The fix is in the checkout, not in your code. `actions/checkout` documents
`fetch-depth: 0` as fetching the full history for all branches and tags, which is
what the recipe above asks of it; on another runner, use its equivalent — and
either way, check that the branch you named is among the refs it actually
fetches.

## Turning it off

Delete the `progressive` block. That run, and every run after it, answers for the
whole project — back to the default, with nothing to clean up. Nothing was
hidden while the mode was on, and every rule a measured run declined to review is
still recorded as unverified, so the first run afterwards names all of them;
`yg check --full --approve` reviews them.

## See also

- [Configuration](/configuration#progressive-mode) — the key in the config
  reference.
- [CLI reference](/cli-reference) — `--full`, `--approve`, and the rest of
  `yg check`'s flags.
- [The lock](/the-lock) — what a recording run writes, and the written-reason
  requirement in full.
