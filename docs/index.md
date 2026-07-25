---
layout: home
title: Yggdrasil
hero:
  name: Yggdrasil
  text: Say it once.
  tagline: Write a rule and it holds in every session after that, without you repeating yourself. The agent gets only the rules that touch the file it is editing, and has to satisfy them before it moves on.
  image:
    src: /logo.svg
    alt: Yggdrasil
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: How it works
      link: /how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/krzysztofdudek/Yggdrasil
features:
  - icon: 🎯
    title: Only the rules that matter
    details: Before the agent edits a file, it gets the handful of rules that touch it, not a 200-line dump it half-ignores.
  - icon: 🔁
    title: Still there next session
    details: A rule you wrote last week applies to work you start today. Nobody restates it, and the agent does not get to quietly drop it.
  - icon: ⚡
    title: A green build can't lie
    details: Each verdict is tied by hash to the exact code it checked. CI re-proves every rule with no LLM calls and no keys, so a change that was never re-verified can't ride through green.
---

## The same rule, two sessions apart

**Monday.** You ask for a charge endpoint. Before writing anything, the agent pulls the rules that touch that file: audit events, input validation, no direct database access. It writes to them, and the check still catches a missing audit call. It fixes that and moves on.

**The following week, new session.** You ask for a refund endpoint. You say nothing about audit events. The same three rules are still in force, the agent writes to them, and the check passes first time.

That gap is the point. A rules file is re-read and half-applied every session. A rule here is attached to the code it governs and verified against it, so it survives the session boundary without you in the middle.

## A rule is plain text

You write what must be true and why. The reviewer reads it and checks your code against it.

```markdown
# Audit logging on payment mutations

Every function that changes a payment record must call
auditLog.emit() before it returns. A mutation with no
audit event is a refusal.
```

When a script can decide it, you write the rule as a small local script instead. It runs for free, with no model at all, on every single check.

## See it catch a mistake

The rule above is in place. The agent writes a refund and skips the audit call.

::: code-group

```ts [what the agent wrote]
async function refund(req) {
  await payments.refund(req.body.chargeId)
  return { ok: true }
}
```

```ts [after yg check refused it]
async function refund(req) {
  await payments.refund(req.body.chargeId)
  await audit('refund', req.body.chargeId) // added
  return { ok: true }
}
```

:::

The reviewer refused the first version at `yg check --approve`: *"refund changes a charge with no audit event."* The agent added the call, re-ran, and passed. You reviewed nothing.

## Two limits, before you start

**It enforces structure, not runtime behaviour.** It can require that you call the audit utility. It cannot prove the audit fired in production.

**A green check is only as good as the rule behind it.** A shallow rule passes shallow code. The enforcement is real; deciding what is worth enforcing stays yours.

::: info Next
New here? Read [How it works](/how-it-works) for the model, then [Get started](/getting-started). If you are adopting this on an existing codebase, read [Phase 0](/showcase#the-phase-0-reality) first — the honest version of what it costs before it pays.
:::
