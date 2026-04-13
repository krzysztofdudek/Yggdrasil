<p align="center">
  <img src="docs/public/demo.gif" alt="Yggdrasil enforcement loop" width="900" />
</p>

# Yggdrasil

**AI agents ignore your architecture rules. This enforces them.**

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Stars](https://img.shields.io/github/stars/krzysztofdudek/Yggdrasil)](...)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/SZTbgsH8Wm)

---

## The problem

You wrote 200 lines of rules in CLAUDE.md or .cursorrules. Your agent applies maybe 70% of them. The rest it "optimizes away" because it decided they're noise.

You tell it again. It does better for a while. Next session, same thing.

Tests pass. Lint passes. The code compiles. But the agent skipped audit logging on a payment mutation, called a service it shouldn't call from that layer, and used `Date.now()` in a module that must be deterministic. You catch it in review. Or you don't.

The real issue is simple: a rules file is a suggestion. There are no consequences for ignoring it.

## What Yggdrasil does

It turns suggestions into requirements that get mechanically verified.

You write architectural rules as **aspects** in plain Markdown. Things like "every public endpoint must use rate limiting" or "no direct database access from this layer." The agent manages the graph structure, you control what's enforced.

The agent runs `yg approve` after writing code, which triggers a reviewer (an LLM call) that reads source files and checks them against every applicable aspect. If the code doesn't satisfy a rule, the approval fails and the agent has to fix it.

The reviewer is configured during `yg init` — the wizard sets up the LLM provider (Anthropic, OpenAI, Google, Ollama, or others) and validates the connection.

You run `yg check` to see if everything is clean. In CI, as a pre-commit hook, whenever you want. If check doesn't pass, you tell the agent to fix it.

```
yg check   →  "source files changed since last approve"
           →  agent runs yg approve
           →  reviewer checks aspects vs source code
           →  aspect-violation: rate-limiting not satisfied
           →  agent fixes code, re-runs approve
           →  yg check passes
```

## Why not just a bigger rules file

Because a flat file with 200 rules dumps everything into every prompt. The agent filters what it thinks matters and skips the rest.

Yggdrasil scopes rules to where they matter. `yg context --file <path>` shows only the aspects that apply to that specific file. Instead of 200 rules, the agent sees 3-5 that are actually relevant.

And when you change a rule, every file that should satisfy it gets flagged for re-approval automatically. Aspects reach files through five channels: directly on a node, by node type, through hierarchy, via port contracts, and through business process flows. One rule can cover dozens of files, and changing it triggers cascading re-verification everywhere.

## Getting started

**1. Install and init.**

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

The wizard walks you through platform selection and reviewer setup. It fetches available models from your provider, validates the connection, and writes the config for you.

If you prefer flags: `yg init --platform cursor` skips the platform prompt.

**2. Start working.**

The graph doesn't build itself automatically, and that's intentional. Architecture is coarse-grained, not a 1:1 mirror of your file tree. The agent builds it incrementally as you work.

You tell the agent what matters, and it creates the graph structure:

```
You:    "All payment operations must emit audit events."
Agent:  Creates aspect requires-audit with content.md rules,
        applies it to payment nodes.

You:    "Map the orders module."
Agent:  Creates node orders/order-service with mapping and aspects.
```

On an existing codebase, the agent starts by mapping the areas you're actively working on. Parts you're not touching stay unmapped until you need them. Coverage grows organically as you work, not as a one-time setup cost.

**3. Enforce.**

Run `yg check` in CI or as a pre-commit hook. If it fails, tell the agent to fix it.

## Supported platforms

Works with any AI coding agent. `yg init --platform <name>` generates the rules file your agent expects.

**Agent platforms:** Cursor · Claude Code · GitHub Copilot · Codex · Cline · RooCode · Windsurf · Aider · Gemini CLI · Amp · OpenCode

**Reviewer providers:** The reviewer that verifies aspects can run through API (Anthropic, OpenAI, Google, OpenAI-compatible, Ollama) or through agent CLI (Claude Code, Codex, Gemini CLI).

## FAQ

**How is this different from CLAUDE.md or .cursorrules?**
Rules files are flat text dumped into every prompt. They don't scope rules to where they matter and they don't verify anything. Yggdrasil delivers only relevant rules per file and then mechanically checks compliance.

**How is this different from RAG or Tree-sitter tools?**
Those tools help agents find more code. Yggdrasil enforces constraints that don't exist in code and never will. "Rate limiting required" isn't in any AST. "No direct DB access from this layer" isn't in any embedding.

**Does the agent actually follow the rules?**
It doesn't need to. `yg check` runs in CI. The agent runs `yg approve` which triggers a reviewer (a separate LLM call) that reads the source code and checks it against aspect rules. If an aspect isn't satisfied, check fails. The enforcement is structural (drift detection, coverage) plus semantic (LLM-based aspect review). You can use `consensus: 3` to run multiple review passes for higher confidence.

## Documentation

Full specification: [https://krzysztofdudek.github.io/Yggdrasil/](https://krzysztofdudek.github.io/Yggdrasil/)

## License

MIT

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
