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

The wizard walks you through platform selection and reviewer setup.
It fetches available models from your provider, validates the connection,
and writes the config for you.

`yg init` also installs a **rules file** for your platform (e.g. `.cursor/rules/yggdrasil.mdc`
for Cursor, a line in `CLAUDE.md` for Claude Code). This file teaches the agent the
Yggdrasil protocol: when to run `yg context` before reading code, when to run
`yg approve` after writing, how to create nodes and aspects. You don't need to
explain any of this to your agent — the rules file handles it.

Supported platforms: Cursor, Claude Code, GitHub Copilot, Codex, Cline,
RooCode, Windsurf, Aider, Gemini CLI, Amp, OpenCode.

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

**Pre-commit hook (package.json):**

```json
{
  "scripts": {
    "precommit": "yg check"
  }
}
```

If check fails, it means source files changed without being approved.
Tell the agent to fix it.

---

_Want to understand the model?_

- [Core concepts](/core-concepts) — aspects, nodes, flows, graph structure
- [Configuration](/configuration) — reviewer setup, quality thresholds
- [CLI reference](/cli-reference) — all commands
