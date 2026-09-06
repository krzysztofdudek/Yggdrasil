---
title: Getting Started
---

Install, map your first component, and write a rule the reviewer enforces from then on. You can do the whole thing without an API key. About five minutes.

::: tip New here?
Read [How it works](/how-it-works) first for the mental model. This page is the hands-on version.
:::

## 1) Install

Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
```

## 2) Init

```bash
cd your-project
yg init
```

Run in a terminal, this scaffolds `.yggdrasil/` — config, architecture
defaults, and the agent-rules files, identical for every agent — and walks
you through one topic: which reviewer should verify your code (it asks for a
provider, then a model, and — for an API provider — checks for a key). If you
already run an agent CLI — **Claude Code, Codex, or Gemini CLI** — pick it: it
needs **no API key** and adds no separate API bill, only a check that the
tool is on your PATH. Ollama runs locally with no API cost either. The API
providers (Anthropic, OpenAI, Google) need a key, read only from an environment
variable (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` — never a
flag, so it never lands in shell history) and stored in
`.yggdrasil/yg-secrets.yaml` (automatically gitignored).

### Start keyless — no reviewer, no API key

Picking a reviewer is not required to get going. The last option in that list
is **"None for now"**, and it is a real answer, not a lesser one: script rules
(`check.mjs`), dependency control (the built-in relation-conformance check),
and the `yg check` CI gate all work immediately, for free, with nothing to
configure. Nothing is judged by an LLM yet, because nothing you've written
needs judgment yet.

Same thing without answering any question — in a terminal or out of one:

```bash
yg init --no-reviewer
```

Run the plain `yg init` with no terminal attached — Docker, a devcontainer,
CI — and it takes that route by itself, since there is nobody to ask.

Add a **judge** at any point, whenever you write your first judgment rule —
an aspect whose rule is a `content.md` an LLM reads and decides against, as
opposed to a `check.mjs` script. This one is a flag, not a prompt — it runs
identically whether or not you have a terminal:

```bash
yg init --provider claude-code
```

`--model` defaults to `sonnet` for the `claude-code` provider only; every
other provider requires `--model` explicitly. `--endpoint` defaults to
`http://localhost:11434` for `ollama`; an OpenAI-compatible provider
requires it (no default).

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

yg check: PASS (1 warning)  0 nodes · 0/50 files (0 node-owned, 0 type-covered, 0 excluded) · 0 aspects · 0 flows

Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — no file can be type-covered until you add classifying types.

Warnings (1):

  uncovered (50)
            src/…  (first 10 paths, then "... +40")
            Why: Not under a coverage.required root — visible but non-blocking. Bring an area under graph coverage to enforce it. Your architecture has no type for this file yet.
            Fix: Map these files to a node, or add their root to coverage.required to make this an error. yg type-suggest --file <path> can help design one before you decide where it belongs.
```

`yg init` turns `coverage.type_level` on by default (see [Configuration](/configuration#coverage-config)), and the fresh architecture starts with no classifying types — hence the notice line. Add a `when:` predicate to a type and matching files start satisfying coverage on their own, with no node required.

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

(A node's type must declare `when:` before the node can carry a mapping at
all — independent of type-level coverage — so the agent also gives the
payments module's type a `when: path: "src/payments/**"`. That is why the
zero-classifying-types notice from the first check above does not reappear
below: the architecture now has one classifying type, even though the
payments file itself is node-owned, not type-covered.)

Now run `yg check`:

```text
$ yg check

yg check: FAIL  1 nodes · 1/1 files (1 node-owned, 0 type-covered, 0 excluded) · 1 aspects · 0 flows

Errors (1):

  unverified (not yet reviewed)  1 pairs  1 nodes
            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.
            Fix: yg check --approve
            - payments  aspect 'requires-audit'

Next: yg check --approve
```

Check detected that the `requires-audit` rule on `src/payments/` has no recorded
verdict. The agent runs `yg check --approve` and the reviewer reads the source
code, checks it against the rules in `content.md`. The reviewer runs on stderr
and the report is written to stdout — a clean run prints the PASS header:

```text
$ yg check --approve

Filling 1 unverified pairs across 1 nodes — 0 deterministic (no cost), 1 reviewer calls (consensus included).

yg check: PASS  1 nodes · 1/1 files (1 node-owned, 0 type-covered, 0 excluded) · 1 aspects · 0 flows · 1 verified (0 deterministic, 1 LLM)
```

If the code didn't satisfy the aspect, the pair is refused and the report shows
the enforced refusal block with the reviewer's reason:

```text
yg check: FAIL  1 nodes · 1/1 files (1 node-owned, 0 type-covered, 0 excluded) · 1 aspects · 0 flows

Errors (1):

  enforced  1 pairs  1 nodes  aspect 'requires-audit'
            A refused verdict for unchanged inputs is final and cached; re-running the reviewer would only re-roll the same inputs.
            Fix: Three exits:
              1. Fix the code so it satisfies aspect 'requires-audit', then: yg check --approve
              2. Sharpen the aspect's content.md — this re-reviews EVERY node using the aspect; check `yg impact --aspect requires-audit` first.
              3. Propose a `yg-suppress` to the user (user must approve the reason).
            - payments  Reviewer reason: chargeCard() does not emit an audit event; no auditLog.emit() call in any mutation path.

Next: Three exits:
  1. Fix the code so it satisfies aspect 'requires-audit', then: yg check --approve
  2. Sharpen the aspect's content.md — this re-reviews EVERY node using the aspect; check `yg impact --aspect requires-audit` first.
  3. Propose a `yg-suppress` to the user (user must approve the reason).
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
it become blocking errors until they belong to a node, or — with `coverage.type_level`
on — until they match exactly one classifying type; files outside required
(and not excluded) stay non-blocking warnings; files under `coverage.excluded`
are silent. Subtrees with their own nested `.yggdrasil/` are auto-skipped. See
[Configuration](/configuration) for details.

::: info Whole-repo default
An _absent_ coverage block — or a repo initialized before this became the
default — requires the **whole** repo (every file is a blocking error until
mapped). Add an explicit `coverage: { required: [], excluded: [] }` to opt into
require-nothing.

That default also applies to the handful of files Yggdrasil itself maintains at
your repo root — `AGENTS.md`, `CLAUDE.md`, `.clinerules/`, `.gitattributes` — so
on such a project they show up as unmapped errors right after `yg init
--upgrade` adds them. They're repository plumbing, not project source; exclude
them (`yg init --upgrade` prints this same stanza when it applies to you):

```yaml
coverage:
  excluded:
    - AGENTS.md
    - CLAUDE.md
    - .clinerules/
    - .gitattributes
```

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
only the deterministic pairs and writes the gitignored cache (plus a port's
contract baseline when one is missing). See
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

It prints every aspect effective on that file and the `read:` path to each
rule's text. The graph computes the cascade; you read the answer. To see **where
each rule comes from** — its own node, an ancestor, the architecture type, a
flow, a port, or an `implies` edge — use `yg context --node <path>`, which adds a
`Source:` line to each aspect.

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
