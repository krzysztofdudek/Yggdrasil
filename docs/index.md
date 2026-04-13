---
layout: home
title: Yggdrasil
---

<!-- markdownlint-disable MD025 -->

<div align="center">
  <img src="/logo.svg" alt="Yggdrasil" width="150" />
</div>

# Yggdrasil

**AI agents ignore your architecture rules. This enforces them.**

---

## The problem

You wrote 200 lines of rules in CLAUDE.md or .cursorrules. Your agent applies maybe 70% of them. The rest it "optimizes away" because it decided they're noise.

Tests pass. Lint passes. The code compiles. But the agent skipped audit logging on a payment mutation, called a service it shouldn't call from that layer, and used `Date.now()` in a module that must be deterministic. You catch it in review. Or you don't.

A rules file is a suggestion. There are no consequences for ignoring it.

---

## What Yggdrasil does

It turns suggestions into requirements that get mechanically verified.

You write architectural rules as **aspects** in plain Markdown. Things like "every public endpoint must use rate limiting" or "no direct database access from this layer." The agent manages the graph structure, you control what's enforced.

The agent runs `yg approve` after writing code, which triggers a reviewer that checks source files against every applicable aspect. Not whether the agent claims it followed the rules, but whether the code actually satisfies them. If it doesn't, the approval fails and the agent has to fix it.

You run `yg check` to see if everything is clean. In CI, as a pre-commit hook, whenever you want.

```
yg check   →  "source files changed since last approve"
           →  agent runs yg approve
           →  reviewer checks aspects vs source code
           →  aspect-violation: rate-limiting not satisfied
           →  agent fixes code, re-runs approve
           →  yg check passes
```

---

## Why not just a bigger rules file

A flat file with 200 rules dumps everything into every prompt. The agent filters what it thinks matters and skips the rest.

Yggdrasil scopes rules to where they matter. `yg context --file <path>` shows only the aspects that apply to that specific file. Instead of 200 rules, the agent sees 3-5 that are actually relevant.

When you change a rule, every file that should satisfy it gets flagged for re-approval automatically. Aspects reach files through five channels: directly on a node, by node type, through hierarchy, via port contracts, and through business process flows. One rule can cover dozens of files, and changing it triggers cascading re-verification everywhere.

---

## Quick start

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

The wizard walks you through platform selection and reviewer setup. It fetches available models from your provider, validates the connection, and writes the config for you.

Then tell your agent what matters:

```
You:    "All payment operations must emit audit events."
Agent:  Creates aspect requires-audit with content.md rules,
        applies it to payment nodes.

You:    "Map the orders module."
Agent:  Creates node orders/order-service with mapping and aspects.
```

The graph doesn't build itself automatically, and that's intentional. Architecture is coarse-grained, not a 1:1 mirror of your file tree. The agent builds it incrementally as you work. On an existing codebase, the agent starts by mapping the areas you're actively working on. Coverage grows organically.

Run `yg check` in CI or as a pre-commit hook. If it fails, tell the agent to fix it.

---

## Supported platforms

Cursor · Claude Code · GitHub Copilot · Codex · Cline · RooCode · Windsurf · Aider · Gemini CLI · Amp · OpenCode

`yg init --platform <name>` generates the rules file your agent expects.

**Reviewer providers:** Anthropic · OpenAI · Google · OpenAI-compatible · Ollama (local) · Claude Code CLI · Codex CLI · Gemini CLI

---

## FAQ

**How is this different from CLAUDE.md or .cursorrules?**
Rules files are flat text dumped into every prompt. They don't scope rules to where they matter and they don't verify anything. Yggdrasil delivers only relevant rules per file and then mechanically checks compliance.

**How is this different from RAG or Tree-sitter tools?**
Those tools help agents find more code. Yggdrasil enforces constraints that don't exist in code and never will. "Rate limiting required" isn't in any AST. "No direct DB access from this layer" isn't in any embedding.

**Does the agent actually follow the rules?**
It doesn't need to. `yg check` runs in CI. The agent runs `yg approve` which triggers a reviewer against source code. If an aspect isn't satisfied, check fails. The enforcement is mechanical, not based on the agent's good intentions.

---

## License

MIT — see [LICENSE](https://github.com/krzysztofdudek/Yggdrasil/blob/main/LICENSE).
