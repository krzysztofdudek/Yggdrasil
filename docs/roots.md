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
`.yggdrasil/roots/model.json`. Re-run it after the code has moved on — a
fresh run supersedes the last one; nothing is inherited across runs. Every
run of `index` against the same code and configuration produces the exact
same file, byte for byte, so the snapshot is reviewable in a diff the same
way any other generated, committed file is.

When the project is a git repository, `index` also reads its full commit
history and uses it to decide how much each piece of mined evidence counts:
code that has stood unchanged for a while counts fully, code introduced very
recently counts less, and code rewritten again shortly after landing counts
less still. Code committed by an AI agent counts less until it has stood on
its own for a while — a human-authored change of the same age counts more
from the start. Code the tool previously shaped itself is excluded from
counting as evidence at all until a maintainer has touched it since. None of
this changes what gets reported today — a pattern that shows up in the
snapshot is still only reported, never enforced — but it changes how much
each instance of it counted toward being reported. A repository with no git
history (or only a shallow clone) still mines the same fields, honestly, with
nothing claimed as backed by history it does not have.

Exits with an error only for a genuine problem — the project has no
`.yggdrasil/` directory at all, or the `roots:` block itself is misconfigured
(an unknown key, a value of the wrong type). Mining a repository that turns
up nothing worth reporting is not an error.

### `yg roots status`

Reports what the last `index` run found — or, honestly, that nothing has run
yet. This command never fails your build: whether roots is off, configured
but not yet indexed, or fully indexed, `status` prints what is true and exits
cleanly either way. Use it to check whether an `index` run is due, or to see
the shape of what got mined without opening the snapshot file yourself.

## What gets stored

Everything roots reads or writes lives under `.yggdrasil/roots/`:

| Path | What it holds |
| --- | --- |
| `model.json` | The committed snapshot `index` writes — what was mined, and when. |
| `seeds.jsonl` | Maintainer-authored hints that nudge mining toward a preferred convention. `index` reads and folds these in; nothing writes this file for you yet. |
| `decisions.jsonl` | A committed, append-only log reserved for a later increment (accepting or rejecting a mined pattern). `index` already reads and accounts for it today, so a file you commit there is already reflected in the snapshot's hash — nothing writes to it yet. |
| `ledger.jsonl` | A committed, append-only log of code the tool previously shaped and is still waiting on a maintainer's follow-up touch before it counts as evidence again. `index` reads and honors it today; nothing writes to it yet — that arrives with the capability that first shapes code. |
| `.cache/` | Rebuildable working state `index` writes and reads on every run once the project has git history: a cache of parsed historical file content, so re-indexing never re-parses a blob it has already seen. Gitignored, safe to delete at any time — the next run rebuilds whatever it needs. The git-derived numbers that back each weight (how long code has stood, who wrote it) are recomputed from that history on every run; nothing persists them yet. |
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
