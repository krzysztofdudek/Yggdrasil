<div align="center">
  <img src="docs/public/logo.svg" alt="Yggdrasil" width="150" />
</div>

# Yggdrasil

**🧠 Make your repository self-aware.**

Your AI agent forgets everything between sessions. Yggdrasil makes it remember.

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)

---

## 💀 The problem you already know

Your AI agent works great on day one. Then the project grows and the agent starts breaking things. It doesn't know about rules that live in files it never read. It forgets decisions you explained last session. It duplicates code that already exists.

You've tried rules files, long prompts, context dumps. They help for a while. Then you have 50 rules, the agent loads all of them every time, and half are irrelevant to what it's actually doing.

The issue isn't intelligence. It's memory.

AI agents do not need more repository. They need the right context for the specific part they are working on.

That is the missing layer. Not bigger context windows. Not longer rules files. Persistent semantic memory.

## 🌳 What Yggdrasil does

Yggdrasil gives your project a persistent memory that your agent reads and updates as it works. Instead of loading one giant blob of repo knowledge, it assembles a small context package for the exact unit the agent is touching.

When the agent touches a file, it gets only the context relevant to _that specific part_ — not your entire repo, not all your rules, just what it actually needs. The agent builds and maintains this memory itself. You don't write documentation.

**Without Yggdrasil:** 😵

```
You: "Add a payment retry to OrderService"
Agent: reads OrderService.ts, maybe PaymentService.ts
       doesn't know about your rate limiting rules
       doesn't know orders must have min 1 item
       doesn't know why you chose event sourcing
       → guesses. breaks things. you fix. repeat.
```

**With Yggdrasil:** 🎯

```
You: "Add a payment retry to OrderService"
Agent: gets a context summary for OrderService (auto-assembled)
       knows: how it connects to PaymentService
       knows: rate limiting rules apply here
       knows: event sourcing — and why
       knows: order validation constraints
       → implements correctly. updates the memory. done.
```

---

## 📦 Install

```bash
npm install -g @chrisdudek/yg
```

## 🚀 Initialize

```bash
cd your-project
yg init --platform <platform>
```

That's it. Your agent now has persistent memory. From that point on, your agent can build context per area instead of guessing from partial code or global rules.

---

## 🔌 Supported platforms

Cursor, Claude Code, GitHub Copilot, Cline / RooCode, Codex, Windsurf, Aider, Gemini CLI, Amp.

---

## 🔬 Does it actually work?

I ran 26 experiments on real open-source codebases (Hoppscotch, Medusa, Django). Here's what I found:

- **An agent with only Yggdrasil context (no source code) built a correct service from scratch.** It didn't need to read the repo — the memory was enough. This worked even on a domain the agent had never seen before.
- **You don't need to set it up perfectly.** Start messy. After 2 iterations the memory is good. You don't need to map your whole project either — covering a few key areas gets you most of the benefit.
- **When you change something, the agent knows what else is affected.** Not "this file changed so maybe check everything" — it knows which specific parts of your system are connected, down to individual functions.

The biggest payoff is not single-file understanding. It is cross-module reasoning: why something exists, what depends on it, and what else breaks when you change it.

⚠️ **What I'm honest about:** these experiments were run by an AI agent, not peer-reviewed. The exact scores are directional. The biggest limitation is coverage — the memory only helps with parts of your system that are actually mapped. I'm working on that.

Full experiment data: `experiments/`.

---

## ⚙️ How it works

1. `yg init` — a `.yggdrasil/` folder appears in your project.
2. Your agent works normally. As it goes, it builds a memory of your system — what each part does, how things connect, what rules apply, and _why_ things are the way they are.
3. Before touching a file, the agent asks Yggdrasil for context. It gets a short summary of everything relevant to that specific area.
4. The agent writes code and updates the memory in the same step. It stays in sync automatically.

The point is not to make the agent read more. The point is to make the repo legible.

Plain Markdown and YAML. No database. No lock-in. Delete `.yggdrasil/` and everything works exactly as before.

---

## 🚫 What it is not

- **Not a code generator.** Your agent generates code. Yggdrasil makes it generate _better_ code by giving it the right context.
- **Not manual documentation.** You don't write anything. The agent does it while working on your tasks.
- **Not locked to a provider.** Works with Cursor today, Claude Code tomorrow, whatever comes next.
- **Not invasive.** Delete `.yggdrasil/` and your project is exactly as it was.

---

## 🤔 When is it worth it?

**Worth it:** ✅

- Your project has 100+ files and your agent keeps making the same mistakes
- Multiple people (or agents) work on the codebase and context gets lost between them
- You're tired of re-explaining the same architectural decisions every session

**Not worth it (yet):** ❌

- Small projects where the agent can see everything at once
- Solo scripts or utilities with no cross-module dependencies
- You're prototyping and architecture doesn't matter yet

---

## 📖 Documentation

Full specification and architecture:
[https://krzysztofdudek.github.io/Yggdrasil/](https://krzysztofdudek.github.io/Yggdrasil/)

---

## 📄 License

MIT — see [LICENSE](LICENSE).
