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

If you selected an API provider, the wizard stores your API key in
`.yggdrasil/yg-secrets.yaml` (automatically gitignored). You can also
set keys via environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`) instead.

## 3) Your first aspect

After init, you have an empty graph. If you run `yg check` now, you'll see
all your source files listed as unmapped:

```text
$ yg check

my-project — 0 nodes, 0 aspects, 0 flows
Coverage: 0/50 source files (0%)

Errors (1):
  unmapped-files — 50 source files have no graph coverage.
```

This is expected. Tell your agent to create the first rule.

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
      yg-node.yaml          ← maps src/payments/, lists requires-audit aspect
```

Now run `yg check`:

```text
$ yg check

my-project — 1 nodes, 1 aspects, 0 flows
Coverage: 1/1 source files (100%)

Errors (1):
  unapproved payments — not yet approved
       Node has never been approved (no baseline):
         src/payments/
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

## 4) Existing codebase (brownfield)

`yg check` requires 100% file coverage. Every git-tracked source file must
belong to some node. On a fresh repo with 200 files and 0 nodes, check fails
immediately.

The fast path: **minimal nodes (no aspects) for everything you're not working
on, proper nodes with aspects for what you are.**

Tell your agent:

> "Create nodes without aspects for: src/legacy/, lib/, scripts/. Then create
> a proper node for src/payments/ with the requires-audit aspect."

Nodes without aspects are cheap — just a `yg-node.yaml` with a directory
mapping. No hashing, no LLM review. They auto-approve instantly and count
as covered.

When you start working on a covered area, add aspects to enforce rules.
This is how coverage naturally expands into enforcement as you work.

Practical steps for a 200-file repo:

1. Create 5-8 nodes without aspects for broad directory mappings
2. Create 1-2 nodes with aspects for your active work area
3. Run `yg approve` on all nodes (no-aspect = instant, with-aspect = reviewer)
4. `yg check` passes — CI is green
5. Add aspects to more nodes as you touch more code

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
