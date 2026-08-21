# Convention Mining (Roots)

Every codebase already has conventions nobody wrote down: the naming shape a
team's guard classes share, the decorator that always comes with a certain
base class, the import that every handler in a directory pulls in. Roots finds
those patterns by reading the code itself — no rule to author, nothing to
teach it — and reports what it found.

::: warning Off unless you turn it on
Nothing on this page applies to a project with no `roots:` block in
`.yggdrasil/yg-config.yaml`. Absent the block, roots is fully dormant: no
store is read, no directory under `.yggdrasil/roots/` is created, and nothing
about `yg check`, `yg context`, or any other command's behavior or exit codes
changes. The one deliberate exception is `yg init --upgrade`, which manages
the roots gitignore/gitattributes lines unconditionally, whether or not a
project has opted in.
:::

This page covers the two commands available today. Roots does not yet speak
up while you edit, gate a build, or turn a mined pattern into an enforced
rule — see [What's not here yet](#whats-not-here-yet).

## Turning it on

You don't have to write the config block yourself. Run:

```sh
yg roots index
```

On a project with no `roots:` block, this adds one with every default setting
— printed to the terminal first, so you see exactly what changed — and then
mines the repository. If you would rather add the block yourself first (to
set a non-default option before the first mine), see
[Configuration → Roots](/configuration#roots) for the full key reference.

## The two commands

### `yg roots index`

Reads the repository and writes a committed snapshot of what it found to
`.yggdrasil/roots/model.json`. Re-run it after the code has moved on — every
run of `index` against the same code and configuration produces the exact
same file, byte for byte, so the snapshot is reviewable in a diff the same
way any other generated, committed file is.

When the project is a git repository, `index` also reads its commit history
and uses it to decide how much each piece of mined evidence counts: code
that has stood unchanged for a while counts fully, code introduced very
recently counts less, and code rewritten again shortly after landing counts
less still. Code committed by an AI agent counts less until it has stood on
its own for a while — a human-authored change of the same age counts more
from the start. Code the tool previously shaped itself counts for much less
as evidence — capped low, regardless of how long it has otherwise stood —
until a maintainer's follow-up touch releases it; only then is it scored on
the same terms as everything else. None of this changes what gets reported
today — a pattern that shows up in the snapshot is still only reported,
never enforced — but it changes how much each instance of it counted toward
being reported. A repository with no git history, or only a shallow clone,
still mines the same fields, honestly, with nothing claimed as backed by
history it does not have.

Reading that history is incremental, not a full re-walk every time: a first
`index` reads the whole history and remembers where it left off; a later
`index` picks up only the commits made since then and never re-reads a
historical file version it has already seen, so a repeat run over a large
history is fast rather than starting over. When nothing in the repository or
its configuration has changed since the last run, `index` says so — "already
current" — and writes nothing at all, not even to its own working cache.
Pass `--full` to force a complete re-walk of the whole history regardless of
what is cached; it produces byte-for-byte the same snapshot an incremental
run would, so it is safe to reach for whenever you want that from-scratch
guarantee — including after resolving a merge conflict on the committed
`model.json`.

Exits with an error for a genuine problem — the project has no
`.yggdrasil/` directory at all, the `roots:` block itself is misconfigured
(an unknown key, a value of the wrong type), or another `index` run is
already writing this project's mined state: `index` waits briefly for that
other run to finish and only then refuses, naming the process still holding
it, rather than risking two writers corrupting the same cache together.
Mining a repository that turns up nothing worth reporting is not an error.

### `yg roots status`

Reports what the last `index` run found — or, honestly, that nothing has run
yet. This command never fails your build: whether roots is off, configured
but not yet indexed, or fully indexed, `status` prints what is true and exits
cleanly either way. Use it to check whether an `index` run is due, or to see
the shape of what got mined without opening the snapshot file yourself. When
the project has git history, `status` also reports how much history the
index has read in total, how far behind the current code that reading now
is, and whether a history window is currently narrowing what gets mined —
and it says so honestly, never guessing a number it cannot back up.

## What history changes

Before history was part of mining, every instance of a pattern counted the
same, however old or new the code behind it was. Now a pattern's evidence is
what has *stood*: code that has sat in place and unchanged for a while backs
a pattern fully, code that only just landed backs it much less, and it earns
more weight the longer it survives untouched. A repository with no git
history at all, or only a shallow CI clone, has nothing to measure standing
against — nothing can be scored by how long it has stood, so everything the
mine currently sees is weighted the same, flat, degraded amount, and what
gets reported reflects only what the code looks like now, not what has
proven itself over time. `yg roots status` (above) is how you find out which
situation a given run is in.

## What gets stored

Everything roots reads or writes lives under `.yggdrasil/roots/`:

| Path | What it holds |
| --- | --- |
| `model.json` | The committed snapshot `index` writes — what was mined, and when. |
| `seeds.jsonl` | Maintainer-authored hints that nudge mining toward a preferred convention. `index` reads and folds these in; nothing writes this file for you yet. |
| `decisions.jsonl` | A committed, append-only log reserved for a later increment (accepting or rejecting a mined pattern). `index` already reads and accounts for it today, so a file you commit there is already reflected in the snapshot's hash — nothing writes to it yet. |
| `ledger.jsonl` | A committed, append-only log of code the tool previously shaped. While a mark stands, `index` caps that code's evidence low regardless of how long it has otherwise stood — never fully excluded, just discounted — until a maintainer's follow-up touch releases it. `index` reads and applies these caps today; nothing writes a new mark yet — that arrives with the capability that first shapes code. |
| `.cache/` | Rebuildable working state `index` writes and reads on every run once the project has git history: a cache of parsed historical file content, so re-indexing never re-parses a file version it has already seen, plus the incremental record of how far the history has been read — which is what lets a later `index` pick up only the newer commits instead of re-reading from the start. Also holds the lock file `index` takes while it is writing, so two runs can never write the same cache at once. Gitignored, safe to delete at any time — the next run rebuilds whatever it needs from scratch and mines exactly the same snapshot either way. |
| `.state/` | Reserved for rebuildable working state, gitignored. Nothing writes to it in this release. |

`model.json` is committed on purpose: it gives every clone and every
teammate the same view of what was mined without anyone having to re-run
`index` first. Treat it like the committed lock file — generated,
reviewable, never hand-edited.

## What's not here yet

Roots mines and reports; it does not yet act on what it finds. Specifically,
this release does not:

- **Speak up while you edit.** A mined pattern is not yet surfaced as a hint
  or a warning during a coding session.
- **Gate a build.** `yg roots status` always exits cleanly — it is an
  inspection tool, not a check `yg check` (or CI) can fail on.
- **Turn a pattern into an enforced rule.** Promoting something roots found
  into a real, enforced aspect is a later capability.

Each of those is a planned extension of the same mined data — nothing you
configure today needs to change for them to arrive.

## See also

- [Configuration → Roots](/configuration#roots) — every key the `roots:`
  block accepts, and the full dormancy contract.
- [CLI reference](/cli-reference) — the rest of the `yg` command surface.
