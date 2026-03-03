# @chrisdudek/yg

**Make your repository self-aware.**

Yggdrasil gives your repository a persistent semantic memory graph. The `yg` CLI
maintains the system's intent, rules, and boundaries in structured Markdown and
YAML inside `.yggdrasil/`. When an AI agent works on your code, Yggdrasil
deterministically assembles a precise context package for the exact component
the agent is modifying.

No API keys. No network dependency. Just local files, validation, and context
builds.

## Installation

```bash
npm install -g @chrisdudek/yg
```

Requirements: Node.js 22+

## Initialize

```bash
cd your-project
yg init --platform <platform>
```

Done. Your repository is now self-aware.

## Quick Start

```bash
yg init --platform cursor
yg tree --depth 1
yg validate
yg build-context --node orders/order-service
```

## Core Commands

**Diagnostics:**

- `yg preflight [--quick]` — Unified diagnostic report: journal, drift, status, validation

**Reading and analysis:**

- `yg build-context --node <path>` — Assemble context package for a node
- `yg status` — Graph health summary
- `yg tree [--root <path>] [--depth N]` — Graph structure as tree
- `yg owner --file <path>` — Find which graph node owns a source file
- `yg deps --node <path>` — Forward dependency tree and materialization order
- `yg impact --node <path> [--simulate]` — Reverse dependencies and context impact
- `yg aspects` — List aspects with metadata (YAML output)
- `yg flows` — List flows with metadata (YAML output)

**Validation and drift:**

- `yg validate [--scope all|node-path]` — Structural integrity and completeness
- `yg drift [--scope all|node-path] [--drifted-only] [--limit <n>]` — Detect graph-to-file divergence
- `yg drift-sync --node <path> [--recursive]` — Record current file hash after resolving drift
- `yg drift-sync --all` — Sync all nodes with mappings in one command

**Session journal:**

- `yg journal-add --note "..." [--target <node-path>]` — Buffer a decision note
- `yg journal-read` — List pending journal entries
- `yg journal-archive` — Archive journal after consolidation

**Setup:**

- `yg init --platform <name>` — Initialize `.yggdrasil/` structure (once per repository)
- `yg init --platform <name> --upgrade` — Refresh rules only (config and graph stay unchanged)

Node paths are relative to `.yggdrasil/model/`. File paths are relative to the
repository root.

## Upgrade

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init --platform <platform> --upgrade
```

`--upgrade` overwrites only the rules file. Your `.yggdrasil/` config and graph
are not modified.

## Supported Platforms

| Platform    | Init                             | Rules location                    |
| ----------- | -------------------------------- | --------------------------------- |
| Cursor      | `yg init --platform cursor`      | `.cursor/rules/yggdrasil.mdc`     |
| Claude Code | `yg init --platform claude-code` | `AGENTS.md` (Yggdrasil section)   |
| Copilot     | `yg init --platform copilot`     | `.github/copilot-instructions.md` |
| Cline       | `yg init --platform cline`       | `.clinerules/yggdrasil.md`        |
| RooCode     | `yg init --platform roocode`     | `.roo/rules/yggdrasil.md`         |
| Codex       | `yg init --platform codex`       | `AGENTS.md` (Yggdrasil section)   |
| Windsurf    | `yg init --platform windsurf`    | `.windsurf/rules/yggdrasil.md`    |
| Aider       | `yg init --platform aider`       | `.yggdrasil/agent-rules.md`       |
| Gemini CLI  | `yg init --platform gemini`      | `GEMINI.md` (import)              |
| Amp         | `yg init --platform amp`         | `AGENTS.md` (import)              |
| Generic     | `yg init --platform generic`     | `.yggdrasil/agent-rules.md`       |

## License

MIT
