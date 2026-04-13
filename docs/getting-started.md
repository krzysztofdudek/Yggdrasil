---
title: Getting Started
---

## 1) Install

```bash
npm install -g @chrisdudek/yg
```

## 2) Init

```bash
cd your-project
yg init
```

The wizard asks two things:

1. **Which AI coding platform?** (Cursor, Claude Code, Copilot, etc.)
   This installs a rules file that teaches your agent the Yggdrasil protocol.
2. **Which reviewer provider?** (Anthropic, OpenAI, Google, Ollama, etc.)
   The wizard fetches available models, lets you pick one, and validates
   the connection.

That's it. Takes about a minute. The wizard creates `.yggdrasil/` with
config, schemas, architecture defaults, and the rules file for your platform.

The architecture file (`.yggdrasil/yg-architecture.yaml`) comes pre-configured
with common node types: `module`, `service`, `library`, `infrastructure`, `data`.
These work out of the box. You can customize them later — add new types, set
default aspects per type, constrain relations. Tell the agent to do it:

> "Add a node type 'api' with a default aspect 'requires-auth'."

## 3) Your first aspect

After init, you have an empty graph. Tell your agent to create the first rule.

Example prompt:

> "Every service that handles payments must emit audit events.
> Create an aspect for this and apply it to the payments module."

The agent will create:

```text
.yggdrasil/
  aspects/
    requires-audit/
      yg-aspect.yaml       ← name and description
      content.md            ← the actual rule (plain Markdown)
  model/
    payments/
      payment-service/
        yg-node.yaml        ← maps src/payments/, lists requires-audit aspect
```

Now run `yg check`:

```text
$ yg check

my-project — 1 nodes, 1 aspects, 0 flows
Coverage: 1/1 source files (100%)

Errors (1):
  unapproved payments — not yet materialized
       Node has never been approved (no baseline):
         src/payments.ts
       Verify source, then: yg approve --node payments

Result: FAIL (1 drift — 1 errors, 0 warnings)
```

Check detected that `src/payments.ts` is mapped but was never approved.
The agent runs `yg approve --node payments` and the reviewer reads the source
code, checks it against the rules in `content.md`, and reports:

```text
$ yg approve --node payments

Approved: payments
  Verified: 1 aspects satisfied.

Aspect verification:
  requires-audit — SATISFIED
```

If the code didn't satisfy the aspect, the output would show:

```text
ERROR: Reviewer found aspect violations.
  requires-audit — chargeCard() does not emit an audit event.
    No call to auditLog.emit() found in any mutation path.
  Fix the violations and re-run: yg approve --node payments
```

The agent fixes the code and re-runs approve until all aspects pass.

## 4) Growing the graph

You don't need to map everything at once. Map what you're working on,
leave the rest for later.

On an existing codebase, a practical approach:

1. Map the area you're actively changing (1-2 nodes)
2. Write aspects for the rules that matter most there
3. Work normally, let the agent handle `yg context` and `yg approve`
4. Expand coverage as you touch more of the codebase

Parts you don't want to manage at all can be blackboxed:

> "Create a blackbox node for src/legacy/ — we're not touching that code."

## 5) CI integration

Add `yg check` to your CI pipeline. It compares file hashes — no LLM calls,
runs instantly. Exit code 1 means source files changed without being approved.

**GitHub Actions:**

```yaml
- name: Check architecture
  run: npx @chrisdudek/yg check
```

If check fails, it means source files changed without being approved.
Tell the agent: "resolve all yg check issues" and it will run approve,
fix violations, and re-approve until check passes.

Yggdrasil is zero lock-in. Delete `.yggdrasil/` and your project works
exactly as before. No build dependencies, no runtime hooks.

---

_Want to understand the model?_

- [Core concepts](/core-concepts) — aspects, nodes, flows, graph structure
- [Configuration](/configuration) — reviewer setup, quality thresholds
- [CLI reference](/cli-reference) — all commands
