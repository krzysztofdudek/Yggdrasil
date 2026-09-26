---
title: Packages
---

A package is a set of rules published by one repository and installed into
another. You take someone else's rules, you keep taking their improvements, and
you tune it to your repository without ever editing what they wrote.

There is no registry. A marketplace is an ordinary git repository with a
manifest at its root, and a package is a directory inside it. A version is a git
tag. What you type is what you get.

::: danger Installing a package runs its author's code
A rule ships a script, and that script runs in your process whenever a check
fills verdicts — `yg check --approve`, the free `--only-deterministic` step, a
bare `yg check` under a configured `auto_approve` — and in `yg aspect-test`,
`yg drill`, `yg simulate` and `yg adopt`, with everything your process can
reach. A plain `yg check` runs none of it (the full list is in
[The lock](/the-lock#what-yg-check-proves-and-against-whom)). What is fenced is what a rule may
**read** through the context it is handed — not the module itself. Install a
package only from a source you would give a shell to, and read what you are
installing.
:::

## Installing

```bash
yg pack add https://github.com/acme/law#house-style
```

That asks the source which versions of `house-style` it publishes, takes the
newest one — the highest `pack/house-style@<version>` tag, on whatever branch it
sits — and copies the package from exactly that tag into
`.yggdrasil/aspects/packages/acme/law/house-style/`. It records the tag, the
commit the tag pointed at, and what every copied file hashed to, and writes a
`yg-aspect.adapt.yaml` beside each rule for you to tune.

Only a published version is ever installed. Work committed on the default branch
after the last tag is not, and a source that publishes no version of the package
at all is refused rather than read at its default branch: installing unreleased
work under a number nobody published would let two repositories "at" the same
version run different code.

Pin a version by naming it:

```bash
yg pack add https://github.com/acme/law#house-style@1.2.0
```

A pin stays where you put it: a plain `yg pack update` leaves a pinned package
alone and tells you what else is published, and `--to` moves it (see
[Updating](#updating)).

Each installed rule gets a name that carries where it came from:

```text
packages/acme/law/house-style/naming
packages/acme/law/house-style/error-messages
```

Attach one to a component by that full name, exactly like a rule you wrote:

```yaml
# .yggdrasil/model/orders/yg-node.yaml
aspects:
  - packages/acme/law/house-style/naming
```

### Installing from a directory on this machine

A path works as a source too, and it means one of two things.

- **A git repository** — a checkout of the marketplace, or a bare repository —
  is read exactly as a remote one is: through its published tags, cloned. What
  its working tree holds right now, committed or not, is never installed.
- **A plain directory** that is not a repository of its own publishes no
  versions at all. It is copied as it is on disk, the command says so, and the
  record names no tag and no commit. It is for trying a package out, not for
  something a teammate should be able to reproduce.

A path is resolved from where you typed it and recorded relative to the
repository root, so the record means the same thing from any directory and on a
teammate's machine that has the marketplace checked out at the same place. If it
is not there, the pack commands say that a path is missing — not that a network
failed.

A URL is recorded without any credentials written into it; give git a
credential helper instead. Git is never allowed to stop and prompt: a source
that needs credentials it does not have fails with a sentence saying so.

### Where the identity comes from

A package is filed under the repository that published it — `<owner>/<repo>` —
so a fork cannot claim the original's rule names. That identity comes from the
URL you typed. Installing from a local directory, it comes from that directory's
git `origin`; a directory with no origin has nothing to go on, and rather than
guess from the directory name — which would let two unrelated packages overwrite
each other — the command asks you to say:

```bash
yg pack add ../law-repo#house-style --as acme/law
```

The record keeps the identity, and every later update checks it again: if the
recorded source now says it belongs to someone else, the update is refused
rather than fetching their code under the name you trusted. (An identity you
gave with `--as` is recorded as given, and there is nothing to re-derive.)

A repository holds **one** package of a given name at a time: the record is
keyed by the package's name, and every pack command addresses a package by it.
Installing a second `house-style` from another publisher is refused, naming the
one you have.

Identity is still checked rather than assumed: if any rule the package would
install already exists in this repository under that exact name, `yg pack add`
refuses and names it, rather than let one quietly take the other's place.

## Adapting, not editing

**You never edit an installed rule.** `yg check` refuses any change to a copied
file, and `yg pack update` refuses to run at all while one exists. That is not
protectiveness — it is what makes an update a replacement instead of a merge. An
edit you made to a copy would vanish the next time the package moved, and nothing
would record that it had ever been there.

The refusal is all or nothing. `yg pack update` with no name checks every
installed copy before it replaces any of them, so an edited file under one package
stops the whole run with nothing touched — not the package you edited and not the
ones sorting before it. It names every file it found. Put the change in the
adaptation, then put the copy back with `yg pack update <name> --reinstall` (see
[Repairing a copy](#repairing-a-copy)).

Everything you want different goes in the `yg-aspect.adapt.yaml` written beside
each rule. `yg pack add` writes it for you, listing what you may change for that
kind of rule and every setting the rule reads, with the package's defaults —
all of it commented out:

```yaml
# Adaptation for the rule 'naming', installed from the package 'house-style'.
...
# config:
#   threshold: 40    # number
```

Uncomment what you want to change:

```yaml
status: advisory
review_by: 2027-01-31

config:
  threshold: 60
```

| Adaptable | What it does |
|---|---|
| `scope` | review granularity — `per: file`, a `files` filter |
| `reviewer` | which tier reviews it — reviewer rules only |
| `review_by` | when you want to re-examine whether it still earns its place |
| `references` | supporting files for the reviewer — reviewer rules only, see below |
| `status` | `draft` / `advisory` / `enforced` |
| `companion` | a repo-relative path to *your* companion module, instead of the package's — reviewer rules only |
| `config` | the settings the rule reads (see below) |

The stub offers only the keys that mean something for its rule: a rule with a
`check.mjs` is not offered `reviewer`, `references` or `companion`, and a rule
that only bundles others is not offered `scope`.

Not adaptable: `name`, `description`, `implies`, `errs`, `when`, and every code
file. Those are what the rule **is**; changing them would make it a different
rule wearing the package's name. Naming one of them is refused, and so is a key
the adaptation does not recognise at all — a misspelled key that was quietly
dropped would leave a rule looking tuned when it is not.

An adaptation you have not touched behaves exactly as the package does — and
keeps doing so across updates. Its settings are commented out, so each one
follows the package's default, including when a newer version changes it. A
setting you uncomment is yours: it wins over the package's default from then on,
and an update that changes that default tells you it is shadowing it.

### The rule's history

A rule's history — a change of status noticed by `yg check --approve`, an
entry written with `yg aspects log add` — lives in `log.md` beside a rule of your
own. An installed rule's directory is the package's copy and holds nothing the
package did not ship, so its history is written beside the adaptation instead,
as `yg-aspect.adapt.log.md`. Like the adaptation it is yours: the copy rail never
judges it, and an update or a reinstall carries it across.

A rule's regression cases (`drills/`) are part of the package. `yg drill add` on
an installed rule is refused: send the case to its author, so it ships with the
next version.

### `references` is for reviewer rules; `ctx.config` is for the rest

`references:` is adaptable, but it only means anything on a reviewer rule:
reference files are supporting material put in front of the reviewer. A script rule
(one with a `check.mjs`) has no reviewer to put anything in front of, so declaring
`references:` on one is refused — in an adaptation exactly as in the rule's own
file, because an adaptation is merged in *before* the rule is validated and does
not bypass anything. The refusal names the adaptation, the one file of the rule
that is yours to change.

That is the design line, not an oversight: **`ctx.config` is the way a
script rule is parameterized, and the only way.** It is also the better
one. A setting a rule reads becomes part of that rule's verdict (below), so
changing it re-opens exactly the verdicts it could have changed — something a
reference file could not offer.

If you need a rule to consult a table that lives in your repository, ask its
author for a `config` key holding what the rule needs, or fork the rule.

## Settings a rule reads (`ctx.config`)

A package can declare settings its rules read, with defaults:

```yaml
# yg-package.yaml, in the publishing repository
config:
  naming:
    threshold:
      type: number
      default: 40
```

The rule reads them through `ctx.config`:

```js
export function check(ctx) {
  const limit = ctx.config.threshold;
  // ...
}
```

and you set them in the adaptation. **A setting a rule reads is part of its
verdict.** Change a threshold and that rule's recorded verdicts go back for
judging, because the answer it gave was an answer about the old number.

Only settings the rule actually **reads** count. Changing one nothing consults
re-opens nothing, and changing one that a single rule reads re-opens that rule
alone — never every rule in the package.

## Updating

```bash
yg pack update house-style                    # the newest published version
yg pack update house-style --to 2.0.0         # this version, pinned
yg pack update house-style --to latest        # the newest, and follow it again
yg pack update                                # every installed package
```

A package installed without a version follows the newest one: `update` takes the
highest published tag. A package installed at a version, or moved with `--to`, is
pinned: a plain `update` leaves it where it is and names what else is published.

Going back a version is refused unless you say so in so many words — an older
rule can accept what the installed one refuses:

```bash
yg pack update house-style --to 1.2.0 --allow-downgrade
```

The copied files are replaced. **Your adaptations — and the rule's history
beside them — are carried across byte for byte.** Rules whose content actually
changed go back to unverified, and `yg check --approve` judges them again; rules
that did not change keep their verdicts. Before it swaps anything in, `update`
says what the new version changes about each rule: rules added and removed, a
change of status (a `draft` rule that is now `enforced`), a change to what a
rule implies or to its scope, which of its files changed, and every setting that
was added, removed, or got a new default — including one your adaptation sets.

An update is all or nothing. It fetches, checks and judges **every** package the
run names before it replaces a single file: an edited copy, a source that does
not answer, a version whose tag, `yg-package.yaml` and marketplace entry
disagree, a package that needs a newer Yggdrasil, or a rule the new version drops
while your graph still attaches it — any of them stops the whole run with nothing
changed, and says so. If replacing a copy then fails on the disk itself, the
command says exactly which packages were already updated and which were not.

One case does not stop the others. When `yg pack update` runs with no name, a
package whose source publishes no version of it at all — typically one an
earlier release installed from the source's default branch, before versions
were tags — is left as it is and named at the end, with what to do about it,
and the run exits 1 after updating every other package. Named on its own, the
same package is refused.

A record written by an earlier release names no tag or commit. The next `update`
that reaches the tag of the installed version records both, even when there is
nothing newer to take, so `yg pack verify` can notice a moved tag from then on.

A rule the new version no longer ships is removed with its adaptation; the update
says so. While anything in your graph still names such a rule — a component, one
of its ports, a type, a flow, or another rule's `implies:` — the update is
refused, listing what does. Detach it, or attach whatever replaces it, and run
the update again.

A setting you set in an adaptation that the new version no longer declares is
refused when the graph loads, naming the key — a setting that quietly stopped
being read would leave your repository enforcing something other than what you
configured. The update warns you about it first.

## Repairing a copy

```bash
yg pack update house-style --reinstall
```

When a copied file was edited or deleted and version control cannot put it back
(an install that was never committed, say), `--reinstall` fetches the version the
record names and puts the copy back exactly as it was installed, keeping your
adaptation. It is refused if what the source publishes under that version today
is not what was installed — because then nothing could be put back faithfully —
and the refusal names the cause: the publisher moved the tag, or the publisher
re-used the version number for different content.

Either way, the choice to take what the source publishes under that number now
is yours, and it is made in so many words:

```bash
yg pack update house-style --reinstall --accept-republished
```

It takes the content the tag names today under the version already installed,
keeping your adaptation and its history, says what it changes about each rule
first, records the new commit and file hashes, and is refused like an update if
it would drop a rule your graph still attaches. A plain `update`, or `--to` the
installed version, never takes it: both say the number was re-used and change
nothing.

## Verifying against the source

```bash
yg pack verify              # every installed package
yg pack verify house-style
```

`yg check` guarantees that the copy is what the record says was installed. The
record itself is a committed file, though, and anyone who can change it can
change it together with the copy. `yg pack verify` asks the source: does the
recorded tag still point at the recorded commit, does what it holds hash to what
the record says, and is the copy on disk still that. Any "no" exits 1, naming
it, and says per package what to do next. A package installed from a plain
directory is compared with the directory as it is now; one recorded by an earlier
release, with no commit, is compared file by file with its version's tag, and the
next `yg pack update` records the tag and commit.

Two outcomes are not an edited copy. When the tag holds different files from the
copy although it has not moved as far as the record can tell, verify says the
publisher re-used the version number and names `--reinstall --accept-republished`.
When a copy was installed by an earlier release from a source that has never
published its version, there is nothing to compare it with: verify says so, and
names what works — `yg pack update <name>` once the source publishes any version,
or asking the author to tag the one you have; `yg pack remove` if you would
rather not depend on it. Both still exit 1: verify passes only a copy it could
match against its source.

## Seeing what you have

```bash
yg pack list
```

Names, versions, whether each one is pinned or follows the newest, where each
came from, the tag and commit it was taken from, and whether each copy is still
untouched. It also names newer versions — but only when the source actually
answers. A source that cannot be reached produces silence, never a claim that
you are up to date.

Running `yg pack list` (or `add`, or `update`) also writes down what each source
told it, in a small local file beside the graph
(`.yggdrasil/.yg-packages-versions.json`, never committed — it is knowledge about
someone else's repository, and it is thrown away and rebuilt freely). `yg advise`
then reads that and carries it as an attention item, ranked below everything the
graph works out about your own code, with the command that takes the newest
version (`yg pack update <name> --to <version>`). Everything in it that came from
the package — its name, its versions, its source — is shown as quoted data, never
as a sentence written in the tool's own voice.

The split matters: `yg advise` never reaches outside your repository, because
your agent runs it every session and every other thing it reports comes from your
graph, your history and your files. Asking other repositories what they publish
happens when *you* ask about packages, and the feed reads what that recorded. So a
package you have never asked about is simply not mentioned — silence means "not
asked yet", never "you are up to date".

## Removing

```bash
yg pack remove house-style
```

The rules, their adaptations and the record go. It refuses while anything in
your graph still names one of the rules — a component, one of its ports, a type,
a flow, or a rule of your own that `implies:` one — listing what does: removing
rules something still names makes every check fail on dangling names rather than
on anything real. Detach first, then remove.

## Running a pack command from anywhere

Every `yg pack` command works on the repository the graph belongs to, from any
directory inside it: run from `src/sub`, `add` installs into the root's
`.yggdrasil/`, and `list` and `remove` read the root's record. One pack command
changes the record at a time — a second one started while the first is running
is refused rather than allowed to overwrite the first one's record.

## Publishing a package

Start one with two commands:

```bash
yg marketplace init          # yg-marketplace.yaml, packages/, and a CI check
yg pack new house-style      # one package, one example rule, and its drills
```

`marketplace init` refuses rather than overwrite a manifest that is already there
— that file is the whole record of what the repository publishes. If
`.github/workflows/` exists it also writes `.github/workflows/yg-marketplace.yml`,
which runs the check below on every push, and leaves it alone if it is already
there.

`pack new` scaffolds the package, adds it to the manifest, and writes one rule
that reads one setting along with the two drill cases that rule needs — the
smallest complete thing you can then edit into what you meant.

A marketplace is a git repository with `yg-marketplace.yaml` at its root:

```yaml
schema: yg-marketplace/1
packages:
  - name: house-style
    path: packages/house-style
    version: 1.2.0
```

Each package directory carries its own manifest:

```yaml
schema: yg-package/1
name: house-style
version: 1.2.0
requires:
  yg: "^6.0.0"
aspects:
  - naming
  - error-messages
config:
  naming:
    threshold:
      type: number
      default: 40
```

Beside it sit the rule directories, each an ordinary Yggdrasil rule — the same
`yg-aspect.yaml`, `content.md` / `check.mjs`, and `drills/` you would write for
your own repository. See [Aspects](/aspects). A rule may import a helper module
from its own directory; every file there other than its drills is part of the
rule's verdict, so a new version that changes only a helper re-opens the verdicts
it could have changed.

Two things are different inside a package:

- **Names are relative.** A rule that bundles another writes
  `implies: [naming]`, never a full path. The package does not know where it will
  be installed. A rule outside the package cannot be implied at all — a package
  stands on its own.
- **`requires.yg` is a promise.** It says which versions of Yggdrasil the package
  was written against. Installing refuses when the running version does not
  satisfy it, naming both. `pack new` writes `^<major>.0.0` — the running major,
  and not the next one. It is also what carries a rule across releases: every
  `yg-aspect.yaml` accepts only the keys its release knows, so a rule using a key
  a later release added must say so here, and an older Yggdrasil then refuses the
  install instead of loading the rule without the key. The check happens only at
  install and update, never while a graph loads: if you move the CLI back to an
  older version after installing, a rule carrying a key that version does not
  know fails to load with `aspect-unknown-key`. Take a release of the package
  built for the version you run, or move the CLI forward again.

Publish a version by tagging it `pack/<package>@<version>`:

```bash
git tag pack/house-style@1.2.0 && git push --tags
```

That tag is the version. `@1.2.0` and `--to 1.2.0` check it out; a consumer
installing without a version takes the highest such tag; `yg pack list` and
`yg advise` read the tags to tell a consumer a newer version exists. The version
in the tag, `version:` in `yg-package.yaml` and the entry in
`yg-marketplace.yaml` must agree — a consumer is refused a version whose three
disagree. Never move a published tag, and never publish different content under
a version number consumers already hold: a consumer's `yg pack verify` reports
either, and their `--reinstall` refuses it until they accept it with
`--accept-republished`. Publish a new version instead.

Every directory in a package must be declared in `aspects:`, and every declared
one must exist. An undeclared rule directory would arrive in someone's repository
as rules nobody announced; a declared one that is missing would install as a rule
they can attach and that can never run.

## Authoring a package

::: tip This section is the short version
The full account — including how to extract a rule you already have — is the
knowledge topic your agent reads: `yg knowledge read packages-and-marketplaces`.
That topic is the canonical text; this page follows it.
:::

### Extracting a rule you already have

Copy `.yggdrasil/aspects/<id>/` to `packages/<package>/<rule>/` and then make four
decisions. There is no extractor, because these are the whole of the work.

**What is the rule, and what is a setting.** A constant in `check.mjs` another
repository would reasonably want different is a setting: read it as
`ctx.config.<name>` and declare it with a default. A constant another repository
changing would make it a different rule stays written into the rule.

**What names a path only you have.** Four things stop meaning what you meant the
moment the rule lands somewhere else:

| Remove | Why |
|---|---|
| `review_by` | your repository asking *itself* to re-examine a rule — published, it fires in everyone else's, on a date they did not pick |
| `references` | a repository-relative path read at review time; the package cannot know their layout |
| a literal root in `scope.files.path` | `src/**` matches a repository laid out that way and silently nothing everywhere else — write `**/src/**` |
| `reviewer.tier` | tiers are named per repository; yours may mean a different model at a different price in theirs — a warning rather than a refusal, since sometimes you do mean it |

The first three are refusals: `yg marketplace check` exits non-zero on each. The
tier is a warning — it is reported and the check still passes, because a package
that really does mean one named tier is a thing you are allowed to publish.

**How a bundle names its siblings.** Inside a package, `implies: [naming]` — a
bare directory name, never a full path. A package may not imply anything outside
itself.

**The proof it ships with.** A script rule needs at least one
`drills/violates-…/` case and one `drills/satisfies-…/` case. Those two are the
only thing that shows a consumer what the rule refuses and what it allows, before
they trust it.

### Checking before you publish

```bash
yg marketplace check
```

Free, deterministic, no key, and non-zero on any refusal — it is what the CI file
`marketplace init` writes runs for you. It asks five things: that the two
manifests agree — with each other on the name and the version, with the
directories that exist, and with the Yggdrasil running the check on `requires.yg`
— and that the package holds nothing an install refuses (a symbolic link, a
binary file), that every rule loads under the
same loader a consumer will use, that every `implies` stays inside its package,
that every setting read is declared and every setting declared is read, and that
nothing in the package is anchored to your own repository.

Everything `yg pack add` refuses about a package's manifests and files is asked
here too, through the same readers, so a package the check passes is one that
installs. When the marketplace is the root of a git repository, what git ignores
is left out, because an install clones your tag and never sees it: a
`node_modules/` you installed locally is fine while `.gitignore` covers it, and
refused like any undeclared directory once it would be published. Anywhere else —
a plain directory, or a marketplace nested inside another repository's working
tree — nothing is left out, because `yg pack add` copies such a source as it is on
disk, ignored files included.

Every finding names a code — `package-config-undeclared`, `package-drills-missing`,
`package-scope-literal-root`, `package-version-mismatch` and so on — and the
knowledge topic lists what each one means.

One limit, stated rather than implied: **it does not run your drills.** Running a
case needs a repository to run it in, and a marketplace has no graph — which is
why this command never asks for one. It checks the cases are there and shaped
the way the runner recognises. To watch them pass, install the package somewhere
with a graph and run `yg drill --aspect <id>`: a drill hands the rule the case
files as `ctx.files` and `ctx.subject`, and its settings — the package's
defaults, with that repository's adaptation over them — as `ctx.config`. A rule
that needs the rest of the graph context (`ctx.node`, `ctx.graph`, `ctx.fs`, the
parsers) is reported as unsupported by a drill, not as failing.

## What the tool refuses

| Situation | What happens |
|---|---|
| A copied file was edited | `yg check` blocks, naming the file, the adaptation, and `yg pack update <name> --reinstall` |
| A copied file is missing | `yg check` blocks — a rule with a piece gone stops applying rather than failing loudly |
| A file among the copies that no package installed | `yg check` blocks — that is how a rule nobody chose would wear a package's name |
| A rule of your own under `.yggdrasil/aspects/packages/` | It is not loaded, and `yg check` names the directory as reserved for installed packages |
| The package record names an install directory other than `<owner>/<repo>/<name>` | `yg check` blocks, and every pack command refuses it — that value is a directory the commands delete |
| An adaptation names a key that is not adaptable | The graph refuses to load, naming the key |
| An adaptation puts `references:` on a rule with a `check.mjs` | The graph refuses to load, naming the adaptation — use `config` instead |
| A setting the package does not declare | The graph refuses to load, naming the key and the package |
| `implies` reaching outside the package | The graph refuses to load, naming both rules |
| The package needs a newer Yggdrasil | Installing refuses, naming both versions |
| The source publishes no version of the package | Installing refuses — a version is a tag, and nothing is read at the default branch |
| The tag, `yg-package.yaml` and the marketplace entry disagree on the version | Installing and updating refuse, naming all three |
| A version older than the installed one | `update --to` refuses without `--allow-downgrade`; a plain `update` leaves the package and says so |
| The recorded source now says it belongs to another publisher | Updating refuses |
| A rule the new version drops is still named in your graph | Updating refuses, listing what names it |
| A rule the package would install has the same name as one already here | `yg pack add` refuses, naming it — remove the existing rule, or install under a different `--as <owner>/<repo>` |
| A package with the same name is already installed from another publisher | `yg pack add` refuses, naming both |
| The package carries a symbolic link | Installing refuses, naming the link — a link published elsewhere would resolve against *your* filesystem once copied in |
| The package carries a binary file | Installing refuses, naming the file — a package ships rules and case files |
| The source cannot be reached | Nothing is installed or changed, and nothing is left behind |
| Another pack command is running | Refused; a lock left by a process that is gone is taken over |

The check that guards copied files is built into `yg check` rather than written
as a rule. It has no script you can sharpen and no marker you can suppress,
deliberately: a copy you can quietly change would not be a copy of anything.

## What packages deliberately are not

No registry, no dependency resolution between packages, no version ranges, no
signatures, and no per-attachment configuration. A package is a directory of
rules you copied from a repository you named, and everything above follows from
keeping it that small.

Which also means the trust question is yours and is not delegated anywhere.
`yg check` proves your copy is what your record says was installed; the record
says which tag and commit that was, and `yg pack verify` asks the source whether
that still holds. None of it proves the source is who it claims to be: there are
no signatures, and anyone who can change the committed record can change it
together with the copy. Review a change to `.yggdrasil/yg-packages.yaml` the way
you review code. Re-read the warning at the top of this page: installing a
package is running someone else's code, every time you check.
