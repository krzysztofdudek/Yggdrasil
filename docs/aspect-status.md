# Aspect Status

Yggdrasil aspects ship with three enforcement levels: `draft`, `advisory`,
`enforced`. **Status governs how results render**, and it never changes a
verdict's input hash or whether a recorded verdict stays valid and is re-used.
Beyond rendering it has two operational effects: `draft` removes a pair from the
expected set entirely (nothing is verified for it), and — so a known-broken node
never bills the reviewer — an `enforced` deterministic refusal on a node makes
`yg check --approve` skip that node's LLM pairs for the run. Otherwise it is the
dial you turn as a rule matures: start silent, gather signal, then enforce.

## Three levels

| Status      | A refusal renders as | An unverified pair renders as | Blocks `yg check`? |
|-------------|----------------------|-------------------------------|--------------------|
| `draft`     | pair not expected    | pair not expected             | no                 |
| `advisory`  | warning              | warning                       | no                 |
| `enforced`  | error                | error                         | yes                |

A pair whose **effective** status is `draft` is not expected — nothing is
verified for it and no new verdict is written. (Effective status is the strictest
level across every channel that attaches the aspect, so an aspect authored
`status: draft` is still enforced wherever an attach site or an active implier
raises it — see [How effective status is computed](#how-effective-status-is-computed).)
A verdict already recorded for a pair survives a `draft` round-trip and stays in
the lock — see [Status and verdicts](#status-and-verdicts). `advisory` and
`enforced` pairs are both verified and cached the same way; the level only changes
severity. Severity follows status with one exception: **advisory never blocks**
(whether a pair is refused or merely unverified) and **enforced always blocks** —
but a `prompt-too-large` failure is an error regardless of status, so an advisory
pair can still block `yg check` if its assembled prompt exceeds the resolved
tier's `max_prompt_chars`. Status is the only thing that cannot soften it: like
every other finding below, an oversized pair your change did not reach is listed
as a warning when [progressive mode](/progressive-mode) is on, and `yg check
--full` blocks on it again. On a project that names no branch — the default — it
blocks on every run, advisory or not.

One project-level setting changes where an enforced finding blocks, and only
there: when [progressive mode](/progressive-mode) is on — the project names a
branch in `progressive.reference` — an enforced finding your change did not reach
is listed as a warning instead of an error, and `yg check --full` blocks on it
again. Status is unchanged by this: the pair is still enforced, still verified and
cached the same way, and still blocks the moment a change reaches it. On a project
that names no branch (the default), the table above is the whole story.

## When to use each

- **`draft`** — content.md / check.mjs is still being authored, or the
  rule is unclear. Zero cost, zero expected pairs. Use this while iterating
  on the rule text before any node has a real verdict. A draft aspect is
  still runnable via `yg aspect-test` (status never gates that diagnostic;
  `--dry-run` previews the prompt for free, a live run calls the reviewer).
  `draft` is also the only way to park an aspect without a provider key —
  it removes the pairs rather than leaving them red. For LLM aspects with a
  `companion.mjs` hook: when the aspect is `draft`, the hook never runs
  during `yg check --approve`; `yg aspect-test` still runs it live.
- **`advisory`** — rule is complete; gather signal across the repo
  without blocking CI. Pairs are verified and cached normally; refusals and
  unverified pairs surface as warnings. Use this to measure how often a rule
  fires on real code before promoting it.
- **`enforced`** — rule is vetted; violations should block CI. Refusals and
  unverified pairs are errors that block `yg check`.

A typical lifecycle: draft while authoring → advisory for one or two
sprints to observe behavior → enforced once you have confidence the rule
fires only on real violations.

## Declaring status

`status:` can appear on the aspect itself (aspect-level default) and on
every object-form attach site. The aspect-level default applies wherever
the aspect attaches unless an attach site declares its own.

### Aspect-level default

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
name: Audit Logging
description: "Every mutation emits an audit event"
status: advisory               # default for every attach site
reviewer:
  type: llm
```

If `status:` is omitted, the aspect defaults to `enforced`.

### Per-node attach site

```yaml
# .yggdrasil/model/orders/yg-node.yaml
aspects:
  - id: audit-logging
    status: enforced           # promote on this node only
```

Bare-string entries (`- audit-logging`) inherit the aspect-level default.
Object form (`{ id, status }`) is the only way to override per site.

### Architecture node-type default

```yaml
# .yggdrasil/yg-architecture.yaml
node_types:
  command:
    aspects:
      - id: cli-contract
        status: enforced
```

### Flow-level

```yaml
# .yggdrasil/flows/checkout/yg-flow.yaml
aspects:
  - id: correlation-tracking
    status: advisory
```

### Port-level

```yaml
# .yggdrasil/model/payments/yg-node.yaml
ports:
  charge:
    aspects:
      - id: idempotency
        status: enforced
```

## How effective status is computed

For each (node, aspect) pair, the resolver collects every channel that
attaches the aspect (after `when` filtering), then takes the maximum:

```
effective_status = max(declared in each channel)
```

where `draft < advisory < enforced`. The strictest level wins.

If an attach site explicitly declares a status **lower** than what the
cascade would yield from other channels (plus the aspect-level default),
the validator emits `aspect-status-downgrade` as an error. The rule is
**bump up OK, downgrade is an error**: a node can promote an aspect to
`enforced`, but it cannot quietly weaken what the architecture or a flow
demands.

To resolve a downgrade error: remove the explicit lower status from the
attach site, or raise the lower-ranked channel to match.

This `max()` computation and the downgrade check apply to the cascading
attach channels 1–6 (own, ancestor, own type, ancestor type, flows,
ports). Channel 7 (implies) does not declare a `status:` — it carries
`status_inherit:` instead, described in the next section.

## Implies propagation

> **Terminology note:** In the `implies:` mechanism, aspects implied by another aspect are sometimes informally called "companions" in prose (as in "an implies bundle promotes its implied companions"). This is a different concept from **companion files** — the optional `companion.mjs` hook on an LLM aspect that resolves per-unit files for the reviewer. This page uses "implied sibling" or "implied aspect" to avoid ambiguity.

For aspect `A` that implies aspect `B`, propagation to a node depends on
A's effective status on that node and the `status_inherit:` modifier on
the implies edge.

### Draft is dormant

If A's effective status on node N is `draft`, then B is **not** propagated
via implies. Draft aspects have zero side effects. B may still arrive on
N through any other channel.

### Active implier — `status_inherit` modes

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
implies:
  - id: diagnostic-logging
    status_inherit: strictest        # default
```

Two modes:

- **`strictest`** (default) — B contributes `max(A_effective, B_default)`
  to the cascade. An implies bundle promotes its implied siblings. If A runs as
  `enforced` and B defaults to `advisory`, B becomes `enforced` on that
  node.
- **`own-default`** — B contributes `B_default` regardless of A. Use this
  to decouple propagation when an implied aspect should retain its own
  status even when reached through a stricter implier.

```yaml
implies:
  - id: diagnostic-logging
    status_inherit: own-default      # keep B at its own default
```

Bare-string implies entries (`implies: [diagnostic-logging]`) inherit the
`strictest` default.

## Status and verdicts

Status is deliberately **not** part of a pair's input hash. Verdicts survive
every status flip — flipping `advisory ↔ enforced` (or a full `draft` round-trip
and back) never re-runs the reviewer; the recorded verdict carries forward as
long as the pair's real inputs are unchanged.

What each transition does:

- **`draft → advisory/enforced`** — the aspect's pairs become *expected*. If they
  were never verified, they appear as `unverified` until `yg check --approve`
  fills them. If they already hold a valid verdict (a `draft` round-trip), they
  are instantly re-used — no reviewer call.
- **`advisory → enforced`** — re-uses the existing verdict; nothing re-runs. But
  if that verdict is a refusal, the pair now renders as an error instead of a
  warning, so a passing check can turn red. Promote intentionally and expect any
  recorded refusal to surface.
- **`enforced/advisory → draft`** — the aspect's pairs leave the expected set.
  Their lock entries are kept (verdicts survive), so returning to enforced re-uses
  them; garbage collection only prunes a pair that is genuinely gone (aspect
  detached, file deleted, `when` now false), never one parked at `draft`.

## `when` is not `status`

The `when` predicate decides whether an aspect **applies** to a node.
Status decides what happens **when it applies**. They are orthogonal:

- `when=false` → aspect is invisible on the node. No pair, no
  verdict, no display in `yg context`. Costs nothing.
- `status=draft` → aspect applies but produces no expected pair. Appears in `yg
  context`, no reviewer call, no recorded verdict.

Use `when` to model applicability (this rule only applies to nodes that
call an external service). Use `status` to model rule maturity (this
rule is still being authored / observed / enforced).

See [Conditional Aspects](/conditional-aspects) for the `when` predicate
grammar.

## See also

- [Aspects](/aspects) — rules, and the seven ways one reaches your code
- [The lock](/the-lock) — how verdicts are stored
- [Reviewers](/reviewers) — how the reviewer is invoked
- [Conditional Aspects](/conditional-aspects) — `when` predicates
- [CLI Reference](/cli-reference) — issue codes emitted by `yg check`
