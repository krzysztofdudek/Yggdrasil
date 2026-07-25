# @chrisdudek/yg

**Say it once.**

Write a rule and it holds in every session after that, without you repeating yourself. Before your agent edits a file it gets only the rules that touch that file, not the whole rulebook. After the edit they are checked, and a violation comes back as an error the agent has to fix before it moves on.

A rule is either a small local script that runs for free on every check, or plain Markdown that a separate model reads for the calls a script cannot make. Every verdict is tied by hash to the exact code it checked, so CI re-proves the whole set for free, with no API key.

Works with Claude Code, Cursor, Copilot, Codex, Cline and any other agent that reads `AGENTS.md`.

## Install

Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

`yg init` writes the `.yggdrasil/` graph and the agent-rules files into your repo, then asks one question: which reviewer should verify your code. **"None for now"** is a real answer. Script rules, dependency control and the CI gate all work from there with no key and no model calls.

Then tell your agent what matters:

> "Every payment operation must emit an audit event. Create a rule for it and apply it to the payments module."

It writes the rule and maps the module. From that point the rule holds, in this session and every one after.

## Docs

[krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/) for the full documentation, or the [main README](https://github.com/krzysztofdudek/Yggdrasil#readme).

## License

MIT
