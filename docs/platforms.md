---
title: Supported Platforms
---

`yg init` integrates with your AI tool by creating or updating the right
instruction file — so the agent knows how to work with Yggdrasil.

| Platform | File created/updated by `yg init` | Touches user files? |
|---|---|---|
| Cursor | `.cursor/rules/yggdrasil.mdc` | ❌ No |
| Claude Code | `.yggdrasil/agent-rules.md` + `CLAUDE.md` (single `@...` line pointing at it) | ⚠️ Minimal (1 line) |
| GitHub Copilot | `.github/copilot-instructions.md` (append section) | ⚠️ Appends a section |
| Cline | `.clinerules/yggdrasil.md` | ❌ No |
| RooCode | `.roo/rules/yggdrasil.md` | ❌ No |
| Codex | `AGENTS.md` (append section) | ⚠️ Appends a section |
| Windsurf | `.windsurf/rules/yggdrasil.md` | ❌ No |
| Aider | `.yggdrasil/agent-rules.md` + `.aider.conf.yml` (adds `read:` entry pointing at it) | ⚠️ Minimal (1 line) |
| Gemini CLI | `.yggdrasil/agent-rules.md` + `GEMINI.md` (single `@...` line pointing at it) | ⚠️ Minimal (1 line) |
| Amp | `.yggdrasil/agent-rules.md` + `AGENTS.md` (single `@...` line pointing at it) | ⚠️ Minimal (1 line) |
| OpenCode | `AGENTS.md` (append section) | ⚠️ Appends a section |
| CodeBuddy | `.codebuddy/rules/yggdrasil/RULE.mdc` | ❌ No |
| Generic | `.yggdrasil/agent-rules.md` | ❌ No |

Notes:

- "No" — `yg init` creates a dedicated Yggdrasil file.
- "Minimal" — one line is added to an existing file.
- "Append section" — a clearly delimited section is added; no existing content is modified.
- Codex, Amp, and OpenCode all write to the same `AGENTS.md` file. Codex and OpenCode append an identical delimited section (OpenCode reuses the Codex installer); Amp instead adds a single `@...` reference line. Because they share one file, do not initialize more than one of these platforms simultaneously.
