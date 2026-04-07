<video src="https://github.com/user-attachments/assets/49c8fe8f-c3b9-4202-b655-7f987dcab4cb" controls></video>

# Yggdrasil

**Your AI agent doesn't know your architecture. It guesses, breaks things, and says it's done. Yggdrasil fixes that.**

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Stars](https://img.shields.io/github/stars/krzysztofdudek/Yggdrasil)](...)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/SZTbgsH8Wm)

---

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

---

## The problem

Every "memory tool" for AI agents does the same thing: parses your code with Tree-sitter, builds a call graph, and gives the agent more code to read. That doesn't help. The agent already reads code. What it can't read is why your payment service uses sync retries instead of a queue. Or that rate limiting applies to this module. Or that changing this interface breaks three downstream services.

That knowledge isn't in code. It never was. You can parse AST until the end of time and you won't extract architectural decisions, cross-cutting rules, or the business flow that passes through a function. Tree-sitter tells the agent where things are. Nobody tells the agent what things mean and what must not change.

So the agent guesses. It breaks things you didn't know it could reach. Then it says "done."

---

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

---

## Early results

Tested on real open-source repositories: Hoppscotch, Medusa, Django, DRF, Caddy, Payload CMS. Python, Go, TypeScript. Agent with Yggdrasil graph context answered architectural questions correctly without reading source code. Results are promising but this is R&D, not a finished benchmark. [Methodology and raw data](https://krzysztofdudek.github.io/Yggdrasil/).

The persistent gap: decision capture. The hardest knowledge to extract is _why_ something was designed a certain way. This is also the highest-value content. Formal benchmarks will be published with the governance release.

---

## Supported platforms

Cursor · Claude Code · GitHub Copilot · Codex · Cline / RooCode · Windsurf · Aider · Gemini CLI · Amp

`yg init --platform <name>` generates the appropriate rules file. Adding a new platform is a single config file — PRs welcome.

---

## FAQ

**How is this different from a rules file (CLAUDE.md, .cursorrules)?**
Rules files are flat text — global conventions pasted into every prompt. They don't know which rules apply to which part of the system. Yggdrasil is a structured graph with inheritance, scoped aspects, typed relations, and flows. Your agent gets context _for the specific node it's working on_, not a wall of text it has to filter through.

**How is this different from RAG?**
RAG retrieves text chunks that are textually similar to your query. It finds _more files_. It doesn't find the cross-cutting knowledge that lives _between_ files, which aspects apply here, what business flow passes through this code, what breaks downstream if you change this interface. Yggdrasil captures architectural meaning, not textual similarity.

**How is this different from Tree-sitter based tools?**
Tree-sitter parses code into an AST. It tells the agent where functions are, what calls what, what imports what. That's useful but it only extracts what's already in the code. It can't extract why you chose sync retries over a queue, that rate limiting applies to this module, or that changing this interface breaks the checkout flow. Yggdrasil stores the knowledge that doesn't exist in code and never will. Tree-sitter tells the agent what IS. Yggdrasil tells the agent what SHOULD BE and checks whether the agent broke it.

---

## Documentation

Full specification and architecture: [https://krzysztofdudek.github.io/Yggdrasil/](https://krzysztofdudek.github.io/Yggdrasil/)

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <img src="docs/public/logo.svg" alt="Yggdrasil" width="150" />
  <br/><br/>
  <a href="https://discord.gg/SZTbgsH8Wm">
    <img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white" alt="Discord" />
  </a>
  <br/>
  <sub>Building something similar or have questions? Join the Discord.</sub>
</div>
