---
title: Supported Platforms
---

`yg init` installs one universal set of agent-rules files — the same files,
the same content, regardless of which agent you use. There is no platform
question to answer.

It writes:

- A short summary block inside marker comments in `AGENTS.md`.
- A one-line `@AGENTS.md` import added to `CLAUDE.md`, because Claude Code
  does not read `AGENTS.md` on its own.
- A copy of the same summary at `.clinerules/yggdrasil.md`, because Cline
  looks there instead of `AGENTS.md`.

That summary tells the agent to run `yg prime` before making any change.
`yg prime` prints the complete, current operating manual straight from your
installed Yggdrasil CLI — so an agent's instructions are always up to date
and are never cut short by a small instruction budget.

`yg check` also watches these three files and warns if one goes missing,
gets hand-edited, falls behind after you upgrade the CLI, or ends up
duplicated — always pointing you at `yg init --upgrade` to fix it.

::: warning Upgrading a project that requires its whole tree
These three files (and the `.gitattributes` entry `yg init` maintains) are new
in your repository, so a project that requires **every** tracked file to belong
to a component will report them as unmapped errors on the next check. That is
any project whose `yg-config.yaml` has no `coverage:` block at all, or whose
`coverage.required` covers the repository root. They're repository plumbing,
not project source — exclude them:

```yaml
coverage:
  excluded:
    - AGENTS.md
    - CLAUDE.md
    - .clinerules/
    - .gitattributes
```

`yg init --upgrade` tells you when this applies to your project and prints the
same stanza; it never edits the file for you. Mapping them to a component
instead works just as well if you'd rather keep them under enforcement. A
freshly initialized project requires nothing and is unaffected.
:::

## How each agent picks up the rules

| Agent | How it gets the rules |
|---|---|
| Claude Code | The `@AGENTS.md` import line in `CLAUDE.md` |
| Cline | `.clinerules/yggdrasil.md` |
| GitHub Copilot, Cursor, Codex, OpenCode, Amp, Zed, and any other agent confirmed to read a repository's `AGENTS.md` | `AGENTS.md` directly |

No agent gets a bespoke file of its own anymore — every agent reads one of
these three universal artifacts. If your agent reads none of them natively,
point it at `AGENTS.md` by hand, or have it run `yg prime` directly.

## Agents that need a one-time manual setup

These are left off the table above because we can't confirm they read
`AGENTS.md` on their own — not because they're unsupported. Each takes one
small step, once:

- **Windsurf** — folded into another product; last we checked, its current
  status and whether that product reads `AGENTS.md` natively were both in
  flux.
- **Aider** — needs an explicit `read:` entry in `.aider.conf.yml` pointing at
  `AGENTS.md`. `yg init` no longer writes one; add the entry yourself if you
  use Aider. It also removes the entry an earlier version wrote, which pointed
  at a file that no longer exists. If you wrote that entry by hand rather than
  letting `yg init` add it, it is left alone on purpose — check
  `.aider.conf.yml` for a `read:` line still pointing at
  `.yggdrasil/agent-rules.md` and repoint it at `AGENTS.md`.
- **CodeBuddy** — reads its own `CODEBUDDY.md`, not `AGENTS.md`; we have no
  confirmation of native `AGENTS.md` support.
- **Roo Code** — reported to have shut down, so this is here for anyone still
  running an older install. `yg init` deletes the rules file the retired
  installer wrote at `.roo/rules/yggdrasil.md`.
- **Gemini CLI** — retired as a standalone tool as far as we can tell, so this
  is likewise here for anyone still running it. `yg init` removes the import
  line the retired installer added to `GEMINI.md` (and the file itself, if
  that line was all it held).

For any of these, point the agent at `AGENTS.md` by hand — for the last two,
in whichever file that agent reads — or have it run `yg prime` directly. Both
give it the same rules every other agent gets.
