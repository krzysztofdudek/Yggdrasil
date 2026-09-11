---
title: Packages
---

A package is a set of rules published by one repository and installed into
another. You take someone else's law, you keep taking their improvements, and
you tune it to your repository without ever editing what they wrote.

There is no registry. A marketplace is an ordinary git repository with a
manifest at its root, and a package is a directory inside it. What you type is
what you get.

::: danger Installing a package runs its author's code
A rule ships a script, and that script runs in your process on every `yg check`,
with everything your process can reach. What is fenced is what a rule may
**read** through the context it is handed — not the module itself. Install a
package only from a source you would give a shell to, and read what you are
installing.
:::

## Installing

```bash
yg pack add https://github.com/acme/law#house-style
```

That copies the `house-style` package from the `acme/law` repository into
`.yggdrasil/aspects/packages/acme/law/house-style/`, records what every copied
file hashed to, and writes a `yg-aspect.adapt.yaml` beside each rule for you to
tune.

Pin a version by adding it:

```bash
yg pack add https://github.com/acme/law#house-style@1.2.0
```

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

### Where the identity comes from

A package is filed under the repository that published it, so the same package
name from two different repositories installs side by side and neither can claim
the other's rules. That `<owner>/<repo>` comes from the URL you typed. Installing
from a local directory, it comes from that directory's git `origin`; a directory
with no origin has nothing to go on, and rather than guess from the directory
name — which would let two unrelated packages overwrite each other — the command
asks you to say:

```bash
yg pack add ../law-repo#house-style --as acme/law
```

That settles which package owns which names, and it is still checked rather than
assumed: if any rule the package would install already exists in this repository
under that exact name, `yg pack add` refuses and names it, rather than let one
quietly take the other's place. Remove the rule that is there, or install under a
different `--as`.

## Adapting, not editing

**You never edit an installed rule.** `yg check` refuses any change to a copied
file, and `yg pack update <name>` refuses to touch a package whose copy you have
changed. That is not protectiveness — it is what makes an update a replacement
instead of a merge. An edit you made to a copy would vanish the next time the
package moved, and nothing would record that it had ever been there.

`yg pack update` with no name works through your packages in name order and stops
at the first one whose copy was edited — so the packages sorting before it are
already updated and the record already rewritten when it refuses. Restore the file
it names and run it again to finish the rest.

Everything you want different goes in the `yg-aspect.adapt.yaml` written beside
each rule. `yg pack add` writes it for you, already listing what you may change:

```yaml
# Adaptation for the rule 'naming', installed from the package 'house-style'.
...
status: advisory
review_by: 2027-01-31

config:
  threshold: 40
```

| Adaptable | What it does |
|---|---|
| `scope` | review granularity — `per: file`, a `files` filter |
| `reviewer` | which tier reviews it |
| `review_by` | when you want to re-examine whether it still earns its place |
| `references` | supporting files for the reviewer — LLM rules only, see below |
| `status` | `draft` / `advisory` / `enforced` |
| `companion` | a repo-relative path to *your* companion module, instead of the package's |
| `config` | the settings the rule reads (see below) |

Not adaptable: `name`, `description`, `implies`, `errs`, `when`, and every code
file. Those are what the rule **is**; changing them would make it a different
rule wearing the package's name. Naming one of them is refused, and so is a key
the adaptation does not recognise at all — a misspelled key that was quietly
dropped would leave a rule looking tuned when it is not.

An adaptation you have not touched behaves, on the day you install, exactly as the
package does — but it does not stay inert. The `config:` block `yg pack add` writes
is live YAML, not commented-out examples: it pins every declared setting to the
package's default **as it stands at install time**. An update carries that file
across byte for byte, and a pinned value wins over the new default. So if the
package raises `threshold` from 40 to 80 in its next version, `yg pack update`
replaces the copy and your untouched adaptation keeps the rule running at 40.
Open the adaptation and either follow the new default or delete the key to track
it.

### `references` is for LLM rules; `ctx.config` is for the rest

`references:` is adaptable, but it only means anything on a rule an LLM reviews:
reference files are supporting material put in front of the reviewer. A rule with
a `check.mjs` has no reviewer to put anything in front of, so declaring
`references:` on one is refused — in an adaptation exactly as in the rule's own
file, because an adaptation is merged in *before* the rule is validated and does
not bypass anything.

That is the design line, not an oversight: **`ctx.config` is the way a
deterministic rule is parameterized, and the only way.** It is also the better
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
yg pack update house-style          # whatever the source now publishes
yg pack update house-style --to 2.0.0
yg pack update                      # every installed package
```

The copied files are replaced. **Your adaptations are carried across byte for
byte.** Rules whose content actually changed go back to unverified, and
`yg check --approve` judges them again; rules that did not change keep their
verdicts.

"Byte for byte" includes every setting the stub pinned when you installed, so a
default the package has since changed is shadowed by an adaptation you never
opened — see [above](#adapting-not-editing). An update never tells you that
happened; reading the new version's settings is on you.

If you edited a copy, the update refuses and names the files rather than
discarding your edit. Restore them, move the change into the adaptation, and run
it again. With no package named, that refusal stops a run that has already updated
everything sorting before the drifted package.

A setting you set in an adaptation that the new version no longer declares is
refused when the graph loads, naming the key — a setting that quietly stopped
being read would leave your repository enforcing something other than what you
configured.

## Seeing what you have

```bash
yg pack list
```

Names, versions, where each came from, and whether each copy is still untouched.
It also names newer versions — but only when the source actually answers. A
source that cannot be reached produces silence, never a claim that you are up to
date.

Running `yg pack list` (or `yg pack update`) also writes down what each source
told it, in a small local file beside the graph
(`.yggdrasil/.yg-packages-versions.json`, never committed — it is knowledge about
someone else's repository, and it is thrown away and rebuilt freely). `yg advise`
then reads that and carries it as an attention item, ranked below everything the
graph works out about your own code. Everything in it that came from the package — its name,
its versions, its source — is shown as quoted data, never as a sentence written
in the tool's own voice.

The split matters: `yg advise` never reaches outside your repository, because
your agent runs it every session and every other thing it reports comes from your
graph, your history and your files. Asking other repositories what they publish
happens when *you* ask about packages, and the feed reads what that recorded. So a
package you have never run `yg pack list` against is simply not mentioned —
silence means "not asked yet", never "you are up to date".

## Removing

```bash
yg pack remove house-style
```

The rules and the record go. It refuses while anything in your graph still
attaches one of them, listing what does: removing law something still names makes
every check fail on dangling names rather than on anything real. Detach first,
then remove.

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
  yg: ">=6.0.0"
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
your own repository. See [Aspects](/aspects).

Two things are different inside a package:

- **Names are relative.** A rule that bundles another writes
  `implies: [naming]`, never a full path. The package does not know where it will
  be installed. A rule outside the package cannot be implied at all — a package
  stands on its own.
- **`requires.yg` is a promise.** It says which versions of Yggdrasil the package
  was written against. Installing refuses when the running version does not
  satisfy it, naming both.

Publish a version by tagging it `pack/<package>@<version>`:

```bash
git tag pack/house-style@1.2.0 && git push --tags
```

That tag is what `@1.2.0` and `--to 1.2.0` check out, and what `yg pack list` and
`yg advise` read to tell you a newer version exists.

Every directory in a package must be declared in `aspects:`, and every declared
one must exist. An undeclared rule directory would arrive in someone's repository
as law nobody announced; a declared one that is missing would install as a rule
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

**The proof it ships with.** A deterministic rule needs at least one
`drills/violates-…/` case and one `drills/satisfies-…/` case. Those two are the
only thing that shows a consumer what the rule refuses and what it allows, before
they trust it.

### Checking before you publish

```bash
yg marketplace check
```

Free, deterministic, no key, and non-zero on any refusal — it is what the CI file
`marketplace init` writes runs for you. It asks five things: that the two
manifests agree with the directories that exist, that every rule loads under the
same loader a consumer will use, that every `implies` stays inside its package,
that every setting read is declared and every setting declared is read, and that
nothing in the package is anchored to your own repository.

Every finding names a code — `package-config-undeclared`, `package-drills-missing`,
`package-scope-literal-root` and so on — and the knowledge topic lists what each
one means.

One limit, stated rather than implied: **it does not run your drills.** Running a
case needs the graph context a rule is handed, and a marketplace has none — which
is why this command never asks for one. It checks the cases are there and shaped
the way the runner recognises. To watch them pass, install the package somewhere
with a graph and run `yg drill`.

## What the tool refuses

| Situation | What happens |
|---|---|
| A copied file was edited | `yg check` blocks, naming the file and pointing at its `yg-aspect.adapt.yaml` |
| A copied file is missing | `yg check` blocks — a rule with a piece gone stops applying rather than failing loudly |
| A file among the copies that no package installed | `yg check` blocks — that is how a rule nobody chose would wear a package's name |
| An adaptation names a key that is not adaptable | The graph refuses to load, naming the key |
| An adaptation puts `references:` on a rule with a `check.mjs` | The graph refuses to load — use `config` instead |
| A setting the package does not declare | The graph refuses to load, naming the key and the package |
| `implies` reaching outside the package | The graph refuses to load, naming both rules |
| The package needs a newer Yggdrasil | Installing refuses, naming both versions |
| A rule the package would install has the same name as one already here | `yg pack add` refuses, naming it — remove the existing rule, or install under a different `--as <owner>/<repo>` |
| The package carries a symbolic link | Installing refuses, naming the link — a link published elsewhere would resolve against *your* filesystem once copied in |
| The package carries a binary file | Installing refuses, naming the file — a package ships rules and case files, and copying is a text round-trip |
| The source cannot be reached | Nothing is installed or changed, and nothing is left behind |

The check that guards copied files is built into `yg check` rather than written
as a rule. It has no script you can sharpen and no marker you can suppress,
deliberately: the whole value of installing law from elsewhere is that what runs
is what its author published, and a check you can switch off would not carry
that.

## What packages deliberately are not

No registry, no dependency resolution between packages, no version ranges, no
signatures, and no per-attachment configuration. A package is a directory of
rules you copied from a repository you named, and everything above follows from
keeping it that small.

Which also means the trust question is yours and is not delegated anywhere.
Re-read the warning at the top of this page: installing a package is running
someone else's code, every time you check.
