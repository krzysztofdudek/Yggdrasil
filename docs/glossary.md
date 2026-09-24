# Glossary

<!-- Generated from source/cli/src/templates/portal/js/glossary.js, which the portal also reads for its tooltips. Edit the entries there, then run `npm run glossary:update` in source/cli. -->

Each word here has one meaning, the same in these docs, in `yg prime`, in `yg knowledge`, in the CLI output and in the portal. Where an older word meant the same thing, it is listed as not used, so you can map it when you meet it in an old note.

## The graph

### node (component) {#node}

A component of your system as the graph records it: a directory under `.yggdrasil/model/` whose mapping lists the files it owns. Prose says component; the CLI says node.

More: [Nodes](/nodes).

### mapping {#mapping}

The list of paths a node owns. A file in some node’s mapping is node-owned.

More: [Nodes](/nodes).

### architecture type {#type}

A kind of node declared in `yg-architecture.yaml`. A type with a `when:` predicate is a classifying type: it can claim files by path or content.

More: [Nodes](/nodes).

### relation {#relation}

A declared dependency between two nodes (calls / uses / …). The code's real dependencies must match what's declared.

More: [Relations, Flows & Ports](/relations-flows-ports).

### flow {#flow}

A business process that spans several nodes — “place an order”. A rule attached to a flow reaches every node in it.

More: [Relations, Flows & Ports](/relations-flows-ports).

## Rules

### aspect (rule) {#aspect}

A rule the code must satisfy — e.g. “UI must not import the database”. Prose says rule; the graph and the CLI say aspect.

More: [Aspects](/aspects).

### rule kind {#rule-kind}

How a rule is checked. There are three kinds: a reviewer rule, a script rule and a bundle. The files in the rule’s directory decide the kind; no field sets it.

Not called: reviewer kind. More: [Aspects](/aspects).

### reviewer rule {#llm}

A rule written as prose (`content.md`) that the reviewer reads and judges the code against — judgment, and it may cost.

Not called: LLM aspect, judgment rule. More: [Reviewers](/reviewers).

### script rule {#deterministic}

A rule written as a script (`check.mjs`) that runs on your machine — mechanical, repeatable and free. A script rule has no reviewer.

Not called: deterministic aspect, deterministic reviewer. More: [Reviewers](/reviewers).

### bundle {#bundle}

A rule with no `content.md` and no `check.mjs`, only `implies:`. It brings in the rules it implies and records no verdict of its own.

Not called: aggregating reviewer. More: [Aspects](/aspects#bundling-rules-implies).

### status {#status}

How much a rule’s refusals count: draft, advisory or enforced, set by `status:` in the rule’s own file.

Not called: standing, enforcement level. More: [Aspect Status](/aspect-status).

### draft {#draft}

A rule parked as not-ready — it is removed from the expected set and verifies nothing.

More: [Aspect Status](/aspect-status).

### advisory {#advisory}

A rule whose refusals show as warnings. They never block.

More: [Aspect Status](/aspect-status).

### enforced {#enforced}

A rule whose refusals are errors: they fail `yg check` and block CI. The default status.

More: [Aspect Status](/aspect-status).

### when-filtered {#when-filtered}

A rule was deliberately filtered out here — it does not apply to this node.

More: [Conditional Aspects](/conditional-aspects).

### attach channel {#channel}

One of the seven ways a rule reaches a node: its own list, an ancestor, its type, an ancestor’s type, a flow, a port, or another rule’s implies.

More: [Aspects](/aspects#how-a-rule-reaches-your-code).

### own {#own}

This rule is set directly on this component.

### ancestor {#ancestor}

This rule is inherited from a parent component.

### own type {#own-type}

This rule applies to every component of this type.

### ancestor type {#ancestor-type}

Inherited from a parent component's type.

### port {#port}

This rule crosses in from a named contract this component consumes.

### implied {#implied}

Pulled in by another rule that includes this one.

## Judging

### reviewer {#reviewer}

The model configured in the `reviewer:` section of `yg-config.yaml`. It judges reviewer rules, and only those; nothing else is called the reviewer.

Not called: judge. More: [Reviewers](/reviewers).

### tier {#tier}

The named reviewer setting an aspect uses — which model judges it, and how strictly. Tier means this and nothing else.

More: [Configuration](/configuration).

### consensus {#consensus}

How many times the reviewer voted on a rule — more votes, more confidence in the verdict.

More: [Configuration](/configuration).

### cost {#cost}

A script rule costs nothing; the reviewer may cost a paid API call each time it judges.

### pair {#pair}

One rule checked against one unit — the thing a verdict is recorded for.

More: [The Lock](/the-lock#pairs-and-units).

### unit {#unit}

What one check covers: a node’s files together for a `per: node` rule, a single file for a `per: file` rule.

More: [The Lock](/the-lock#pairs-and-units).

### verdict {#verdict}

What a check of one pair concluded — passed or refused — bound by hash to the exact inputs it saw.

More: [The Lock](/the-lock).

### fill {#fill}

The run that records verdicts: `yg check --approve`. Script rules run for free; reviewer rules go to the reviewer.

Not called: approving run, recording run. More: [CLI Reference](/cli-reference#yg-check).

### passed {#passed}

The verdict when the code satisfies the rule.

### refused {#refused}

The code broke the rule — with a reason you can read. Under an enforced rule it is an error; under an advisory one, a warning.

### verified {#verified}

The rule was checked against the current code and it passed. The only green.

### unverified {#unverified}

No verdict matches the current code yet — it changed, or it was never checked. Not a pass — just “we don’t know”.

### warning {#warning}

An advisory rule flagged this. It does not block — it is signal worth a look, not a failure.

### not applicable {#not-applicable}

A rule was filtered out here on purpose — an empty cell, distinct from unverified.

### approval {#approval}

A person’s sign-off — on a waiver’s reason, an advise item, the choice of a reviewer. The `--approve` flag runs a fill; it is not an approval.

### drill {#drill}

`yg drill`: replay a rule’s case corpus to prove it catches what it should. Drilling a reviewer rule calls the reviewer. To focus on one rule’s findings instead, run `yg check --aspect`.

Not called: drill into (for yg check --aspect). More: [CLI Reference](/cli-reference#yg-drill).

## Coverage

### covered {#covered}

The graph accounts for the file: it is node-owned, type-covered or excluded. Covered says nothing about whether a rule checks it.

More: [Configuration](/configuration#coverage-config).

### node-owned {#node-owned}

A file some node’s mapping lists.

More: [Configuration](/configuration#coverage-config).

### type-covered file {#type-covered}

A file no node owns that exactly one classifying type claims. That type’s `per: file` rules enforce it.

Not called: type-level lattice, type tier, component-free file. More: [Configuration](/configuration#coverage-config).

### type-level coverage {#type-level-coverage}

The feature that makes type-covered files, switched by `coverage.type_level`.

More: [Configuration](/configuration#coverage-config).

### excluded {#excluded}

A file under a `coverage.excluded` root. Yggdrasil ignores it everywhere.

More: [Configuration](/configuration#coverage-config).

### unmapped / uncovered {#unmapped}

A file the graph does not account for. Under a `coverage.required` root it is an unmapped error; elsewhere an uncovered warning that never blocks.

More: [Configuration](/configuration#coverage-config).

### unguarded {#no-rule}

Nothing is checking this part. Not broken — just unguarded. Absence of red is not a pass.

## The lock and waivers

### lock {#lock}

The committed record of reviewer verdicts, beside a local cache of script verdicts. CI re-proves it without a key.

More: [The Lock](/the-lock).

### line-scoped waiver {#waiver}

A `yg-suppress` marker with a reason. It waives one rule on the lines it covers — a single line, a bracketed range or the whole file — and needs the user’s sign-off.

Not called: file-level waiver. More: [Reviewers](/reviewers).

### waived {#waived}

Someone waived a rule here, on purpose, with a reason. Not the same as verified.

### suppressed {#suppressed}

A waiver skips a rule on specific lines, with a reason. Waived is not verified.

### live boundary {#boundary}

An undeclared code dependency, recomputed live right now — never read from the stored lock.

## The family

### family {#family}

The Yggdrasil tool family: Yggdrasil, Grain and Horde at the core, with the add-ons Ratatoskr, Urd, Researcher and Jarl. A group of look-alike files is not a family.

More: [Family Contracts](/family-contracts).

### law {#law}

The family’s word for the rules in the graph and the rails that hold every change to them. It is not a separate concept.
