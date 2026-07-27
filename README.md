<p align="center">
  <img src="docs/public/demo.gif" alt="Yggdrasil review loop" width="900" />
</p>

# Yggdrasil

**Say it once.**

Write a rule and it holds in every session after that, without you repeating yourself. Before the agent edits a file it gets only the rules that touch that file, not all two hundred. After the edit they are checked, and a violation comes back as an error the agent has to fix before it moves on. The same checks re-run in CI for free, with no API key.

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Discussions](https://img.shields.io/badge/Discussions-Join-181717?logo=github&logoColor=white)](https://github.com/krzysztofdudek/Yggdrasil/discussions)

---

## You probably don't feel this problem, and that is the interesting part

If you have ever been the only thing standing between an agent and production, solo, after hours, shipping something fast to find out whether it was worth building, then you know the wall. Code arrives faster than you can keep quality up with it. From there it goes one of two ways. You slow to a crawl because you now have to watch everything yourself, or you lose the thread and end up with bugs you can no longer trace back to a decision.

If you work somewhere that pays for quality, you have probably never hit that wall. Review, QA and the rhythm of a sprint sit between you and it. Those same things mean you have never seen your own unconstrained speed either.

Nobody measures this in either direction. The best study available put experienced developers **19% slower** on real tasks with AI assistance, while they believed they had been 20% faster ([METR, 2025](https://arxiv.org/abs/2507.09089)). Neither the people who feel fast nor the people who feel careful have an instrument.

Scaffolding is not there to stop you falling. It is there so that the brake does not have to be a person.

## Five minutes to your first enforced rule

Requires Node.js 22+. You can start without an API key: `yg init` offers **"None for now"** as a real answer, and script rules, dependency control and the CI gate all work from there with no key and no model calls.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
yg check
```

That first check is green, and honest about why:

```text
yg check: PASS (1 warning)  0 nodes · 0/50 files (0 node-owned, 0 type-covered) · 0 aspects · 0 flows

Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — every file still needs an explicit node until you add classifying types.

  uncovered (50)  Not under a coverage.required root. Visible, non-blocking.
```

Nothing is enforced yet, because you have not said what matters yet. Nothing is pretending otherwise. That list is your to-do, not a finding.

So say one thing to your agent:

> "Every service that handles payments must emit audit events. Create a rule for it and apply it to the payments module."

It writes the rule and maps the module. `yg check` now fails, because that rule has never been verified against your code. `yg check --approve` verifies it. From that point the rule holds, and any change that breaks it comes back to the agent as an error before it reaches you.

That is the whole loop, and it is the shortest honest path to seeing it.

Prefer to be taught instead? Tell your agent **"onboard me into Yggdrasil"**. In an adopted repo the agent knows the tutor playbook and will teach you on your own code, in your own language.

## What it does

The rule: every charge records an audit event. The agent writes a refund that skips it.

```ts
async function refund(req) {
  await payments.refund(req.body.chargeId)
  return { ok: true }
}
```

`yg check` refuses it: **refund changes a charge with no audit event.** The agent adds the call, re-runs, passes.

```ts
async function refund(req) {
  await payments.refund(req.body.chargeId)
  await audit('refund', req.body.chargeId) // added
  return { ok: true }
}
```

You reviewed nothing. That is the loop: the agent writes, the check runs, the agent fixes its own work before you look at it.

You attach a rule once and the tool works out everywhere it lands. You never paste it onto each file, and you never hand the agent the whole rulebook.

## Two kinds of rule

**Script rules** ship a `check.mjs` that runs locally, every time, at zero cost. Deterministic, and there is no talking past it. This is the layer to lean on, and it is exactly the kind of rule an agent quietly drops when it is only a line in a rules file.

**Judgment rules** are plain Markdown, read by a separate model, for the calls a script genuinely cannot make.

```markdown
# Audit every payment mutation

Any function that creates, updates, or refunds a charge must
call `auditLog.emit()` before it returns. A mutation with no
audit event is a refusal.
```

Judgment rules are the higher variance layer, so keep those components small and run new rules as advisory before you enforce them. A rule is one kind or the other, never both.

The rest of the vocabulary, components, flows, ports, statuses and the predicate language, is in the [docs](https://krzysztofdudek.github.io/Yggdrasil/). You do not need any of it to get the first finding.

## The part that is genuinely not available elsewhere

Every verdict, from a script or from a model, is recorded against a content hash of everything that produced it. CI does not re-run your model review. It recomputes the hashes and re-proves the existing verdicts, for free, with no API key.

In practice you pay a reviewer once per piece of code instead of once per pull request. Every metered AI review product bills you again for code that did not change, and none of them can stop without breaking their own pricing.

If the code changes, the hash changes, the verdict is void and the check goes red. A green build cannot quietly mean "we skipped that one".

## Why it is built the way it is

Everything in this tool is here because at some point I needed it and did not have it. Nothing was added because it sounded good on a feature list. If a mechanism looks oddly specific, that is usually why, and the commit history says when.

I built it while shipping things alone, fast, which is where the wall above comes from. That is one person's experience, not a study. Take it as such.

## Two limits, before you install

**It enforces structure, not runtime behaviour.** It can require that you call the audit utility. It cannot prove the audit fired in production.

**A green check is only as good as the rule behind it.** A shallow rule passes shallow code. The enforcement is real. Deciding what is worth enforcing stays yours.

## See the whole graph

`yg portal` renders everything as a read only map in the browser: every component, every rule, and whether each one is verified against the code as it stands right now. Nothing is rounded up to green. `yg portal --static` writes a single self contained file you can hand to someone who has no checkout.

<p align="center">
  <img src="docs/public/portal-overview-dark.png" alt="The Yggdrasil portal" width="900" />
</p>

## In CI

```yaml
- run: npx @chrisdudek/yg check --approve --only-deterministic
- run: npx @chrisdudek/yg check
```

The first line rebuilds the free local cache that a fresh checkout never has. The second is the gate: it recomputes the input hash of every rule against its recorded verdict, and fails if anything changed without being verified. No keys, no model calls.

## Works with

Any agent that reads `AGENTS.md`: Claude Code, Cursor, Copilot, Codex, Cline, OpenCode, Amp, Zed and others. `yg init` writes one universal rule set, so there is no platform to pick.

Reviewer providers: Anthropic, OpenAI, Google, OpenAI compatible, Ollama locally, or delegation to an installed agent CLI with no API key at all.

## FAQ

**How is this different from a rules file?**
A rules file is flat text dumped into every prompt, with no scoping and no verification. Here the agent gets only the rules that touch the file it is editing, and the output is checked against them.

**How is this different from a pre-commit or agent hook?**
A hook is a real gate and you should use one. Point it at `yg check` and you have wired this in. What a bare hook has no notion of is which rule applies to which file, rules that need judgment rather than a script, and a lock that lets CI re-prove a model verdict for free.

**How is this different from an AI review bot?**
Review bots hunt for bugs against their own idea of good code, and they re-run and re-bill on every pull request. This checks your specific rules, the ones only your team knows, and records a durable proof of each verdict.

**What if I want to stop?**
Delete `.yggdrasil/` and the rules file. No runtime dependencies, no build hooks, nothing left behind.

## Examples and docs

[`examples/`](examples/) has six runnable projects, four of them keyless. This repository uses Yggdrasil on itself, so [`.yggdrasil/`](.yggdrasil/) is a live graph you can read. Full docs at [krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/).

## License

MIT

---

<div align="center">
  <img src="docs/public/logo.svg" alt="Yggdrasil" width="150" />
  <br/><br/>
  <a href="https://github.com/krzysztofdudek/Yggdrasil/discussions">
    <img src="https://img.shields.io/badge/Discussions-Join-181717?logo=github&logoColor=white" alt="GitHub Discussions" />
  </a>
  <br/>
  <sub>Questions? Open a discussion on GitHub.</sub>
</div>
