// CANONICAL. This topic is the source of truth for how a package is authored,
// extracted and maintained. `docs/packages.md` carries the same substance under
// "Authoring a package" for a reader with a browser and no terminal.
//
// The duplication is unavoidable and is stated here rather than hidden: the docs
// site is static markdown read by VitePress at build time, and this module is a
// TypeScript string bundled into the published CLI, so neither build can read the
// other's file. When the two disagree, THIS FILE is right and the page is stale.

/** What a repository's own files say about its relationship to packages. */
export type PackageRepoKind = 'publisher' | 'consumer';

/**
 * One sentence for `yg prime` to add when this repository publishes or consumes
 * packages, and nothing at all when it does neither.
 *
 * A BUILDER rather than a constant, and the caller supplies the input — the same
 * shape as `digestBlockBody(cliVersion())` in `templates/digest.ts`, and for the
 * same reason: working out which kind of repository this is means looking at the
 * disk, and a knowledge document may not. It probes nothing and reads nothing;
 * the command layer, which is allowed to, hands it the answer.
 *
 * It adds a sentence to the manual rather than a section, and it never touches
 * `AGENT_RULES_CONTENT` — that string is hand-tuned and explicitly not generated.
 */
export function marketplaceNoticeLine(kind: PackageRepoKind): string {
  const situation =
    kind === 'publisher'
      ? 'This repository publishes Yggdrasil rules for other repositories to install'
      : 'This repository runs rules installed from another repository';
  return `${situation} — read \`yg knowledge read packages-and-marketplaces\` before changing anything under a package.\n`;
}

export const summary =
  'Publishing rules: recognising a marketplace, extracting an aspect from a repository into a package by hand, what stays the rule and what becomes a setting, updating a package, and what every marketplace check refusal means.';

export const content = `# Packages and marketplaces

A **package** is a set of rules one repository publishes and another installs. A
**marketplace** is the repository that publishes them. There is no registry: a
consumer installs from the URL they type, so the same package published from two
forks is two different packages and neither can claim the other's name.

You are on the PUBLISHING side of this topic. For the consuming side —
\`yg pack add\`, adapting a copy, updating — read the same page in the docs or run
\`yg pack list\` in a repository that has some.

## Recognising one

| You are looking at | When |
|---|---|
| A **marketplace** | \`yg-marketplace.yaml\` at the repository root |
| A **package** | a directory with \`yg-package.yaml\` in it, named by that manifest |
| A repository that **consumes** packages | \`.yggdrasil/yg-packages.yaml\`, and rules under \`.yggdrasil/aspects/packages/\` |

A repository can be both. A marketplace does NOT need a \`.yggdrasil/\` of its own
— it publishes law rather than enforcing any — which is why \`yg marketplace check\`
never asks for a graph and never tells you to run \`yg init\`.

## Starting one

\`\`\`bash
yg marketplace init          # yg-marketplace.yaml, packages/, and a CI check
yg pack new house-style      # one package, one example rule, and its drills
yg marketplace check         # everything below, before anyone can install it
\`\`\`

\`marketplace init\` refuses rather than overwrite an existing manifest — that file
is the whole record of what the repository publishes. If \`.github/workflows/\`
exists it also writes \`.github/workflows/yg-marketplace.yml\`, and leaves it alone
if it is already there.

\`pack new\` scaffolds \`packages/<name>/\` with a manifest, one \`example/\` rule that
reads one setting, and the two drill cases that rule needs. It refuses a name with
a separator in it (a package name is one directory in every repository that
installs it) and refuses to scaffold over a directory that already exists.

Publish a version by tagging it \`pack/<package>@<version>\`. Nothing else is
needed; that tag is what a consumer's \`@1.2.0\` checks out.

## Extracting a rule you already have into a package

This is the common case: a rule earns its place in your repository and you want
to publish it. Do it by hand — there is no extractor, and the judgement below is
the reason.

**1. Copy the directory.** \`.yggdrasil/aspects/<id>/\` becomes
\`packages/<package>/<rule>/\`. The rule's own name is the directory name from now
on; the id it had here is a fact about this repository.

**2. Decide what is the rule and what is a setting.** This is the whole of the
work. A constant in \`check.mjs\` that another repository would reasonably want
different is a SETTING; a constant that another repository changing would make it
a different rule is part of the rule.

\`\`\`js
// Before — a threshold nobody else can move:
const LIMIT = 400;

// After — a setting, declared in yg-package.yaml with a default:
const limit = ctx.config.maxLines;
\`\`\`

\`\`\`yaml
# yg-package.yaml
config:
  file-length:            # the rule's directory name
    maxLines:
      type: number
      default: 400
\`\`\`

A setting a rule READS enters that rule's verdicts, so a consumer changing it
sends exactly that rule's verdicts back for judging and leaves every other rule's
alone. A setting nothing reads changes nothing — which is why \`marketplace check\`
warns about a key you declared and never read.

**3. Strip the paths.** Anything naming a directory only your repository has stops
meaning what you meant elsewhere:

| Remove | Why |
|---|---|
| \`review_by:\` | your repository asking ITSELF to re-examine a rule. Published, it is your reminder firing in everyone else's repository, on a date they did not pick. |
| \`references:\` | a repository-relative path read at review time. The package cannot know their layout, so it resolves to whatever is there — or to nothing. |
| A literal root in \`scope.files.path\` | \`src/**\` matches only a repository laid out that way, and silently nothing everywhere else. Write \`**/src/**\`. |
| \`reviewer.tier\` | tiers are named per repository. Yours may not exist there, and where it does it may mean a different model at a different price. (A warning, not a refusal — sometimes you mean it.) |

**4. Make \`implies\` relative.** Inside a package a bundling rule names its
siblings by directory alone — \`implies: [naming]\`, never a full path. The package
does not know where it will be installed, and the loader prefixes every relative
name with the install path. A package may not imply a rule outside itself at all:
it has to stand on its own.

**5. Bring the drills.** A deterministic rule must ship at least one
\`drills/violates-…/\` case and at least one \`drills/satisfies-…/\` case. The
directory is \`drills\`, and the FIRST path segment of a case is what says which it
is — the prefix is exactly \`violates-\` or \`satisfies-\`, and the case file may sit
at any depth beneath it. Those two cases are the only thing that shows a consumer
what the rule refuses and what it lets through, before they trust it.

**6. Declare it.** Add the rule's directory to \`aspects:\` in \`yg-package.yaml\` and
the package to \`packages:\` in \`yg-marketplace.yaml\`. Every directory in a package
must be declared and every declared one must exist: an undeclared directory would
arrive in someone's repository as law nobody announced.

## You adapt beside a copy; you never edit one

The rule a consumer installs stays byte for byte what you published — \`yg check\`
refuses an edited copy by name, and \`yg pack update\` refuses to run while one
exists. Everything they want different goes in the \`yg-aspect.adapt.yaml\` written
beside each copy: its granularity, its reviewer, its standing, its review date,
its references, and any setting you declared.

That is not protectiveness, and it matters when you are the author: it is what
lets an update be a REPLACEMENT rather than a merge. Publish a new version and
their copy is replaced and their adaptation carried across untouched. Nothing you
publish has to reason about what they changed, because they changed nothing.

Two consequences for you:

- **A setting you remove breaks their repository at load,** naming the key — so a
  key you publish is a promise. Prefer leaving one and ignoring it, or bump the
  major.
- **A rule's \`name\`, \`description\`, \`implies\`, \`errs\`, \`when\` and every code file
  are NOT adaptable.** They are what the rule IS. Anything you want a consumer to
  tune has to be a setting.

## Updating a package you publish

1. Change the rules.
2. Raise \`version:\` in \`yg-package.yaml\` AND the entry in \`yg-marketplace.yaml\`.
3. \`yg marketplace check\`.
4. \`git tag pack/<package>@<version> && git push --tags\`.

A consumer's \`yg pack update\` compares against those tags. A rule whose content
actually changed goes back to unverified in their repository and gets judged
again; a rule that did not keep its verdicts.

## Reading \`yg marketplace check\`

Deterministic, free, no key, and it exits non-zero on any refusal. Each finding
names its own code:

| Refusal | What it means |
|---|---|
| \`marketplace-manifest-missing\` | you are not in a marketplace — run \`yg marketplace init\` |
| \`marketplace-manifest-invalid\` | the root manifest will not parse, or an entry is missing a field, or a version is not semver |
| \`marketplace-entry-missing\` | an entry names a directory that has no \`yg-package.yaml\` |
| \`marketplace-dir-unlisted\` | a directory under \`packages/\` that the manifest never names |
| \`package-manifest-invalid\` | a package's own manifest is mis-shaped — including a directory it does not declare, or a config default that contradicts its type |
| \`package-name-mismatch\` | the manifest, the entry and the directory disagree about the package's name |
| \`package-aspect-invalid\` | a rule ships both \`check.mjs\` and \`content.md\`, or neither with nothing implied, or will not load |
| \`package-implies-escapes\` | a rule implies something that is not a bare name of a rule in this package |
| \`package-config-undeclared\` | a rule reads a setting the manifest never declared |
| \`package-scope-literal-root\` | a scope glob anchored to a directory name |
| \`package-review-by-present\` | a published rule carries a review date |
| \`package-references-repo-path\` | a published rule names a reference file |
| \`package-drills-missing\` | a deterministic rule with no cases, or with only one of the two kinds |
| \`package-file-unreadable\` | a file that cannot be read cannot be copied or checked |

And three warnings, which do not fail the check: \`package-config-unused\` (declared
and never read), \`package-config-dynamic\` (the rule reaches its settings through a
computed name, so this check can only confirm the ones written out),
\`package-reviewer-tier\`, and \`package-drills-unrecognized\` (a directory under
\`drills/\` under neither prefix — the runner skips it silently, so it looks like a
case and runs as none).

**\`marketplace check\` does not run your drills.** Running a case needs the graph
context a rule is handed, and a marketplace has no graph — which is the whole
reason this command does not load one. It checks that the cases are there and
shaped the way the runner recognises. To watch them actually pass, install the
package in a repository that has a graph and run \`yg drill --aspect <id>\`.

## What packages deliberately are not

No registry, no dependency resolution between packages, no version ranges, no
signatures, and no per-attachment configuration. A package is a directory of rules
copied from a repository somebody named, and everything above follows from keeping
it that small.

Which also means the trust question is not delegated anywhere. Installing a
package is running its author's code on every check — say what your package does
in its rules' descriptions, and expect to be read.
`;
