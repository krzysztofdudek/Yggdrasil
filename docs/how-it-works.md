---
title: How it works
---

You lay the track. Your agent drives. The reviewer keeps it on the rails.

The point of laying track rather than repeating directions is that it is still there tomorrow. A rule you write once governs every session after it, including the ones you have not started yet.

The track is a set of rules and structure that live next to your code, in a `.yggdrasil/` directory in your repo. The rules say what your code must do: "every payment handler emits an audit event", "UI code never imports the database client". The agent writes code as usual. Before that code is done, the reviewer checks it against the rules and won't let the agent move on until it complies. When it drifts, the reviewer catches it and sends it back to fix course, in the same session, while the context is still fresh.

## Right now, you are the feedback loop

There are three ways to work with an agent, and most people are stuck in the middle.

- **Autocomplete.** It suggests the next line, you write the rest. One small use case.
- **You are the loop.** It generates whole changes, and you check each one, send it back, check again. This is where the day goes.
- **A full feedback loop.** It runs a real check, reads the failure, and fixes itself before you look.

::: tip Yggdrasil gives the agent a loop of its own.
The check runs inside the agent's loop, not in your review afterward. The agent reaches you already green, instead of you policing every change by hand.
:::

## The three players

**You** say what matters, in plain language. "Services that touch money must log an audit trail." "Background jobs can't call the HTTP layer directly." You don't write YAML or wire up a graph by hand. You state the rule and the intent.

**Your agent** turns that into structure. It keeps the graph under `.yggdrasil/` in step with your code: it writes the rules down, says where each one applies, and records which source files belong to which component. You work *with* the agent to build and change this. It knows the schema and the commands; you provide the judgment.

**The reviewer** verifies the code. It is a separate step: either an LLM call that reads your rule and your source and decides whether the code satisfies it, or a free local script for rules that can be checked mechanically (an import ban, a naming convention). The reviewer is the thing that actually says yes or no.

## The loop

From the agent's point of view, every change runs this cycle:

1. **Before editing**, the agent runs `yg context --file <path>`. It gets only the rules in force on that one file, not the whole rulebook, so it writes code that fits them instead of guessing and getting bounced.
2. **After editing**, it runs `yg check --approve`. The free local scripts run first, then the remaining rules go to the LLM reviewer.
3. **On a pass**, the verdict is recorded in the lock. The LLM reviewer's verdicts live in a committed file; the free local-script verdicts live in a gitignored local cache that any checkout rebuilds for free.
4. **On a failure**, the agent gets specific feedback (which rule, which file, what is wrong), fixes it in the same session, and re-runs. It loops here until green.
5. **In CI**, a free, keyless step rebuilds the local-script cache, then `yg check` confirms the recorded verdicts still hold for the current code.

::: info CI is free and keyless — and a green build can't lie
CI does not call the LLM reviewer and needs no API keys. Because the free local-script verdicts live in a gitignored cache, a fresh checkout first rebuilds that cache with `yg check --approve --only-deterministic` (free and keyless), then plain `yg check` confirms every recorded verdict still holds — and re-checks, live and for free, that the code's real dependencies match its declared relations. Each verdict is tied by hash to the exact code it checked, so a file that changed but was never re-verified turns the build red — a stale or unverified change can't ride through as green. The LLM verification happens locally while the agent works; CI just re-proves it was done. The mechanics live in [The lock](/the-lock).
:::

## Nobody restates the rules

The loop above runs the same way whether it is the first session on a file or the fortieth. The rules are attached to the code, not to a conversation, so a new session inherits them without being told. That is the difference between a rules file, which is re-read and half-applied each time, and a rule that is verified against the code it governs.

There is a worked example of a refused change and the fix on the [home page](/).

## You never trace the rules by hand

A file can pick up rules from several places at once: its own component, a parent component, its type, a flow it takes part in. You never work that out yourself by reading the graph. You ask the tool:

```bash
yg context --file src/payments/charge.ts
```

It prints every rule in force on that file, plus the path to each rule's text. The graph computes it, you read the answer. `yg context --node <path>` gives the picture from a component's side, and additionally shows where each rule comes from — the component's own declaration, a parent, its type, or a flow.

## What lives next to your code

Everything Yggdrasil needs sits in `.yggdrasil/`, committed alongside your source. Three things matter day to day:

- **Aspects** are your rules. Each one is a plain-Markdown statement of what the code must do, checked by the reviewer. See [Aspects](/aspects).
- **Nodes** are your components. Each maps a set of source files and lists the rules that apply to them. See [Nodes](/nodes).
- **Flows** are your processes. A flow ties components together as one business process so a shared rule applies across all of them. See [Relations, flows, and ports](/relations-flows-ports).

A rule is just a few lines of Markdown:

```markdown
# aspects/requires-audit/content.md
Every public mutation must emit an audit event before returning.

Use the shared auditLog.emit() utility, not custom audit logic.
The event must include: user ID, action, timestamp, resource ID.
```

The reviewer reads that and checks your code against it. Write rules the way you would write a clear code-review comment.

::: info No lock-in
Delete `.yggdrasil/` and your project builds and runs exactly as before — no build dependencies, no runtime hooks. The few artifacts that live outside it are the agent-rules files `yg init` wrote (`AGENTS.md`'s summary block, the import line it added to `CLAUDE.md`, and `.clinerules/yggdrasil.md`); delete those too if you want no trace left.
:::

## What it costs before it pays

On an existing codebase the first step is usually not writing rules, it is finding out that the code does not match the architecture you thought you had. That work is real and it comes first. [Phase 0](/showcase#the-phase-0-reality) is the honest account of it, along with a per-feature earn-rate: which parts of the schema paid for themselves in practice and which only start to matter once a project grows.

## Where next

- [Getting started](/getting-started): install, init, and set up your first verified rule in five minutes.
- [Aspects](/aspects): how a rule is written and reviewed.
- [Phase 0 and earn-rates](/showcase): what adoption actually costs, feature by feature.
