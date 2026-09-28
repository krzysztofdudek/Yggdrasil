<div align="center">

<img src="https://raw.githubusercontent.com/krzysztofdudek/Yggdrasil/v6.1.0/docs/public/logo.svg" alt="" width="120" />

# Yggdrasil

**Say it once.**

Architecture rules for coding agents: scoped to each file, checked, replayed free in CI.

[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg) [![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)

[See it work](#see-it-work) · [Start](#start-in-your-repo) · [How it works](#how-it-works) · [Costs and limits](#costs-and-limits) · [Docs](https://krzysztofdudek.github.io/Yggdrasil/)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/krzysztofdudek/Yggdrasil/v6.1.0/docs/public/readme/loop-dark.svg" />
  <img src="https://raw.githubusercontent.com/krzysztofdudek/Yggdrasil/v6.1.0/docs/public/readme/loop-light.svg" alt="Before an edit, the agent runs yg context and gets the rules on that file, and only those. It writes the change. yg check --approve runs script rules and dependency checks for free and sends reviewer rules to a model. A refusal goes back to the agent; every verdict, pass or refusal, is recorded in the lock with a hash of what it judged. The gate in pre-commit and CI re-runs script rules and dependency checks for free and matches every recorded verdict to the code as it is now, with no model and no key." width="560" />
</picture>

</div>

Your agent writes code faster than you can read it. The rules you care about sit in a prompt file that nothing checks, and the only check between its code and `main` is you. Yggdrasil keeps those rules in a `.yggdrasil/` directory next to the code they govern.

It works with Claude Code, Cursor, Copilot, Codex, Cline and any other agent that reads `AGENTS.md`. Its dependency checks read TypeScript and JavaScript, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust, C and C++.

**Only what applies.** `yg init` installs agent instructions that tell the agent to run `yg context --file` before it edits a file. It gets the rules in force on that file, not the whole rulebook. That step is an instruction the agent follows, not something Yggdrasil can force.

**Checked where it cannot be skipped.** The same instructions tell the agent to run `yg check --approve` after a change and to fix a refusal before it moves on. The part nobody can talk past is `yg check` wired into your pre-commit hook and CI: it fails the commit or the build.

**Judged once, replayed in CI.** Every verdict is recorded with a hash of everything it judged. CI checks that every recorded verdict still matches the code, with no model and no key. Code that changed since its verdict fails the check until it is judged again.

## See it work

One minute, no key, nothing installed in your own repository. A few words first, because the reports use them: a rule is an *aspect*, a component is a *node*, and a *pair* is one rule on one component (or on one file). The *graph* is the map of components and rules in `.yggdrasil/`, a *verdict* is the recorded pass or refusal of one pair, and the *lock* is the file that holds the verdicts.

```bash
git clone --depth 1 https://github.com/krzysztofdudek/Yggdrasil
cd Yggdrasil/examples
```

### A boundary, checked live and free

`layered-architecture` is a backend in three layers: web calls domain, domain calls data. Make the web layer reach straight into the data layer: in `src/web/rideHandler.ts`, add this line under the existing import.

```ts
import { findRide } from '../data/rideRepository.js';
```

```bash
cd layered-architecture
npx @chrisdudek/yg@6.1.0 check
```

```text
yg check: FAIL  1 error   3 nodes · 3/3 files covered · 5 excluded

error[relation-undeclared-dependency] Node 'web' has undeclared dependencies on other nodes
  at:   web
          src/web/rideHandler.ts:5 → data
  why:  A dependency on another component must be a sanctioned, declared relation. Undeclared edges erode the architecture allow-list of who may depend on whom.
  fix:  No relation can be declared for this dependency: remove it, or ask the user to approve an architecture change:
        data: no relation type is allowed from handler to repository that sanctions an import (only uses, calls, extends and implements do), so none can be declared. Remove the dependency, or ask the user to approve an architecture change — a different node type, or a new allowed relation in .yggdrasil/yg-architecture.yaml.

next: edit src/web/rideHandler.ts:5
```

No model was asked. Every `yg check` compares the dependencies in your code with the ones your graph declares and your architecture allows.

### A judgment, made once and replayed free

`failing` has a rule no script can check, written in plain Markdown ([the whole rule](https://github.com/krzysztofdudek/Yggdrasil/blob/v6.1.0/examples/failing/.yggdrasil/aspects/requires-audit/content.md)):

```markdown
# Requires Audit

Every function that mutates state (creates, updates, or deletes data) must emit
an audit event before returning.
```

The payment service logs with `console.log` instead. A model reviewed it once, when the example was made, and refused. Run the check:

```bash
cd ../failing
npx @chrisdudek/yg@6.1.0 check
```

```text
yg check: FAIL  1 error   2 nodes · 3/3 files covered · 4 excluded

error[refused] requires-audit — refused on payments
  at:   payments  Both mutation functions in src/payments.ts violate the requirement: charge (line 5) and refund (line 11) mutate state but use only generic console.log() calls instead of calling emitAudit(). The aspect requires structured audit events with operation, timestamp, and entityId fields. No suppression markers found.
  why:  Every mutation must emit an audit event
  fix:  Four exits — the verdict is recorded for this exact code, so re-running the reviewer changes nothing:
```

(Trimmed; the full report lists the four exits: fix the code, sharpen the rule, ask for a documented exception, or make the rule advisory while you decide.)

You just read a model's verdict without calling a model. It is stored in the lock with a hash of everything it judged, and that hash still matches the code on disk. Now change `src/payments.ts` in any way, a fix or a single character, and check again:

```text
yg check: FAIL  1 error   2 nodes · 3/3 files covered · 4 excluded

error[unverified] 1 pair whose inputs changed since the verdict
  at:   requires-audit @ payments
  why:  A verdict was recorded, but its inputs changed since (a source edit, an aspect edit, or a changed reference), so it no longer counts. It is re-judged over the code as it stands now.
  fix:  yg check --approve  (1 reviewer pair · 1 call · paid)
```

The old verdict no longer counts, and the report says how many paid calls a fresh one takes before anything is spent. This is the check CI runs.

## Start in your repo

Requires Node.js 22 or newer.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

`yg init` writes `.yggdrasil/` and one set of agent-rules files for every agent (a block in `AGENTS.md`, an import line in `CLAUDE.md`, `.clinerules/yggdrasil.md`), then walks you through one choice: which reviewer judges the rules that need judgment. Claude Code, Codex, Gemini CLI and Copilot CLI need no API key. Anthropic, OpenAI and Google take one. Ollama runs on your machine, and any OpenAI-compatible endpoint works too. **None for now** is a real answer.

The first `yg check` is green: every file shows up in one `uncovered` warning, a to-do rather than a failure. Start with a rule that needs no reviewer at all. Tell your agent:

> "The API layer must never import the database module. Enforce it."

It proposes two component types with no allowed dependency between them (a change to `yg-architecture.yaml`, which the agent asks you to confirm) and maps one component to each. The next `yg check`, if the code already does it:

```text
yg check: FAIL  1 error   2 nodes · 2/2 files covered · 4 excluded

error[relation-undeclared-dependency] Node 'api' has undeclared dependencies on other nodes
  at:   api
          src/api/orders.ts:1 → db
```

(Trimmed.) That check is free, runs on every `yg check`, and needs no key. Then try a rule that needs judgment:

> "Every function that changes a payment must emit an audit event. Make it a rule and attach it to the payments module."

That one needs a reviewer. If you chose none, `yg check` blocks on it as unverified and names the fix: configure a reviewer, or park the rule as a draft. Once both rules have verdicts, they hold in every session, and nobody has to restate them.

Would you rather be taught? Tell your agent **"onboard me into Yggdrasil"**. In a repository that has run `yg init`, it knows the tutor playbook and teaches you on your own code, in your own language.

## How it works

Four things live in `.yggdrasil/`, committed with your code. The agent maintains them; you decide what matters.

**The graph.** Your components and the files each one owns, the types they belong to, and which component may depend on which. The graph works out which rules reach which file, so you attach a rule once and never paste it onto files. A rule attached to a whole type reaches every component of that type, so it can stand `enforced` there only after you admit it (`yg log add --aspect <id> --ratify --by <you> --reason <why>`). Until then keep it `advisory`: with the `type_law` setting `yg init` writes, `yg check` blocks on one standing enforced without your admission.

**The rules.** Besides the built-in dependency check, a rule is one of three kinds.

| Kind | What it is | Who decides |
|---|---|---|
| **Script rule** | A `check.mjs` next to the rule | Your machine. Deterministic, local, free, no key. |
| **Reviewer rule** | Plain Markdown, like the one above | A separate model you configure, for what a script cannot decide. |
| **Bundle** | A named group of other rules | Nothing of its own. It attaches its members in one step. |

For a reviewer rule, the model sees the rule's text, the rule's description, the path and files of one component (or one file, for a rule scoped per file), any reference and companion files the rule pulls in, and the `yg-suppress` ranges in those files. A prompt over the reviewer's size limit (50,000 characters unless you set another) is a blocking error, never a cut-down review.

Lean on script rules: there is no talking past one. A reviewer is a model, and [its verdicts are not deterministic](https://krzysztofdudek.github.io/Yggdrasil/reviewers): the same code against the same rule can pass on one run and be refused on another, most often when the rule is borderline. Start a new reviewer rule as `advisory` (its refusals are reported and do not block) and enforce it once it has earned your trust.

**The lock.** Each verdict is stored with a hash of everything that produced it: the rule, the code, the files the check read. A plain `yg check` recomputes the hashes and, by default, calls no model. If an input changed, the verdict stops counting and the check says so. The lock freezes a pass as firmly as a refusal: re-running the reviewer on unchanged inputs changes neither.

**The logs.** Why the code is the way it is: each component keeps a log (`yg log add`), each type a log of the decisions that hold for all its components (`yg log add --type`), and each rule a log of its own history. `yg context` hands the agent the logs that apply beside the rules. Entries are only ever appended, and `yg init` configures git merge drivers for the logs and the lock, so two branches that each added entries or verdicts merge without a hand-resolved conflict; a verdict the two branches recorded differently is dropped and judged again.

**In CI.**

```yaml
- run: npx @chrisdudek/yg@6.1.0 check --approve --only-deterministic
- run: npx @chrisdudek/yg@6.1.0 check --no-approve
```

The first line re-runs the script rules, whose verdicts live in a local cache a fresh checkout does not have, and then reports on the whole tree, so it already fails the job on any blocking finding. It is free, but it runs the branch's own rule scripts, so on pull requests from forks run only the second line; there it reports every script pair as unverified, because that cache is local, so a repository with enforced script rules gets a red fork gate ([details](https://krzysztofdudek.github.io/Yggdrasil/the-lock#what-yg-check-proves-and-against-whom)). The second is the gate: it checks every recorded verdict against the code and fails on anything that changed without being judged again. No keys, no model calls, and `--no-approve` keeps it that way whatever the committed configuration says. Pin the version and raise the pin in a commit of its own. Caching and the rest: [CI integration](https://krzysztofdudek.github.io/Yggdrasil/getting-started#_5-ci-integration).

[How it works](https://krzysztofdudek.github.io/Yggdrasil/how-it-works) · [Rules](https://krzysztofdudek.github.io/Yggdrasil/aspects) · [The lock](https://krzysztofdudek.github.io/Yggdrasil/the-lock) · [Glossary](https://krzysztofdudek.github.io/Yggdrasil/glossary)

## Built with itself

This repository is checked by Yggdrasil in its own pre-commit hook and in CI. A snapshot from 28 September 2026: its graph held 498 components and 73 rules, mapped all 1,430 files in its coverage scope, and had 8,035 pairs verified, 6,545 by script and 1,490 by a reviewer. The graph is in [`.yggdrasil/`](https://github.com/krzysztofdudek/Yggdrasil/tree/main/.yggdrasil), and `yg portal` (or `yg portal --static`, one self-contained file) shows its live state.

The portal shows each rule with its count of verified, refused and unverified pairs. A pair nobody has judged for the current code is counted as unverified, never as a pass.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/krzysztofdudek/Yggdrasil/v6.1.0/docs/public/readme/portal-rulebook-dark.png" />
  <img src="https://raw.githubusercontent.com/krzysztofdudek/Yggdrasil/v6.1.0/docs/public/readme/portal-rulebook-light.png" alt="The Yggdrasil portal's rulebook for this repository: 73 rules, each with its kind, status, scope and a verified, refused and unverified tally." width="100%" />
</picture>

<sub>The portal's rulebook for this repository. In the portal's words, aspects are rules and nodes are components.</sub>

## Costs and limits

### What you pay

- **A new repository starts with zero reviewer pairs.** Nothing is paid until you write a reviewer rule.
- **Free:** script rules, dependency checks, a plain `yg check` and the CI gate. Local, no key, no network.
- **Reviewer rules:** one model call per pair when it is first judged, and again only after its inputs change, multiplied by the consensus count if you ask for a vote. You pay your provider per token; an agent CLI reviewer spends your subscription's usage; Ollama runs locally. `yg check --approve --dry-run` says how many paid calls a fill will make before it makes them.
- **Time:** one reviewer call takes roughly 10 to 40 seconds. A first fill of a few hundred pairs takes hours at one call at a time; `yg init` sets four at a time for an agent CLI reviewer.
- **Adoption:** on an existing codebase, the first work is usually learning that the code does not match the architecture you thought you had. [Phase 0](https://krzysztofdudek.github.io/Yggdrasil/showcase#the-phase-0-reality) is the honest account. [Progressive mode](https://krzysztofdudek.github.io/Yggdrasil/progressive-mode) makes a plain `yg check` fail only on what your change touched, and keeps everything inherited on the report as a warning.

### What it will not do

- **It checks structure, not runtime behaviour.** It can require that a function calls the audit utility. It cannot prove the audit fired in production.
- **The dependency check sees static code dependencies only.** Calls over HTTP, dependency injection, reflection and events are invisible to it, and it skips anything it cannot pin to exactly one component. You can declare those relations yourself; nothing checks them against the code.
- **A green check is only as good as the rule behind it.** A shallow rule passes shallow code. Deciding what is worth enforcing stays with you.
- **A reviewer pass is frozen like a refusal.** A pass a weaker model gave stays a pass until the code or the rule changes.
- **Changing the reviewer's model re-judges nothing.** Verdicts are tied to the reviewer tier's name, not to the model behind it. To move to another model on purpose, follow the [model-swap protocol](https://krzysztofdudek.github.io/Yggdrasil/model-swap-protocol).
- **Green means unchanged, not incorruptible.** A green `yg check` proves every recorded verdict still matches the code and rules on disk. It does not prove a reviewer produced them: the lock is a committed file, so the gate is as trustworthy as whoever can push to the branch. [What `yg check` proves, and against whom](https://krzysztofdudek.github.io/Yggdrasil/the-lock#what-yg-check-proves-and-against-whom).

## Questions

**How is this different from a rules file?** A rules file is flat text in every prompt, with no scope and no check. Here the agent gets only the rules on the file it is editing, and its output is checked against them.

**And from a pre-commit hook?** Use one, and point it at `yg check`. What a bare hook lacks is a notion of which rule applies to which file, rules that need judgment, and a lock that lets CI replay a model's verdict for free.

**And from dependency-cruiser or ArchUnit?** For import rules in one language they are mature, and if that is all you need, use them. Yggdrasil's dependency check is one part of it: one graph across eleven languages, carrying script rules, reviewer rules and the lock as well.

**And from an AI review bot?** A review bot looks for bugs against its own idea of good code and runs again on every pull request. This checks your rules, the ones only your team knows, and pays for a verdict once per version of the code it judged.

**What if I want to stop?** Delete `.yggdrasil/`. Nothing in your build or runtime depends on it. `yg init` also wrote a summary block in `AGENTS.md`, an import line in `CLAUDE.md`, `.clinerules/yggdrasil.md` and eight lines in `.gitattributes`, and in each clone two merge drivers in `.git/config` and a `post-merge` hook; delete those too to leave no trace. Your reviewer rules are plain Markdown and go wherever you go; script rules are written against Yggdrasil's `check(ctx)` contract and need porting.

## License

MIT. Yggdrasil depends on no other tool in its family: Horde requires it, Grain and Jarl use it when it is there. It installs one library of the family's shared code, `@chrisdudek/runes`, at an exact version, and needs Node.js 22 or newer.

## The Yggdrasil family

**[Jarl](https://github.com/krzysztofdudek/JarlSkill)** is the loop. **Yggdrasil** is the law. **[Grain](https://github.com/krzysztofdudek/Grain)** is the survey. **[Horde](https://github.com/krzysztofdudek/Horde)** plans the mission onto the law before anyone writes, lands every change through a gate no agent can argue with, and turns what the mission learned into law — on Jarl's loop, with Grain in the architect's hands. Those four are the core, and they ship under one version number, Jarl on it from 6.1.0: one set of tools built and tested against each other. Yggdrasil, Grain and Jarl each work alone; Horde is the one built on the other three. Where a repository has a check, the check decides what lands, in a Horde mission and in a Jarl loop alike: a fresh reviewer can only stop a change, never make a failing check pass, and its word is recorded as testimony. A Jarl loop in a repository with no check lands on testimony alone, and says so. Law that stays inside one component is raised freely by the agent working it. Law or decisions that reach a whole type of code are shared vocabulary: the agent proposes them and they run as advice at once, and the client — the one person the whole system answers to — admits them in one batch when the work closes. Only the client lowers or vetoes law. The core's shared machine contracts are registered on [one page](https://krzysztofdudek.github.io/Yggdrasil/family-contracts).

Start where it hurts; there is no ladder to climb first.

| Where it hurts | Start with |
|---|---|
| More issues than one agent can hold in its head | **Jarl** |
| The agent keeps breaking what was agreed | **Yggdrasil** |
| Nobody knows what was agreed | **Grain**, which earns its keep the moment you are about to write law |
| A task too big for one head to plan up front, in a repository that already has law | **Horde** |

| Core | What it holds |
|---|---|
| **[Jarl](https://github.com/krzysztofdudek/JarlSkill)** | The loop. Everything seen becomes an issue, each issue gets one worker in its own worktree, nothing closes without evidence and a review, and no code closes without a fresh reviewer's word. Rulings keep their history, and a ruling about a whole type of code goes to the client in one batch when the loop closes. |
| **Yggdrasil** (this one) | The law. The architecture graph, the rules over it and the log of why, checked before the agent moves on and re-proved in CI without a key. A rule that reaches a whole type runs as advice until the client ratifies it. |
| **[Grain](https://github.com/krzysztofdudek/Grain)** | The survey. Mines a repository's own code and history into a first graph — components, dependencies, and the rules the code already keeps, each with the count of places that break it today; Yggdrasil accepts it with one command. It measures and never blocks. |
| **[Horde](https://github.com/krzysztofdudek/Horde)** | The mission on the law. A one-shot architect plans the whole mission onto the graph once, measuring with Grain; a worker per ticket in its own worktree; every change lands through a nine-item gate; what the mission learned becomes law. Its record is a Jarl loop. The client orders the mission and is the only one who can lower or veto a rule. |

Four add-ons attach to the agent rather than to the graph; each works alone, depends on nothing in the family and keeps its own version. Horde doesn't assume any of them is installed — it carries its own minimum discipline in each role's law — but uses Ratatoskr, Urd and Researcher when they are, one sentence per row below.

| Add-on | Stage | What it makes the agent prove | In Horde's loop |
|---|---|---|---|
| **[Ratatoskr](https://github.com/krzysztofdudek/RatatoskrSkill)** | request → intent | Keeps the agent talking to you in plain words, not code, so you can follow what it's doing. | Keeps the client's plain-language registry open at both ends of a mission. |
| **[Urd](https://github.com/krzysztofdudek/UrdSkill)** | intent → code | When the spec is ambiguous, it consults the source of truth and asks, it doesn't guess. | The stop a worker hits before it guesses. |
| **[Researcher](https://github.com/krzysztofdudek/ResearcherSkill)** | code → measured result | Point it at a metric and it runs experiments, hypotheses kept and discarded. | Runs the retrospective's measurement. |
| **[Skald](https://github.com/krzysztofdudek/SkaldSkill)** | running product → film | A film of your software shows the real running product, never a rebuilt one, and every number and claim on screen traces back to the product's own logs. | None. Horde does not call it. |
