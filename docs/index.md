---
layout: home
title: Yggdrasil
---

<!-- markdownlint-disable MD025 -->

<div align="center">
  <img src="/logo.svg" alt="Yggdrasil" width="150" />
</div>

# Yggdrasil

**Stop re-explaining your codebase. Give your agent a map.**

***

Your agent asks "add payment retry to OrderService." It runs `yg context --node orders/order-service` and gets:

```
DOMAIN       Orders — lifecycle states, event-sourced transitions
SELF         OrderService — create, validate, manage state
INTERFACE    createOrder(), retryPayment(), cancelOrder()
ASPECT       rate-limiting · max 3 retries/min per order
ASPECT       event-sourcing · all state changes via event log
ASPECT       idempotency · key = orderId + attempt
DEPENDS      PaymentService.charge() .refund()
ON FAIL      retry 3x → mark payment-failed
FLOW         Checkout: Orders → Payments → Inventory → Notify
DECISION     Sync retry chosen over queue — latency <500ms required
```

Architecture, constraints, cross-cutting rules, decisions — in one bounded context package. The agent respects rate limiting, follows event sourcing, handles saga rollback. Zero rework.

***

## The problem

Your agent reads code. It does not see that rate limiting applies here, that this area uses event sourcing, or that the retry logic exists because of a production incident six months ago. So it guesses. It breaks things you didn't know it could reach.

The most valuable knowledge in your codebase isn't in any file — it lives in the connections between files, in cross-cutting rules, in decisions that were made and alternatives that were rejected. Agents can't see that. Neither can grep. Neither can RAG.

***

## Quick start

```bash
npm install -g @chrisdudek/yg
```

```bash
cd your-project
yg init --platform cursor  # or: claude-code, copilot, codex, cline, windsurf, aider, gemini-cli, amp
```

`yg init` creates a `.yggdrasil/` folder and adds a rules file for your platform. Your existing rules are not touched.

Then tell your agent what it needs to know:

```
You:    "Map the payments module."
Agent:  Creates node payments/payment-service, writes responsibilities,
        declares relations to orders and inventory.

You:    "All payment operations must emit audit events."
Agent:  Creates aspect requires-audit, applies it to payment-service.

You:    "We chose sync retries over a queue because latency must stay under 500ms."
Agent:  Records the decision — including the rejected alternative.
```

First useful graph takes 10-15 minutes. After that, knowledge accumulates as you work. The agent maintains the graph as part of normal conversations.

Plain Markdown and YAML. No database. No lock-in. Delete `.yggdrasil` and your project works exactly as before.

***

## Results

Tested on real open-source repositories: Hoppscotch, Medusa, Django, DRF, Caddy, Payload CMS. Python, Go, TypeScript.

| What was tested                                                          | Result                        |
| ------------------------------------------------------------------------ | ----------------------------- |
| Architectural questions answered correctly (graph context only, no code) | **15/15**                     |
| Agent accuracy with zero code access, graph only                         | **89.5%**                     |
| Effectiveness vs manual expert protocol                                  | **97.5%**                     |
| Improvement over no-graph on constraint-aware tasks                      | **+178%**                     |
| Graph auto-constructed from git history — structural coverage            | **100%**                      |
| PR-based graph maintenance — precision                                   | **100%**, 0% false positives  |
| Keyword search node selection                                            | **89% precision**, 96% recall |
| Guided onboarding session (8-13 questions) — graph quality vs expert     | **82-90%**                    |

The persistent gap: decision capture (32-86%). The hardest knowledge to extract is _why_ something was designed a certain way. This is also the highest-value content.

***

## Supported platforms

Cursor · Claude Code · GitHub Copilot · Codex · Cline / RooCode · Windsurf · Aider · Gemini CLI · Amp

`yg init --platform <name>` generates the appropriate rules file. Adding a new platform is a single config file — PRs welcome.

***

## FAQ

**How is this different from a rules file (CLAUDE.md, .cursorrules)?**
Rules files are flat text — global conventions pasted into every prompt. They don't know which rules apply to which part of the system. Yggdrasil is a structured graph with inheritance, scoped aspects, typed relations, and flows. Your agent gets context _for the specific node it's working on_, not a wall of text it has to filter through.

**How is this different from RAG?**
RAG retrieves text chunks that are textually similar to your query. It finds _more files_. It doesn't find the cross-cutting knowledge that lives _between_ files — which aspects apply here, what business flow passes through this code, what breaks downstream if you change this interface. Yggdrasil captures architectural meaning, not textual similarity.

***

## License

MIT — see [LICENSE](https://github.com/krzysztofdudek/Yggdrasil/blob/main/LICENSE).
