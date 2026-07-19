---
layout: home
title: Yggdrasil
hero:
  name: Yggdrasil
  text: Stop babysitting your agent.
  tagline: Your rules become checks the agent can't skip, run on every change before it moves on. A script runs them for free, or a model reviews the call a script can't make.
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
  - icon: 🛑
    title: Caught before it moves on
    details: Every change is reviewed inside the loop, by a free local script or a model. Violations have to be fixed to proceed.
  - icon: ⚡
    title: A green build can't lie
    details: Each verdict is tied by hash to the exact code it checked. CI re-proves every rule with no LLM calls and no keys, so a change that was never re-verified can't ride through green.
---

## Right now, you are the feedback loop

Your agent reads `CLAUDE.md` and applies maybe 70% of it. Tests pass, lint passes, the code compiles, but it skipped the audit log on a payment mutation. A rules file is a suggestion. There are three ways to work with an agent, and most people are stuck in the middle.

- **Autocomplete.** It suggests, you write the rest. One small use case.
- **You are the loop.** It generates whole changes, and you check each one, send it back, check again. This is where the day goes.
- **A full feedback loop.** It runs a real check, reads the failure, and fixes itself before you look.

::: tip Yggdrasil gives the agent a loop of its own.
Before it edits, `yg context` hands it only the rules that touch the file. After it edits, `yg check --approve` verifies them, and the agent fixes any failure before it moves on. This is code review while the agent works, not after.
:::

## A rule is plain text

You write what must be true and why. The reviewer reads it and checks your code against it.

```markdown
# Audit logging on payment mutations

Every function that changes a payment record must call
auditLog.emit() before it returns. A mutation with no
audit event is a refusal.
```

When a script can decide it, you write the rule as a small local script instead — it runs for free, with no model at all.

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

::: info Next
New here? Read [How it works](/how-it-works) for the full picture, then [Get started](/getting-started) and set up your first verified rule in five minutes. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more.
:::
