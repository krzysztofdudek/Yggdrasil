---
title: Aspects
---

An aspect is one rule the reviewer enforces on your code. You write the rule once; the reviewer checks every change against it before your agent moves on. Aspects are where you say what "correct" means for your codebase — "every mutation logs an audit event", "no UI file imports the database client", "exported classes are PascalCase".

A rule comes in one of two flavors:

- **Plain Markdown** (`content.md`) — a rule written in prose, judged by an LLM. Use this for anything that takes reading and judgment, the kind of call a human reviewer makes.
- **A script** (`check.mjs`) — a small check that runs on your machine. Free and identical every time. Use this for mechanical rules a script can decide.

You pick the flavor per rule. Most teams use both.

## Anatomy of an aspect

An aspect is a directory under `.yggdrasil/aspects/<id>/`. Its path under `aspects/` is the aspect's ID — a top-level `audit-logging/` is `audit-logging`, a nested `logging/audit/` is `logging/audit`. Inside are two files: `yg-aspect.yaml` (name and description) and the rule itself.

```text
.yggdrasil/aspects/
  audit-logging/
    yg-aspect.yaml     ← name + description
    content.md         ← the rule, in plain Markdown
```

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
name: Audit Logging
description: "Every mutation must emit an audit event"
```

The `content.md` file *is* the rule. The reviewer reads it and checks your source against it, so write it the way you'd write a code-review comment — concrete and actionable, not aspirational.

```markdown
<!-- .yggdrasil/aspects/audit-logging/content.md -->
Every public mutation endpoint must emit an audit event before returning.

Use the shared `auditLog.emit()` utility. Do not build custom audit logic.
The event must include: user ID, action, timestamp, affected resource ID.
```

Specific rules produce reproducible verdicts. "Audit logging should be appropriate and comprehensive" gives the reviewer nothing to check against; the version above tells it exactly what to look for.

## Two kinds of reviewer, at a glance

| Reviewer | Use it for | Cost |
|---|---|---|
| **LLM** (`content.md`) | judgment calls a human reviewer would make — "mutations must emit audit events", "this handler validates its input semantically" | one call per check (paid) |
| **Deterministic** (`check.mjs`) | mechanical rules — forbidden API calls, naming conventions, import restrictions | runs locally, free, identical every run |

You don't set the kind in a config field — it's inferred from which file is present (`content.md` → LLM, `check.mjs` → deterministic, or neither file plus a non-empty `implies:` → an aggregating bundle that has no own reviewer and produces no own verdict). An LLM aspect may also ship an optional `companion.mjs` hook that resolves per-unit companion files — see [Reviewers](/reviewers) for authoring depth. See [Reviewers](/reviewers) to write either kind.

## Status, at a glance

Every aspect has a status that controls how its results show up. You move a rule along as your confidence grows: `draft` while you're still writing it (nothing is checked, nothing recorded), `advisory` once it's ready (failures show as warnings, CI stays green), `enforced` once you trust it (failures block CI).

Status defaults to `enforced`. See [Aspect Status](/aspect-status) for the full lifecycle.

## Two more fields worth knowing

Both are optional, both live in `yg-aspect.yaml`, and neither is part of a verdict's identity — adding or changing either one re-verifies nothing.

**`review_by:`** — a standing request to re-examine whether the rule still earns its place, written as a plain calendar day (`review_by: 2027-01-15`). Once the day has passed, `yg check` raises one warning per rule saying it is running unreviewed. That is all it does: it never blocks a build, never changes a verdict, and never moves the date by itself. Renewing or retiring the rule is a decision its owner makes. A date that is not a real day (`2027-02-30`) is a blocking error on that rule. Valid on any kind of rule.

**`errs:`** — the honest error direction of a *script* rule, one of `over`, `under`, or `exact`. `under` means the check only ever fires on a provable violation, so it has no false positives by design; `over` means it may flag code the rule does not actually forbid; `exact` means neither. It is a label for readers and for reporting — the waiver inventory uses it to warn when someone waives an `under` check, which by definition has no false positive to waive. Declaring it on a judgment rule or an aggregating rule is an error.

## Retiring a rule that blocks wrongly

A rule earns its place by catching real mistakes. But a rule can also block the *wrong* thing — refuse code that was actually fine — and when that happens often, the team stops trusting the rule and starts routing around it. To keep that visible, the rule-health view (`yg aspects --health`) has a **false-block** column: for each rule, how many of its past refusals a person later waived (with a `yg-suppress` marker) or overturned. A refusal that was fixed in the code never counts — only refusals a human decided were wrong. Where the history is thin the number is shown with a plain `(thin data)` label, never a precise-looking rate.

The count is a coarse read, not a precise verdict, and it can over-count in one rare case: it matches a waiver to a refusal by file and component, not by exact line, so if a waiver for a rule sits on the same file or component as an *unrelated* refusal from that same rule, that unrelated refusal can be tallied as a false block. Weigh a single hit with that in mind — it is thin-data by design and feeds a human review, never an automatic block.

Think of it as a **false-block budget** for the whole repo: every enforced rule quietly spends a little of the team's goodwill each time it blocks something that turns out to be fine, and the budget is finite. When it runs tight, the answer is not to raise the ceiling — it is to look at which rules are doing the most wrongful blocking and retire the worst offenders, which frees room for new rules worth adding. This is a judgement a person makes by reading the column, weighing it against what the rule is protecting; nothing in the tool ever retires a rule for you, and the false-block number never blocks a build or shows up as a required action. It is a signal for a periodic human review, in the same spirit as renewing or retiring a rule that has passed its review-by date.

The false-block column reads the *inside* record — refusals the tool itself made and a person later waived. There is also an *outside* companion. When a real miss gets written into the [incident ledger](/cli-reference#yg-incident) as a miscalibrated rule (`yg incident add --tag wrong-rule --aspect <rule>`), the rule-health view surfaces that too, in a **wrong-rule** column: how many recorded misses a person attributed to this specific rule. It is deliberately labelled thin — an incident is sparse, hand-written testimony, not a measured rate — and a miss recorded without naming a rule stays in the repo-wide count only, never against one rule. Same spirit as the false-block budget: an honest nudge for a human to look, never a gate.

## Scope, at a glance

By default an aspect reviews a whole component in one pass — `per: node`. The reviewer sees all of the component's files together, which is what cross-file rules need ("exactly one file exports this", "a correlation ID propagates across calls").

For rules that hold within a single file on its own ("every handler validates its input"), switch to `per: file`: one check per file. Use it only when the rule truly is file-local — a per-file reviewer can't see the rest of the component.

You can also narrow which files get reviewed with `scope.files`. One catch: the moment you write a `scope:` block at all, `per:` becomes required inside it — the `per: node` default applies only when there is no `scope:` block. Depth is in [Reviewers](/reviewers) and [The Lock](/the-lock).

## When something should be an aspect

Create an aspect when both of these hold:

1. The same pattern shows up in three or more files.
2. A reviewer can actually check it against the code.

The first keeps you from turning a one-off into a rule. The second is the line that matters most. "Every handler logs an audit trail" is a pattern *and* checkable — good aspect. "Code should be readable" is real, but no reviewer can decide it against source — not an aspect. Things already visible in the code (imports, config) and things that aren't verifiable (pricing, strategy) don't belong here either.

## How a rule reaches your code

You attach a rule once, and it can cover a single component or many. You never copy-paste a rule onto each file by hand. Attach `audit-logging` to a parent component and every component beneath it inherits it. Attach it to a node type and every component of that type picks it up. The tool computes where each rule lands, and `yg context` shows you, for any file, which rules apply and where each one came from.

That's all you need day to day. Below is the full list, for when you need it — the seven ways a rule can reach a component:

| Channel | A rule reaches a component when… |
|---|---|
| Own | it's listed in the component's own `aspects:` |
| Ancestor node | a parent component carries it (children inherit) |
| Own type | the component's type declares it as a default |
| Ancestor type | a parent component's type declares it as a default |
| Flow | the component takes part in a flow that carries it |
| Port | the component consumes a port that requires it |
| Implied | another effective rule pulls it in via `implies` |

A rule the reviewer checks is the same wherever it came from — the component has to satisfy every rule that reaches it. See [Nodes](/nodes) for what these rules attach to, and [Conditional Aspects](/conditional-aspects) for applying a rule to only a subset of components.

## Bundling rules (implies)

A rule can pull in others. Declare `implies: [other-rule]` and every component that gets the first rule automatically gets the implied ones too, recursively. This lets you group several atomic rules under one named bundle — attach the bundle once, and each child rule still produces its own clean verdict. See [Reviewers](/reviewers) for authoring depth.

## Reference files and companion files

An LLM rule has two ways to bring in supporting material:

- **Static references (`references:`)** — a lookup table, an error-code catalogue, an API contract. Listed in `yg-aspect.yaml`; the same files go to the reviewer for every unit. Your agent sees them under the `read:` paths in `yg context`.
- **Per-unit companion files (`companion.mjs`)** — a hook that resolves different files for each unit under review. Use this when each file being reviewed has a unique counterpart in another node — a scenario document paired with its matching test spec, a migration paired with its schema. The hook returns paths; the runner reads the files and injects them into that unit's prompt only. A companion's verdict folds everything it reads to decide, so read narrowly (one file via `ctx.fs.read`). See [Reviewers — Per-unit companion files](/reviewers#per-unit-companion-files).

The two mechanisms are independent. Static references are identical for every unit; companion files vary per unit. Both count toward the tier's `max_prompt_chars` prompt-size limit. See [Reviewers](/reviewers) for authoring depth on both.

## Organizing rules in directories

A rule's id is its folder path under the rules directory, so ids can nest: `logging/audit` lives at `logging/audit/`. A folder with no rule file of its own is just a grouper. Use nesting to keep a growing rule set legible — group related rules under a shared prefix instead of a flat list. Nesting is naming only; it does not make one rule inherit another. What a rule applies to comes from where it's attached (see [How a rule reaches your code](#how-a-rule-reaches-your-code)), never from where its files sit.

## Positive and negative rules

A rule can require something to be present ("every handler validates its input") or forbid something ("nothing reaches the data store directly") — that's just how the rule is worded. A powerful shape is a broad **negative** rule attached to a parent so it covers every component beneath it, with the one component type that's legitimately allowed to do the forbidden thing carved out — that type carries its own **positive** rules ensuring it does it correctly. The carve-out is a [conditional rule](/conditional-aspects): `when: { not: { node: { type: data-access } } }`. The pattern is general — "no raw outbound HTTP except the gateway", and so on.
