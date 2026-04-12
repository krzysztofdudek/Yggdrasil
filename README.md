<video src="https://github.com/user-attachments/assets/49c8fe8f-c3b9-4202-b655-7f987dcab4cb" controls></video>

# Yggdrasil

**Your AI agent writes code that compiles, passes tests, and breaks your architecture. Yggdrasil stops that.**

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Stars](https://img.shields.io/github/stars/krzysztofdudek/Yggdrasil)](...)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/SZTbgsH8Wm)

---

## Vibecoding vs vericoding

Vibecoding: agent writes code, you hope it respects your architecture. It doesn't. It adds `Date.now()` to a module that must be deterministic. It skips audit logging on payment mutations. It calls a service that shouldn't be called from this layer. Tests pass. Lint passes. Architecture is broken. You find out in code review. Or in production.

Vericoding: you write architectural rules as **aspects**. The agent reads them before writing code. After writing, a reviewer checks whether the code actually satisfies the rules. Not whether the agent claimed it did — whether it's actually there in the source. If the code breaks an aspect, the agent can't ship.

```
yg check   →  "source files changed since last approve"
yg approve →  reviewer checks aspects vs source code
           →  aspect-violation: rate-limiting not satisfied
           →  agent fixes code
           →  yg approve passes
           →  commit allowed
```

No `--force`. No "I'll fix it later." The wall is the wall.

---

## What Yggdrasil enforces

**Aspects** are cross-cutting architectural rules written in plain language:

```markdown
<!-- aspects/rate-limiting/content.md -->
Every public endpoint must enforce rate limiting.
Use the shared rateLimiter middleware. No manual implementation.
```

Aspects propagate through the graph — apply to a node type, all nodes of that type inherit it. Apply to a flow, all participants inherit it. The reviewer checks every aspect against every source file at approve time.

**What gets caught:**

- **Drift.** Source files changed but aspects weren't re-verified? Blocked.
- **Aspect violation.** Rule says "no Date.now()" — agent used Date.now()? Blocked.
- **Coverage.** Unmapped source file? Blocked. No dark corners.
- **Cascade.** Aspect content changed? Every node using that aspect needs re-approval.

---

## How it works

**1. Define rules.** Write aspects — what must be true about your code. Plain Markdown. Apply them to nodes (modules, services, libraries) via YAML.

**2. Agent reads before writing.** `yg context --file <path>` shows which aspects apply. The agent knows the rules before touching code.

**3. System verifies after writing.** `yg approve` runs a reviewer that checks source code against aspect rules. Binary: pass or fail. Blocks commits and CI.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init --platform cursor  # or: claude-code, copilot, codex, cline, windsurf, aider, gemini-cli, amp
```

Then define your architecture:

```
You:    "All payment operations must emit audit events."
Agent:  Creates aspect requires-audit with content.md rules,
        applies it to payment nodes.

You:    "Map the orders module — it handles lifecycle states."
Agent:  Creates node orders/order-service with mapping and aspects.
```

Run `yg check` in CI. Run `yg approve` before commits. The agent works within walls, not wishes.

---

## Five distribution channels for aspects

Every dimension of the graph is a way to distribute architectural rules to nodes:

| Channel | How |
|---------|-----|
| Direct | `node.aspects` in yg-node.yaml |
| Type | Architecture defines default aspects per node type |
| Hierarchy | Parent aspects inherited by children |
| Port | Consumer must satisfy port-required aspects |
| Flow | Participants inherit flow-level aspects |

One rule, multiple nodes, automatic propagation. Change the rule — all affected nodes cascade to re-approval.

---

## Supported platforms

Cursor · Claude Code · GitHub Copilot · Codex · Cline / RooCode · Windsurf · Aider · Gemini CLI · Amp

`yg init --platform <name>` generates platform-specific rules file. Adding a new platform is a single config file — PRs welcome.

---

## FAQ

**How is this different from a rules file (CLAUDE.md, .cursorrules)?**
Rules files are flat text dumped into every prompt. They don't know which rules apply where. Yggdrasil scopes rules per node — your agent gets only the aspects relevant to what it's touching. And then verifies compliance.

**How is this different from RAG / Tree-sitter tools?**
Those tools find more code. Yggdrasil enforces architectural constraints that don't exist in code and never will. "Rate limiting required" isn't in any AST. "No direct DB access from this layer" isn't in any embedding. Yggdrasil captures what SHOULD BE and checks whether it IS.

**Does the agent actually follow the rules?**
The agent doesn't need to "follow" anything. `yg check` runs in CI. `yg approve` runs a reviewer against source code. If an aspect isn't satisfied, the build fails. Enforcement is mechanical, not behavioral. You don't ask the agent to be good. You make it impossible to ship bad work.

---

## Documentation

Full specification: [https://krzysztofdudek.github.io/Yggdrasil/](https://krzysztofdudek.github.io/Yggdrasil/)

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
