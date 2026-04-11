---
layout: home
title: Yggdrasil
---

<!-- markdownlint-disable MD025 -->

<div align="center">
  <img src="/logo.svg" alt="Yggdrasil" width="150" />
</div>

# Yggdrasil

**Your AI agent doesn't know your architecture. It guesses, breaks things, and says it's done. Yggdrasil fixes that.**

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

Architecture, constraints, cross-cutting rules, decisions. One bounded context package. The agent respects rate limiting, follows event sourcing, handles saga rollback. Zero rework.

Now the agent writes code. What happens next is what makes Yggdrasil different from every other tool.

***

## The enforcement loop

Other tools stop at context delivery. Yggdrasil enforces it.

```
Agent writes code
  → yg check detects drift: "code changed since last approve"
  → yg approve runs reviewer: "do source files actually satisfy the aspects?"
  → Reviewer says no: aspect-violation — rate-limiting aspect not satisfied
  → Agent fixes the code
  → yg approve passes
  → Commit allowed
```

The agent cannot skip this. `yg check` blocks commits and CI. There is no `--force`. There is no "I'll do it later." The graph and the code must agree, or the agent doesn't ship.

This is the difference between giving an agent instructions and giving it walls. Instructions get treated ceremonially. Walls don't.

**What gets enforced:**

- **Drift detection.** Code changed since last approve? Error. Upstream context (aspects, flows) changed? Error. Must re-approve.
- **Aspect verification.** The graph says this module requires audit logging. The reviewer checks whether the source code actually has audit logging. Not whether the agent said it added it. Whether it's there.
- **Coverage.** Every git-tracked file must belong to a node. No orphan code. No dark corners where the agent can hide.
- **Blackbox is hermetic.** You can blackbox legacy code you don't want to touch. But the moment the agent changes a file inside a blackbox, the system refuses to approve until you decompose it into a proper node. No shortcuts.

***

## The problem

Every "memory tool" for AI agents does the same thing: parses your code with Tree-sitter, builds a call graph, and gives the agent more code to read. That doesn't help. The agent already reads code. What it can't read is why your payment service uses sync retries instead of a queue. Or that rate limiting applies to this module. Or that changing this interface breaks three downstream services.

That knowledge isn't in code. It never was. You can parse AST until the end of time and you won't extract architectural decisions, cross-cutting rules, or the business flow that passes through a function. Tree-sitter tells the agent where things are. Nobody tells the agent what things mean and what must not change.

So the agent guesses. It breaks things you didn't know it could reach. Then it says "done."

***

## How it works

**1. You build the graph.** Tell the agent what matters. It creates nodes, declares aspects and relations. 10-15 minutes for a first useful graph. Plain YAML and Markdown (aspect rules). No database, no server, no lock-in.

**2. The agent reads before it writes.** Before touching any source file, the agent runs `yg context` and gets a bounded context package. Architecture, constraints, aspects, dependencies, decisions. 5,000-10,000 tokens of exactly the right context, not 50,000 tokens of noise.

**3. The system enforces after it writes.** `yg check` detects drift between graph and code. `yg approve` runs a reviewer that verifies aspects are actually satisfied in source code, not just claimed. Both block commits. Both block CI.

**4. The graph grows as you work.** Every conversation enriches it. Knowledge survives sessions, survives people, survives switching between AI agents. Delete `.yggdrasil/` and your project works exactly as before.

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
Agent:  If enforceable, creates an aspect. Otherwise, notes in code comments.
```

The agent maintains the graph as part of normal conversations. Knowledge accumulates as you work.

***

## Early results

Tested on real open-source repositories: Hoppscotch, Medusa, Django, DRF, Caddy, Payload CMS. Python, Go, TypeScript. Agent with Yggdrasil graph context answered architectural questions correctly without reading source code. Results are promising but this is R&D, not a finished benchmark.

The persistent gap: decision capture. The hardest knowledge to extract is _why_ something was designed a certain way. This is also the highest-value content. Formal benchmarks will be published with the governance release.

***

## Supported platforms

Cursor · Claude Code · GitHub Copilot · Codex · Cline / RooCode · Windsurf · Aider · Gemini CLI · Amp

`yg init --platform <name>` generates the appropriate rules file. Adding a new platform is a single config file — PRs welcome.

***

## FAQ

**How is this different from a rules file (CLAUDE.md, .cursorrules)?**
Rules files are flat text. Global conventions pasted into every prompt. They don't know which rules apply to which part of the system. Yggdrasil is a structured graph with inheritance, scoped aspects, typed relations, and flows. Your agent gets context for the specific node it's working on, not a wall of text it has to filter through.

**How is this different from RAG?**
RAG retrieves text chunks that are textually similar to your query. It finds more files. It doesn't find the cross-cutting knowledge that lives between files, which aspects apply here, what business flow passes through this code, what breaks downstream if you change this interface. Yggdrasil captures architectural meaning, not textual similarity.

**How is this different from Tree-sitter based tools?**
Tree-sitter parses code into an AST. It tells the agent where functions are, what calls what, what imports what. That's useful but it only extracts what's already in the code. It can't extract why you chose sync retries over a queue, that rate limiting applies to this module, or that changing this interface breaks the checkout flow. Yggdrasil stores the knowledge that doesn't exist in code and never will. Tree-sitter tells the agent what IS. Yggdrasil tells the agent what SHOULD BE and checks whether the agent broke it.

**Does the agent actually follow the rules?**
The agent doesn't need to "follow" anything. `yg check` runs in CI. If the graph and code are out of sync, the build fails. If an aspect isn't satisfied in source code, the reviewer catches it at `yg approve`. The enforcement is mechanical, not behavioral. You don't ask the agent to be good. You make it impossible to ship bad work.

***

## License

MIT — see [LICENSE](https://github.com/krzysztofdudek/Yggdrasil/blob/main/LICENSE).
