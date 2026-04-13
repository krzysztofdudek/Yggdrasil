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

If you prefer flags: `yg init --platform cursor` skips the platform prompt.

Supported platforms: `cursor`, `claude-code`, `copilot`, `cline`,
`roocode`, `codex`, `windsurf`, `aider`, `gemini`, `amp`, `opencode`, `generic`

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

Now run:

```bash
yg check
```

If the agent mapped the files and created the aspect, check will show drift
(source files exist but haven't been approved yet). Tell the agent to run
`yg approve` — the reviewer will check whether `src/payments/` actually
satisfies the rules in `content.md`.

If the code doesn't satisfy the aspect, the reviewer explains what's missing.
The agent fixes it and re-runs approve.

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

Add `yg check` to your CI pipeline. It exits with code 1 if there's drift,
which means the agent didn't approve its changes.

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
