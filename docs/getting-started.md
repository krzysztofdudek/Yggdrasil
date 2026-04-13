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

## 3) Start working

Open your AI tool and work like you always do. New project or existing one.

The agent builds the graph incrementally as you work. You tell it what matters,
it creates the structure and enforces the rules.

---

_Want to go deeper?_

- [Supported platforms](/platforms)
- [CLI reference](/cli-reference)
- [Configuration](/configuration)
