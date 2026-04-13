---
title: Supported Platforms
---

`yg init` integrates with your AI tool by creating or updating the right
instruction file — so the agent knows how to work with Yggdrasil.

| Platform | File created/updated by `yg init` | Touches user files? |
|---|---|---|
| Cursor | `.cursor/rules/yggdrasil.mdc` | ❌ No |
| Claude Code | `CLAUDE.md` (single `@...` line) | ⚠️ Minimal (1 line) |
| GitHub Copilot | `.github/copilot-instructions.md` (append section) | ⚠️ Appends a section |
| Cline | `.clinerules/yggdrasil.md` | ❌ No |
| RooCode | `.roo/rules/yggdrasil.md` | ❌ No |
| Codex | `AGENTS.md` (append section) | ⚠️ Appends a section |
| Windsurf | `.windsurf/rules/yggdrasil.md` | ❌ No |
| Aider | `.aider.conf.yml` (adds `read:` entry) | ⚠️ Minimal (1 line) |
| Gemini CLI | `GEMINI.md` (single `@...` line) | ⚠️ Minimal (1 line) |
| Amp | `AGENTS.md` (single `@...` line) | ⚠️ Minimal (1 line) |
| OpenCode | `AGENTS.md` (append section) | ⚠️ Appends a section |
| Generic | `.yggdrasil/agent-rules.md` | ❌ No |

Notes:

- "No" — `yg init` creates a dedicated Yggdrasil file.
- "Minimal" — one line is added to an existing file.
- "Append section" — a clearly delimited section is added; no existing content is modified.
- Codex, Amp, and OpenCode all write to `AGENTS.md` using different formats. Do not initialize more than one of these platforms simultaneously.
