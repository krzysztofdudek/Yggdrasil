---
title: Getting Started
---

Install, bootstrap a graph that works keyless from the first command, then add a judge and watch it enforce a rule you wrote. About five minutes.

::: tip New here?
Read [How it works](/how-it-works) first for the mental model. This page is the hands-on version.
:::

## 1) Install

Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
```

## 2) Init

Start **keyless** — no reviewer, no API key. Name your agent platform and go:

```bash
cd your-project
yg init --platform claude-code
```

(Swap `claude-code` for whichever platform you use: Cursor, Copilot, Codex,
Gemini CLI, etc.) This scaffolds `.yggdrasil/` — config, architecture
defaults, and the rules file for your platform — with no `reviewer:` section
at all. Script rules (`check.mjs`), dependency control (the built-in
relation-conformance check), and the `yg check` CI gate all work immediately,
for free, with nothing to configure. Nothing is judged by an LLM yet, because
nothing you've written needs judgment yet.

Add a **judge** later, whenever you write your first judgment rule — an
aspect whose rule is a `content.md` an LLM reads and decides against, as
opposed to a `check.mjs` script:

```bash
yg init --provider claude-code
```

If you already run an agent CLI — **Claude Code, Codex, or Gemini CLI** —
pick it: it needs **no API key** and adds no separate API bill, only a check
that the tool is on your PATH. Ollama runs locally with no API cost either.
The API providers (Anthropic, OpenAI, Google) need a key, read only from an
environment variable (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`GOOGLE_API_KEY` — never a flag, so it never lands in shell history) and
stored in `.yggdrasil/yg-secrets.yaml` (automatically gitignored).

Both commands above are flags, not prompts — they run identically whether or
not you have a terminal, which is what makes them the right form for Docker,
a devcontainer, or CI. `--model` defaults to `sonnet` for the `claude-code`
provider only; every other provider requires `--model` explicitly.
`--endpoint` defaults to `http://localhost:11434` for `ollama`; an
OpenAI-compatible provider requires it (no default). A run naming no
`--platform` fails with guidance instead of guessing which agent platform to
install.

::: tip Prefer to be walked through it?
Run bare `yg init` in a terminal for an interactive wizard that asks both
questions — platform, then reviewer — in one pass, fetching and validating
models for API providers as you go. Flags are authoritative: a
fully-specified command (as above) never opens the wizard, even from a
terminal.
:::

::: tip Prefer to be taught?
Tell your agent: **"onboard me into Yggdrasil"**. Agents in an adopted repo
know the tutor playbook (`yg knowledge read onboarding`) and will teach you
on your own repository, in your own language. Repo not adopted yet? Tell
the agent: _"Install @chrisdudek/yg, then run `yg knowledge read
onboarding` and follow it."_
:::

The architecture file (`.yggdrasil/yg-architecture.yaml`) ships with an empty
architecture (`node_types: {}`) and commented examples — node types are defined
per project, not pre-configured. You add the types your project needs: define
new types, set default aspects per type, constrain relations. Tell the agent to
do it:

> "Add a node type 'api' with a default aspect 'requires-auth'."

## 3) Your first aspect

After init, you have an empty graph, and `yg init` starts you in "require
nothing" mode (`coverage.required: []` in `yg-config.yaml`). So your first
`yg check` is **green** — every file shows up as a non-blocking warning, not a
blocking error:

```text
$ yg check

yg check: PASS (1 warning)  0 nodes · 0/50 files (0%) · 0 aspects · 0 flows

Warnings (1):

  uncovered (50)
            src/…  (every file, listed)
            Why: Not under a coverage.required root — visible but non-blocking. Bring an area under graph coverage to enforce it.
            Fix: Map these files to a node, or add their root to coverage.required to make this an error.
```

Nothing is enforced yet — the warnings are your to-do list. Tell your agent to
create the first rule.

Example prompt:

> "Every service that handles payments must emit audit events.
> Create an aspect for this and apply it to the payments module."

The agent will create:

```text
.yggdrasil/
  aspects/
    requires-audit/
      yg-aspect.yaml       ← name + description
      content.md            ← the actual rule (plain Markdown)
  model/
    payments/
      yg-node.yaml          ← maps src/payments/, lists requires-audit aspect
```

Now run `yg check`:

```text
$ yg check

yg check: FAIL  1 nodes · 1/1 files · 1 aspects · 0 flows

Errors (1):

  unverified (not yet reviewed)  1 pairs  1 nodes  aspect 'requires-audit'
            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.
            Fix: yg check --approve
            - payments

Next: yg check --approve
```

Check detected that the `requires-audit` rule on `src/payments/` has no recorded
verdict. The agent runs `yg check --approve` and the reviewer reads the source
code, checks it against the rules in `content.md`. The reviewer runs on stderr
and the report is written to stdout — a clean run prints the PASS header:

```text
$ yg check --approve

Filling 1 unverified pairs across 1 nodes — 0 deterministic (no cost), 1 reviewer calls (consensus included).

yg check: PASS  1 nodes · 1/1 files · 1 aspects · 0 flows · 1 verified (0 deterministic, 1 LLM)
```

If the code didn't satisfy the aspect, the pair is refused and the report shows
the enforced refusal block with the reviewer's reason:

```text
yg check: FAIL  1 nodes · 1/1 files · 1 aspects · 0 flows

Errors (1):

  enforced  1 pairs  1 nodes  aspect 'requires-audit'
            A refused verdict for unchanged inputs is final and cached; re-running the reviewer would only re-roll the same inputs.
            Fix: Three exits: fix the code; sharpen the aspect's content.md; or propose a yg-suppress (user must approve the reason).
            - payments  Reviewer reason: chargeCard() does not emit an audit event; no auditLog.emit() call in any mutation path.

Next: fix the violation, then re-run: yg check --approve
```

The agent fixes the code and re-runs `yg check --approve` until all aspects pass.

::: tip Start new aspects at `status: advisory`
A brand-new aspect on an existing codebase often surfaces violations across many files. Authoring it as `status: advisory` runs the reviewer and lists refusals as warnings, without blocking CI. Once the rule has been exercised across the repo and the warnings are clean (or knowingly accepted), promote to `status: enforced`. See [Aspect Status](/aspect-status) for the full lifecycle.
:::

## 4) Existing codebase (brownfield)

`yg init` writes `coverage.required: []` — "require nothing" — so a fresh repo
of any size is **green from the first check**, with every unmapped file shown as
a non-blocking warning. You tighten coverage as you go: add a path prefix to
`coverage.required` in `yg-config.yaml` (e.g. `- src/payments/`) and files under
it become blocking errors until they belong to a node; files outside required
(and not excluded) stay non-blocking warnings; files under `coverage.excluded`
are silent. Subtrees with their own nested `.yggdrasil/` are auto-skipped. See
[Configuration](/configuration) for details.

::: info Whole-repo default
An _absent_ coverage block — or a repo initialized before this became the
default — requires the **whole** repo (every file is a blocking error until
mapped). Add an explicit `coverage: { required: [], excluded: [] }` to opt into
require-nothing.
:::

The fast path: **minimal nodes (no aspects) for everything you're not working
on, proper nodes with aspects for what you are.**

Tell your agent:

> "Create nodes without aspects for: src/legacy/, lib/, scripts/. Then create
> a proper node for src/payments/ with the requires-audit aspect."

Nodes without aspects are cheap — just a `yg-node.yaml` with a directory
mapping. They produce no pairs, so there is nothing to verify and nothing
to record. They count as covered for free.

When you start working on a covered area, add aspects to enforce rules.
This is how coverage naturally expands into enforcement as you work.

Practical steps for a 200-file repo:

1. Create 5-8 nodes without aspects for broad directory mappings
2. Create 1-2 nodes with aspects for your active work area
3. Run `yg check --approve` (aspect-less nodes produce no pairs, so the
   only cost is the reviewer pairs on your active work area)
4. `yg check` passes — CI is green
5. Add aspects to more nodes as you touch more code

## 5) CI integration

Add `yg check` to your CI pipeline. It recomputes the input hash of every
expected pair and compares it against the verdict recorded in the lock — no
LLM calls, no provider keys, runs instantly. Exit code 1 means a pair changed
without being re-verified.

The lock's deterministic verdicts live in a gitignored local cache
(`.yg-lock.deterministic.json`), so a fresh CI checkout starts without them and
`yg check` would report those pairs as unverified. Rebuild the cache first — it's
free and needs no key — with `yg check --approve --only-deterministic`, which fills
only the deterministic pairs and writes only the gitignored cache. See
[The lock](/the-lock) for the file layout.

**GitHub Actions:**

```yaml
- name: Rebuild the deterministic cache (free, no keys)
  run: npx @chrisdudek/yg check --approve --only-deterministic
- name: Check architecture
  run: npx @chrisdudek/yg check
```

If check fails, it means a pair's inputs changed without being re-verified.
Tell the agent: "resolve all yg check issues" and it will run `yg check
--approve`, fix violations, and re-verify until check passes.

## 6) Core vs. advanced — what to learn when

Yggdrasil has a lot of surface area, but you only need a few ideas to be
productive. Learn the rest the day you actually need it.

**Core — everything above this point.** Four concepts carry day-to-day work:

- **Node** — maps a set of source files (a `yg-node.yaml` with a `mapping:`).
- **Aspect** — one enforceable rule (`content.md` for the LLM reviewer, or
  `check.mjs` for a deterministic one).
- **`yg check`** — the gate. By default hash-only, no LLM, no keys, runs in CI.
  Red until every changed pair is re-verified. (If `auto_approve` is set in
  `yg-config.yaml`, bare `yg check` may fill pairs automatically — see
  [Configuration](/configuration#auto-approve-config). CI scripts always use
  explicit flags and are unaffected.)
- **`yg check --approve`** — verifies the unverified pairs (deterministic for
  free, then LLM) and records the verdicts in the lock so check goes green.

Plus aspect **status** (`draft` → `advisory` → `enforced`) to control whether a
rule blocks. That is enough to enforce real rules on a real codebase.

**Advanced — reach for these only when a rule needs to scale past one node.**
Aspect inheritance through the node hierarchy, architecture type-defaults,
`implies` chains, flows, ports, and conditional `when` predicates all exist for
one purpose: applying a rule to many nodes **without** copy-pasting it onto each
one. You do not need any of them to start. When "every X must do Y" spans more
than a handful of files, that is the signal to read
[How it works](/how-it-works) and adopt one of these mechanisms.

**You never trace the cascade by hand.** No matter how many of those mechanisms
are in play, you do not work out which rules apply to a file by reading the
graph yourself. Ask the tool:

```bash
yg context --file src/payments/charge.ts
```

It prints every aspect effective on that file, **where each one came from**
(its own node, an ancestor, the architecture type, a flow, a port, or an
`implies` edge), and the `read:` path to each rule's text. The graph computes
the cascade; you read the answer. `yg context --node <path>` does the same from
a node's point of view.

::: info Zero lock-in
Delete `.yggdrasil/` and your project works exactly as before. No build dependencies, no runtime hooks.
:::

---

_Want to understand the model?_

- [How it works](/how-it-works) — the model: rails, the three players, the loop
- [Aspects](/aspects) — write your first rule
- [Nodes](/nodes) — group files into components
- [Configuration](/configuration) — reviewer setup, quality thresholds
- [CLI reference](/cli-reference) — all commands
