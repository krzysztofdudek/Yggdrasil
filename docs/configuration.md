---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file. A bare, non-interactive `yg init` (no `--provider`)
writes it with no `reviewer:` section at all — a keyless, script-only start.
A reviewer is configured separately, interactively or via `--provider [--model]
[--endpoint]`, whenever the graph gains its first judgment (LLM) rule.
`yg init --upgrade` lifts the graph's config version to the current one and
refreshes the agent-rules files.

---

## Schema

### Required

- **version** — Schema version managed by the CLI. Do not edit manually. Run `yg init --upgrade` to upgrade.

### Conditionally required

- **reviewer** — Reviewer configuration; when present, must contain `tiers` with at least one entry. Required only once a judgment (LLM) rule is actually effective in the graph — a script-only / keyless project (deterministic aspects only, or none) needs no `reviewer:` section, and `yg check` does not ask for one until an LLM aspect exists. Configured via `yg init` (interactively, or non-interactively with `--provider`); see [Reviewer tiers](#reviewer-tiers) below.
- **reviewer.default** — Tier name aspects fall back to when they don't declare one. Required when `reviewer.tiers` has more than one entry; optional with exactly one tier.

### Optional

- **coverage** — Controls which files must be mapped to a node (see [Coverage config](#coverage-config) below).
- **quality** — Quality thresholds (see [Quality config](#quality-config) below).
- **parallel** — How many **LLM (reviewer) verifications** run concurrently (positive integer, default `1`). Governs only the reviewer fill phase, where the cost is network latency. Deterministic checks ignore it — they are CPU-bound and run across a worker-thread pool sized automatically from your machine's cores (no configuration; never affects verdicts, only speed).
- **debug** — Set `true` to append all CLI output to `.yggdrasil/.debug.log`.
- **auto_approve** — Auto-fill mode for bare `yg check` (default `false`; see [Auto-approve config](#auto-approve-config) below).
- **signals** — Attention-layer switches (optional). Its only key today is `attention` (default `true`): the advisory "structurally unusual" note in `yg context --file`. Set `false` to silence it. See [Signals](#signals) below and [Structural attention](/feature-field).
- **events** — Committed-events opt-in (optional). Its only key today is `committed_llm` (default `false`): opt into a committed, team-shared record of LLM verification events. See [Events](#events) below.
- **progressive** — Names the branch your changes are measured against (optional; absent means off). Its only key today is `reference`. With it set, a plain `yg check` blocks only on what your change reaches, and everything inherited from that branch is listed as a non-blocking warning. See [Progressive mode](#progressive-mode) below and the [Progressive mode](/progressive-mode) page.

Those ten are the whole of it — `version`, `reviewer`, `coverage`, `quality`,
`parallel`, `debug`, `auto_approve`, `signals`, `events`, `progressive`.

::: warning A typo at the top level is silent
The parser reads the ten keys above and ignores anything else it finds at the top
level, with no error and no warning. So `auto_aprove: full` does not enable
auto-approval — it does nothing at all, and the check that would tell you so does
not exist. Several nested places *are* guarded: a misspelled key directly under
`reviewer:` or inside a tier is a hard `config-reviewer-unknown-key` /
`config-tier-unknown-key` error, and `signals:`, `events:`, `coverage:` and
`progressive:` all reject unknown keys too. Copy the names from this page rather
than typing them from memory, and confirm a setting took effect by watching the
behaviour change.
:::

Node types are defined in the separate **architecture file** (`.yggdrasil/yg-architecture.yaml`),
not in `yg-config.yaml`.

---

## Full annotated example

```yaml
version: "5.2.0"

reviewer:
  default: standard                 # Required when more than one tier; optional with one
  tiers:
    standard:                       # Tier name — referenced by aspect reviewer.tier
      provider: ollama              # LLM provider
      consensus: 1                  # Votes per aspect (odd integer >= 1)
      max_prompt_chars: 50000       # Cap on the assembled prompt (optional; absent defaults to 50000)
      config:
        model: qwen3
        endpoint: http://localhost:11434
        temperature: 0

coverage:                             # Optional — controls which files must be mapped
  required:                           # Unmapped files under these roots are a blocking error
    - "/"                             # Default: whole repo
  excluded: []                        # Files under these roots are silently ignored

quality:
  max_direct_relations: 10

parallel: 10                          # Concurrent LLM verifications (reviewer phase only)
debug: false
auto_approve: false   # false (default) | deterministic | full

signals:                              # Optional — attention-layer switches
  attention: true                     # The "structurally unusual" note in yg context --file (default true)

events:                               # Optional — committed-events opt-in (default off)
  committed_llm: true                 # Commit + share LLM verification events (default false)

# progressive:                        # Optional — absent means off (every run answers for the whole project)
#   reference: origin/main            # Branch your changes are measured against
```

---

## Reviewer tiers

Reviewer configuration uses **named tiers**. Each tier is an independent LLM
configuration. Aspects target a tier via `reviewer.tier: <name>` in
`yg-aspect.yaml`. If no `tier:` is declared on an aspect, the aspect uses
`reviewer.default` from the config.

### reviewer.default

The tier name aspects fall back to when they don't declare `reviewer.tier:`.

- **Required** when `reviewer.tiers` has more than one entry — the validator
  emits `config-default-tier-missing` otherwise.
- **Optional** when `reviewer.tiers` has exactly one entry; the single tier is
  the implicit default.
- Must reference a key under `reviewer.tiers`.

### reviewer.tiers.\<name\>

Tier name regex: `^[a-zA-Z][a-zA-Z0-9_-]{0,62}$`. The literal name `default` is
**reserved** (it would clash with `reviewer.default` visually). Convention:
`standard` for the primary tier. Add a second tier (e.g. `deep`) for aspects
that need a higher-capability model.

```yaml
reviewer:
  default: deep
  tiers:
    standard:
      provider: anthropic
      consensus: 3
      config:
        model: claude-opus-4-7
        temperature: 0
    deep:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        endpoint: http://localhost:11434
```

An aspect targeting the `standard` tier (overriding the default):

```yaml
reviewer:
  type: llm
  tier: standard
```

An aspect with no explicit tier uses `reviewer.default` (`deep` in the above example):

```yaml
reviewer:
  type: llm
```

### Fields per tier

| Field | Required | Description |
| --- | --- | --- |
| `provider` | yes | One of the supported providers (see below) |
| `consensus` | yes | Positive odd integer. `1` = single call. `3` = majority vote. |
| `max_prompt_chars` | no | Positive integer. Caps the assembled-prompt length for LLM pairs on this tier (see [Prompt-size gate](#prompt-size-gate)). Absent defaults to 50000. `yg init` writes `50000`. |
| `config.model` | required for `ollama` / `openai` / `anthropic` / `google` / `openai-compatible`; optional for the CLI providers | Provider-specific model identifier. Omitted on a CLI provider it defaults to: `claude-code` → `haiku`, `codex` → `o4-mini`, `gemini-cli` → `gemini-2.5-flash`. |
| `config.temperature` | no | Sampling temperature. Defaults to `0`. |
| `config.endpoint` | required for `openai-compatible` (ollama defaults to `http://localhost:11434`) | API endpoint URL |
| `config.timeout` | no | Per-call timeout in seconds. Defaults to `300`. Honored by CLI providers and the `ollama` provider; other hosted API providers ignore it. |
| `config.api_key` | no | Provider API key. Takes precedence over the provider's environment variable. Do not put it in `yg-config.yaml` — supply it through the gitignored `yg-secrets.yaml` overlay (see the Secrets section below). |

Unknown `config.*` keys are silently ignored (no error, no warning) — only the
keys listed above are read.

### Supported providers

| Provider | Type | Notes |
| --- | --- | --- |
| `ollama` | local | No API cost; requires local install |
| `anthropic` | API | Requires `ANTHROPIC_API_KEY` or `yg-secrets.yaml` |
| `openai` | API | Requires `OPENAI_API_KEY` |
| `google` | API | Requires `GOOGLE_API_KEY` |
| `openai-compatible` | API | Any OpenAI-compatible endpoint |
| `claude-code` | CLI | Delegates to the installed `claude` CLI |
| `codex` | CLI | Delegates to the installed `codex` CLI |
| `gemini-cli` | CLI | Delegates to the installed `gemini` CLI |

CLI providers (claude-code, codex, gemini-cli) require no API key — they delegate to the
installed CLI tool.

---

## Secrets and local overrides

`.yggdrasil/yg-secrets.yaml` is a deep-merge overlay over `yg-config.yaml`
(gitignored by default). It mirrors the same shape, and any field in it wins —
use it for a tier's API key, or to point a named tier at a different
provider/model/endpoint on your machine:

```yaml
# .yggdrasil/yg-secrets.yaml — gitignored, never commit
reviewer:
  tiers:
    standard:
      config:
        api_key: sk-ant-...
```

Because only the tier **name** is folded into a verdict's hash, a local override
never invalidates recorded baselines: the committed config names a canonical
reviewer, and each machine points the same named tier at its own provider, model,
or key.

API providers also check environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`. If the env var is set, the key is not needed in `yg-secrets.yaml`.

`yg-config.yaml` itself must never contain credentials. Commit it to the repository.

---

## Coverage config

```yaml
coverage:
  required:
    - src/                  # files under src/ must be mapped — unmapped is a blocking error
  excluded:
    - vendor/               # files under vendor/ are silently ignored
    - "**/*.generated.ts"   # glob: generated files anywhere are ignored
```

Controls which coverage-visible files must be mapped to a node in `yg check`.

- **`required`** — List of roots. Files under a required root that are not mapped to any node produce an `unmapped-files` error (blocks CI). Default: `["/"]` (the whole repo — reproduces the previous always-map-everything behavior). An explicit empty list `[]` means **require nothing** — every uncovered file (outside `excluded`/nested) becomes a non-blocking `uncovered-advisory` warning and nothing blocks (pure-advisory adoption: you still see the full uncovered surface, but CI stays green on coverage). The empty list only takes effect when written explicitly; omitting the whole `coverage` block keeps the `["/"]` default. `yg init` writes an explicit `required: []` into a fresh `yg-config.yaml`, so newly-initialized projects start in require-nothing mode (green from the first check) — add roots as you bring areas under enforcement.
- **`excluded`** — List of roots. Files under an excluded root are silently ignored regardless of other rules — this holds even when a MORE SPECIFIC required root also matches the same file; exclusion always wins once it matches at all. Exclusion is a global filter, not just a coverage-tiering rule: it cuts a matched path everywhere Yggdrasil looks, including a node's own `mapping:` entry naming that exact path. See below for the full reach of `excluded`.
- **`type_level`** — Boolean, default `false`. Turns on type-level coverage: a file matched by exactly one classifying type's `when` predicate counts as covered by that type even though it has no node of its own. Committed config only — the gitignored `yg-secrets.yaml` overlay can never change it, since the flag changes what counts as covered/uncovered for `yg check`, and that must be the same for everyone working on the repo rather than something a local override can silently flip. Omitting the key (or the whole `coverage` block) leaves today's file-only coverage exactly as it is.

  With it on, every uncovered file is classified against every type that has a `when` predicate, and lands in exactly one outcome — one issue per file, the most-binding outcome wins, and none of the first four ever also shows up in the plain `unmapped-files`/`uncovered-advisory` listing (each already has its own, more specific verdict):
  - **Exactly one type matches** — covered. No issue at all.
  - **Two or more types match, none of them `enforce: strict`** — a new blocking error, `ambiguous-node-type`. It names every matching type and gives two ways to resolve it: create an explicit node declaring the intended type (its verdicts re-key under that node — nothing is lost), or narrow one type's `when` in `yg-architecture.yaml` so only one still matches (existing verdicts revalidate for free). This fires independent of `required`/advisory root tiering — an ambiguous file blocks even if it sits outside every `required` root. (A file under an `excluded` root is exempt entirely — see below.) It is *not* independent of [progressive mode](#progressive-mode), which is the one setting that moves it: with a reference branch named, an ambiguous file your change never touched is listed as a warning, and `yg check --full` blocks on it again. With no reference named — the default — it blocks unconditionally, as described.
  - **A matching type has `enforce: strict`** — left entirely to that type's own backward-scan error (`type-strict-orphan` or `type-strict-misplaced`; see [Node types](/nodes#enforce-strict-—-both-directions)), never also reported as ambiguous. If the file also matches another, non-strict type, the strict error's message names it too.
  - **A matching type's `when` could not be evaluated at all** (for example, a `content:` predicate on a file over the 5MB scan limit) — a blocking `file-unreadable` error, the same code the strict backward scan uses for the same situation.
  - **No type matches at all** — the one outcome still reported through the ordinary `unmapped-files`/`uncovered-advisory` path, same as today, except the message now says plainly that the architecture has no type for the file — distinct from a file that matches a type but simply has no node.

  A file under an `excluded` root is skipped before any of this — never classified against a type, and never counted as `node-owned` or `type-covered`. With `type_level` on, it is still counted (into its own `excluded` bucket) and reported in `yg check`'s summary line, exactly like a file the plain `required`/`excluded` tiering already excludes — see the summary-line format below. This surfaced count stays behind the `type_level` flag; a project that has not turned it on never sees an excluded count anywhere `yg check`'s header reports.

  A fresh `yg init` writes `type_level: true` into the new project's config (with a comment explaining it does nothing until a type declares `when:`) — existing projects keep the schema default of `false` until they opt in. With it on, `yg check`'s summary line names three honest buckets: `N/M files (A node-owned, B type-covered, C excluded)`. "node-owned" counts only files an actual node mapping covers — a file under an `excluded` root gets its own term instead, since being exempt from enforcement is not the same fact as a node actually owning the file. If it's on but no type declares `when:` anywhere in `yg-architecture.yaml` — true of every fresh project until its first classifying type is added — the classification lattice can never match a single file, so `yg check` prints a standing one-line notice saying so rather than silently doing nothing.

  Being type-covered satisfies coverage; it does not by itself mean a rule actually runs. A rule attached to the matched type can be whole-unit (scoped to the whole component, so there is nothing to run it against on a file with no component of its own), filtered off by its own `when:`, still draft, unreadable, excluded by its own `scope.files` filter, an id the architecture attaches with no matching rule definition, or — for an LLM rule — matched to a binary file it can never review as prose. `yg check` reports both halves per matched type: which rules actually enforce, and which are attached but do not, each with the reason and how many files it affects. A rule can be enforced (a real pair exists) and still never produce a verdict on a component-free file, when its check.mjs itself needs `ctx.node`/`ctx.graph` or reads beyond what the architecture lets the type reach — that failure is only ever observable by actually running the check, so only `yg check --approve` can ever name the SPECIFIC reason, in its own post-fill report ("cannot run — …" beside the enforced count, in place of the plain "unverified" every other not-yet-approved pair gets); none of plain `yg check`, `yg context --file`, `yg owner --file`, `yg tree`, or the portal ever run the check themselves, so none of them can ever say *why* — but each still says *whether*, from a real re-verification of the lock, not merely whether an entry happens to exist, and all five agree exactly: none reads a stale entry as clean just because the lock holds some entry for it. Plain `yg check` already recomputes every pair's input hash, so its own qualified "unverified" count already covers both a pair the lock has never recorded and one whose recorded verdict has gone stale since a source edit (the file, the aspect, or the rule itself changed since the verdict was written). `yg owner --file` and `yg context --file` perform that identical re-verification too, scoped to just the one file asked about — cheap on top of the whole-project pair walk both already run to classify that file, never a second one — so a stale entry reads there exactly the way it does in `yg check`'s own count: "(N of M rules unverified — no valid verdict is currently on record for it)" for `yg owner --file`, `[enforced, unverified]` per rule for `yg context --file`. `yg tree` and the portal answer for every type-covered file in the project rather than one, so the identical re-verification is a different cost each absorbs its own way: the portal already runs a full lock verification for its other counts and reads the nodeless-pair result straight out of it, at no added cost; `yg tree` pays a bounded, dedicated re-verification of the project's nodeless pairs (comfortably under `yg check`'s own full-project pass) rather than settle for a cheaper presence check that could call a stale pair clean. Both append the identical "with no recorded verdict" wording for the same fact the two file-scoped commands report — on both the chip and the per-file row for the portal, and on `yg tree`'s own summary line — whether that pair's verdict is missing entirely or present but stale. A rule whose effective status is `advisory` (it runs, but only warns) is named under its own heading, never folded in with the rules that actually block — a heading that says "enforced" never covers one that merely warns. When a rule is grouped (a bundle whose implied rules split across a file-level and a whole-unit half), the block names the split explicitly rather than letting the whole-unit half look silently absent. It also names, once, where a type's implicit parent chain stops (a fork between two parents, a cycle, or nothing above it — an omitted `parents:` and an explicit `parents: []` are indistinguishable by the time a file reaches this report, so the wording never claims to know which one the author wrote). Because none of this stops a file from satisfying coverage, a repo can have files that are green with genuinely nothing checking them; `yg check` names every one of them plainly, with samples, rather than leaving that discoverable only by accident. `yg context --file <path>` and `yg owner --file <path>` give the same honest answer for one such file directly, in place of a plain "not covered" — the matched type, the chain, both the rules that apply (with their real status) and the ones that do not, and — when literally nothing applies — say so plainly rather than staying silent or claiming enforcement that isn't there. All five surfaces — `yg check`, `yg context --file`, `yg owner --file`, `yg tree`, and the portal — also agree on the one case "no rule applies" cannot cover: when the matched type's rules could not be worked out at all because an aspect `implies` cycle reaches it, each says so and names the cycle, instead of reporting the file as satisfying coverage with zero enforcement. `yg context --file` and `yg owner --file` report it as an error for the one file asked about; `yg check`'s per-type block and its repo-wide zero-enforcement line both keep such a file out of "nothing applies" and name the cycle in their own section instead — the same structural fault `yg check` also reports, and blocks on, separately, as its usual `aspect-implies-cycle` error. The portal keeps such a file out of both its "satisfied" and "no rule applies" residue lines and lists it under its own "could not be worked out" line, naming the cycle, in the Coverage & Audit ledger and the Overview residue.
- **The navigation surfaces know about type-covered files too, not only `yg check`.** `yg tree` prints a summary line, after the node listing, splitting the type-level lattice's total the same three ways the portal's own residue lines do: how many files are checked by at least one applicable rule, how many matched a type with nothing that applies, and — only when it occurs — how many had their matched type's rules blocked from ever being worked out by an aspect `implies` cycle (never a synthetic tree entry — the node listing above it stays nodes-only); the count is repo-wide even under `--root`, since a type-covered file has no place in the hierarchy for that flag to scope it to. `yg find` indexes a type-covered file with its matched type's own description as searchable text; when that file is the top-ranked result, `yg find`'s one terminal `Next:` line points at `yg context --file`, never a phantom `--node` target — when a node or an aspect outranks it instead, that higher-ranked entry's own next step is shown there instead. `yg structure` widens its dependency universe with every statically-resolved import touching a type-covered file (named by the file's own path) and says "component or type-covered file" rather than misnaming a file a component. The portal's Overview and Coverage & audit views never call a type-covered file "unmapped" — one with an applicable rule is accounted for on its own line, distinct from the residue of files nothing checks at all; one whose matched type enforces nothing is not folded into that same line either — it gets its own, honestly-labeled line naming the file by path and type, using the same treatment as any other file nothing checks; and one whose matched type's rules an aspect `implies` cycle stopped from ever being resolved gets a third line of its own, reported as unknown rather than folded into either. The portal's Dependency-structure panel widens the same way `yg structure` does. Three of these stay exactly as they are today when the flag is off: `yg tree`'s summary line disappears entirely, and `yg find`, `yg structure`, and the portal's type-covered accounting lines behave as they do for any file the type-level lattice never touches. The one exception is the portal's excluded-file handling: `coverage.excluded` was never conditioned on `type_level`, so a file under an excluded root is listed under its own "deliberately excluded from coverage, never enforced" block whether or not the tier is on — but that file was already outside the "source files unmapped (unguarded)" count before this change, so a project that sets `coverage.excluded` without ever turning the tier on does not see that count move. What it does see: the residue CSV export's row for that file changes kind from `uncovered-file` to `excluded-file`, and the JSON export moves the file's path out of `uncoveredFiles` and into its own `excludedFiles` list.
- **Roots accept the same forms as a node `mapping:` entry** — an exact file, a directory prefix (e.g. `src/`), or a [minimatch](https://github.com/isaacs/minimatch) glob (`*` within a path segment, `**` across segments). So `excluded: ["**/*.generated.ts"]` ignores generated files anywhere, and `required: ["services/*/api/**"]` scopes the blocking tier to a pattern. `/` still means the whole repo.
- **The files Yggdrasil maintains at your repo root count like any other.** `yg init` writes and keeps up to date `AGENTS.md`, `CLAUDE.md`, `.clinerules/yggdrasil.md` and a `.gitattributes` entry. Under a whole-repo `required` (including the absent-block default) they are unmapped files like any other, so they become blocking errors the moment `yg init --upgrade` adds them to an existing project. They are repository plumbing rather than project source — the usual answer is to exclude them (`yg init --upgrade` prints this stanza whenever it applies to your project, and never edits the file itself), though mapping them to a node works equally well:

  ```yaml
  coverage:
    excluded:
      - AGENTS.md
      - CLAUDE.md
      - .clinerules/
      - .gitattributes
  ```

- Files that match neither a required nor an excluded root produce a non-blocking `uncovered-advisory` warning.
- **`excluded` is a supreme, global filter — one rule, no seam between how a mapping reaches a file.** A path it matches is gone everywhere Yggdrasil looks: the repo-walking coverage checks, expected review pairs, a node's source fingerprint, the dependency-conformance pass (both its per-node file enumeration AND its resolution of an import's target file back to an owner — an import reaching *into* an excluded subtree is as silent as one reaching *out of* it), type-`when` classification (including the strict backward scan a type's `enforce: strict` runs), the mapping-overlap check, the suppression/audit universe (`yg suppressions`, `yg advise`), the portal, and the files/allowances a rule's review actually runs against — `ctx.fs`, the parsers, and companion resolution all refuse a path there too, including one reached through a symlink that resolves into an excluded location. `yg context --file`, `yg owner --file`, `yg impact --file`, `yg aspect-test --file`, and `yg type-suggest --file` agree: an excluded file is never reported as owned by, or bound to satisfy the rules of, any node, and editing it never carries a re-verification cost. This applies identically whether a directory or glob mapping entry merely swept the file in, or a node's own `mapping:` entry names that exact path — an explicit claim does not outrank an exclusion. It is unaffected by whether `.gitignore` hides anything: exclusion is read off the adopter's `coverage.excluded` config and the filesystem, not off any particular mapping's own file listing.

  The excluded set has two sources. The adopter's own `coverage.excluded` config is one. The other is **default membership**: a subtree that is its own separate project is a member of the excluded set whether or not any `coverage.excluded` line mentions it. "Its own separate project" means a subtree that carries its own nested `.yggdrasil/` graph, or its own `.git` — a fully independent checkout, a submodule, or a linked `git worktree`; membership is read off the real filesystem, not guessed from a name, so an ordinary subdirectory with no graph or git checkout of its own — including a dependency directory such as `node_modules` or `vendor` — is unaffected and still gets covered normally. Excluding a dependency directory by name (rather than because it happens to carry its own git checkout) is the adopter's own `coverage.excluded` config, the first source above.

  A mapping entry that resolves to nothing because every file it would have reached is excluded must say so, naming exclusion as the reason: `file-mapping-excluded` fires for an entry that names one file exactly and that file is excluded, and the aggregate `mapping-path-missing` check fires when a node's mapping entries, taken as a whole, resolve to nothing this node can enforce because every file they reached is excluded — the same code a stale glob or a deleted file produces, since a node with real, non-empty `mapping:` and zero enforceable files needs to say so somewhere regardless of why the files vanished. A glob or exact entry's own per-entry existence check stays silent when the path resolves to real, on-disk content that happens to be excluded — that content is not stale or broken, so blaming it there would be wrong; the aggregate check is what reports the "nothing left to enforce" fact.

A file matching ANY excluded root is dropped entirely, before it is ever sorted into the blocking or advisory tier — exclusion is absolute, independent of whether a required root also matches it and independent of how specific either root is. Among the files that match no excluded root, any matching required root puts the file in the blocking tier. A required root fully contained inside an excluded root can therefore never match anything; `yg check` warns (`coverage-required-shadowed`) when both roots are plain (non-glob) paths.

**An empty `required` list means no file can ever fail coverage.** That is the shipped default — `yg init` writes `required: []`, and so does a mined proposal — and it is deliberate: a brownfield repository is green from its first check. But its consequence is invisible from the report alone, because the uncovered files are listed either way and only their severity differs. So whenever nothing is required and something is uncovered, `yg check` prints one standing line saying that those files can never fail, and naming the setting that changes it:

```text
Nothing is required to be covered, so the 13 uncovered files this run lists can never fail a check — only ever be listed. Name a path under coverage.required in .yggdrasil/yg-config.yaml to make files under it block until a component owns them.
```

Like every other standing line, it is a statement of fact rather than a finding: never counted among the warnings, never blocking, and gone the moment either half stops being true — a root is required, or nothing is left uncovered.

---

## Prompt-size gate

A tier's optional `max_prompt_chars` caps the length of the prompt the LLM
reviewer assembles for each pair. The prompt for each LLM pair is composed of:
the rule text (`content.md`), any static reference files, the unit's subject files,
and — when the aspect ships a `companion.mjs` — any companion files the hook
resolved for that unit. All of these count toward the limit.

`yg check` measures the assembled prompt for every expected LLM pair and reports
`prompt-too-large` — a blocking error — when it exceeds the resolved tier's limit.
The check is deterministic and costs nothing; deterministic pairs have no prompt
and are never subject to it.

```yaml
reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      max_prompt_chars: 50000
      config: { model: claude-haiku-4-5, temperature: 0 }
```

When a pair trips the gate, the remedies in safety order are:

1. **Narrow `scope.files`** on the aspect so non-target payload (fixtures, generated
   files) drops out of the subject set.
2. **Switch the aspect to `per: file`** — only if the rule is file-local; a per-file
   reviewer cannot judge a cross-file rule.
3. **Split the node** into children.
4. **Raise the limit** or move the aspect to a higher-limit tier — but tier choice is
   part of a pair's identity, so a tier edit re-verifies every pair resolving to it.

`max_prompt_chars` is a gate, not a verdict input: lowering it can make an
already-verified pair trip the gate without invalidating its recorded verdict.

---

## Quality config

```yaml
quality:
  max_direct_relations: 10        # Max out-edges per node (high-fan-out warning)
```

`max_direct_relations` fires a warning when a node's outgoing relation count
exceeds it — a signal that the node may be doing too much. It is the only
quality threshold.

### Per-node reviewed-seam override

A node may declare its own justified ceiling in its `yg-node.yaml`, which **sets
that node's own limit, replacing the global default for it**:

```yaml
max_direct_relations:
  limit: 21
  reason: "Single auditable gateway that concentrates this coupling by design."
```

The declared limit **sets the ceiling for that node only** — it may be **higher**
than the global (a genuine single-responsibility seam — one auditable gateway or
orchestrator that concentrates coupling *by design*, where splitting would defeat
the architecture) **or lower** (holding this node to a stricter budget than the
rest of the repo). Only the safe direction adds warnings: a limit *below* the
global makes the node stricter. The global default still governs every other node,
and this node still warns if it exceeds the number it declares here — so the
allowance sanctions a specific, reviewed count rather than loosening the check
globally. Both fields are required; a partial or malformed override — including a
`limit` below `1` — is ignored and the strict global default applies. It is a
check parameter only — never a verification input — so declaring it re-verifies
nothing. The number and its justification are surfaced by `yg context --node` and
`yg schemas read node`, keeping the exception explicit and auditable in the graph.

---

## Local state — what never gets committed

Everything Yggdrasil derives locally lives under `.yggdrasil/` and is kept out of
git by a single `.yggdrasil/.gitignore` that `yg init` writes and every
`yg init --upgrade` tops up (missing lines are appended; lines already there, and
any of your own, are left alone). There is no repo-root entry to maintain
separately.

| Entry | What it is |
| --- | --- |
| `yg-secrets.yaml` | Your local overlay — provider keys and machine-specific tier overrides. |
| `.symbols-cache/` | A retired predecessor of the cache below. Nothing writes it any more; the entry stays so leftovers in an older checkout keep being ignored. |
| `.ast-cache/` | The relation pass's content-addressed per-file parse cache — the live one. |
| `.type-class-cache/` | The type-level classification lattice's per-file cache, keyed by a file's own path together with its raw byte content and the architecture's classifying types — skips re-evaluating a file's classifying-type predicates when none of its path, its content, or the architecture's classifying types have changed. |
| `.debug.log` | The opt-in command log written when `debug: true`. |
| `.yg-lock.deterministic.json` | The script-rule verdict cache — rebuilt free and keyless by `yg check --approve --only-deterministic`. |
| `.yg-events.jsonl` | The verdict-events telemetry sidecar (see [Verdict-events sidecar](/reviewers#verdict-events-sidecar)). |
| `.yg-fill-divergence.log` | Forensic evidence, written only when a single run disagrees with itself because something outside Yggdrasil rewrote a tracked file mid-run (see [Running in parallel](/concurrency)). |
| `.feature-field.json` | The silent structural-deviation index behind the [structural-attention](/feature-field) hint. |

Every one of them is rebuildable, so a fresh clone missing all of them is a normal
state, not a broken one. The only thing a fresh clone *notices* is the absent
verdict cache: those pairs read as unverified until
`yg check --approve --only-deterministic` rematerializes them.

The committed side is the graph itself — `yg-config.yaml`, `yg-architecture.yaml`,
the `model/`, `aspects/` and `flows/` trees, the two committed lock files, the
incident ledger, the attention-decision record, and (when opted in) the shared
events stream.

---

## Upgrading

```bash
yg init --upgrade
```

Lifts the graph's config version to the current one and refreshes the
agent-rules files (the `AGENTS.md` digest block, the `CLAUDE.md` import, and
`.clinerules/yggdrasil.md`) to the installed CLI's current content — no flag
needed to say which agent to write for, since the same files are written for
every agent. It also sweeps away any file a retired per-platform installer
left behind from an older CLI. (Upgrading a pre-5.1.0 graph also removes the
now-retired on-disk `schemas/` directory; schemas are read with
`yg schemas read <name>` instead.)

The legacy single-section reviewer format (flat provider keys + `reviewer.active`)
is **not** migrated — the upgrade leaves the `reviewer:` block untouched, so a
config still in that shape then fails `yg check` with a `config-reviewer-unknown-key`
error on `active`. Convert it to `reviewer.tiers` by hand (see the tier fields
above).
Retired fields are SILENTLY IGNORED — a `yg-config.yaml` still carrying
`quality.max_node_chars`, per-tier `config.references:` size caps, or other
retired `config.*` keys (e.g. `config.context_length_field`) produces no error and
no warning; the parser simply does not read them. Review the diff after upgrade
and delete the dead lines by hand. This is distinct from the parser's
unknown-KEY guard: a typo'd key under `reviewer:` or under a tier still fails
`yg check` with a clear `config-reviewer-unknown-key` / `config-tier-unknown-key`
error — a key typo is caught, a retired-field cleanup is not. Run from the
repository root only. Review the diff before committing.

---

## Auto-approve config

`auto_approve` controls what bare `yg check` does when you run it without explicit
`--approve`, `--no-approve`, or `--only-deterministic` flags.

| Value | Behavior |
| --- | --- |
| `false` (default) | Read-only: recomputes hashes, validates, reports. Writes nothing, makes no LLM calls, needs no keys. |
| `deterministic` | Behaves like `yg check --approve --only-deterministic` — fills only deterministic pairs (free, keyless), writes only the gitignored cache. |
| `full` | Behaves like `yg check --approve` — fills the unverified pairs that run answers for, LLM pairs included. |

**Precedence:** explicit CLI flags always override `auto_approve`. Passing
`--approve`, `--no-approve`, or `--only-deterministic` on the command line takes
effect regardless of what the config says.

**CI note:** CI and pre-commit scripts should always use explicit flags
(`yg check --approve --only-deterministic`) — the CI-is-free-and-keyless guarantee
is about explicit flag use, not `auto_approve`. Set `auto_approve` for local
developer convenience only.

When a fill triggered by `auto_approve` produces a PASS, the result line shows
`(auto-filled)` to indicate that verdicts were written during this run.

```yaml
# .yggdrasil/yg-config.yaml
auto_approve: deterministic   # fill the deterministic cache automatically on bare yg check
```

---

## Progressive mode

`progressive` names a branch your changes are measured against. It is absent by
default, and absent means off: every run answers for the whole project, exactly
as it always has.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `reference` | string (non-blank) | none | The branch or ref changes are measured against, e.g. `origin/main`. |

```yaml
# .yggdrasil/yg-config.yaml
progressive:
  reference: origin/main
```

With it set, a plain `yg check` blocks only on the obligations your change
reaches. Everything inherited from that branch is still listed and still counted,
as a warning that does not fail the build, and the header says how much of it
there is. `yg check --full` answers for the whole project instead.

Three things about the key itself:

- **It is read from the committed file only.** A `yg-secrets.yaml` overlay can
  neither introduce nor re-point it, so how much of the project a run answers for
  is the same for everyone on the branch.
- **The block must name `reference`, and nothing else.** A misspelled key, a blank
  value, or a block that names nothing at all (`progressive: {}`) is a hard
  `config-progressive-unknown-key` / `config-invalid` error rather than a silent
  no-op — the alternative would leave you reading a config that says the mode is
  on while every run behaved as if it were off.
- **Where the measurement cannot be made honestly** — the named branch is unknown
  locally, the clone is too shallow to share history with it, the graph does not
  sit at the repository root, a submodule pointer moved, or the verdict record
  committed at the reference cannot be read — the run answers for the whole
  project and says which of those it hit and what to do about it.

The full picture, including what decides whether a finding is yours and the two
CI legs this needs: [Progressive mode](/progressive-mode).

---

## Signals

`signals` is an optional section that turns attention-layer hints on or off. It
is absent by default, which leaves every signal at its default.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `attention` | boolean | `true` | The advisory "structurally unusual" note in `yg context --file`. Set `false` to silence it. |

```yaml
# .yggdrasil/yg-config.yaml
signals:
  attention: false   # silence the "structurally unusual" note in yg context --file
```

The note is purely advisory: it never blocks a check and never changes any
verification result whether it is on or off. `attention` must be a boolean, and
`signals` accepts no other key — a misspelled key is rejected so a typo can't
silently leave the note enabled. See [Structural attention](/feature-field) for
what the note means and its honest limits.

---

## Events

`events` is an optional section that controls where LLM verification events are
recorded. It is absent by default, which keeps every event in a local,
gitignored file (see [Verdict-events sidecar](/reviewers#verdict-events-sidecar)).

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `committed_llm` | boolean | `false` | Opt into a committed, team-shared record of LLM verification events. |

```yaml
# .yggdrasil/yg-config.yaml
events:
  committed_llm: true   # commit + share LLM verification events (default off)
```

When `committed_llm` is on, each LLM verification event is appended to a
committed file, `.yggdrasil/yg-events.llm.jsonl`, instead of the local sidecar —
a single home per event, so nothing is double-counted. The committed file is:

- **LLM-only.** Deterministic checks, drill runs, and diagnostic runs stay
  local, so a free, keyless CI run (`yg check --approve --only-deterministic`)
  adds nothing to it — zero churn.
- **Union-merged.** `yg init` marks it `merge=union` in `.gitattributes`, so
  events appended on different branches combine on merge instead of conflicting.
- **Rationale-stripped.** The refusal reason is omitted from the shared copy
  (it can carry code fragments); the local copy keeps it.

Turning the opt-in on or off never changes any verification result or its hash —
it invalidates nothing. `committed_llm` must be a boolean, and `events` accepts
no other key — a misspelled key is rejected so a typo can't silently leave the
shared record disabled. A machine on an older CLI writes only locally and does
not contribute to the shared file, so a reader that combines the two says as
much rather than treating the committed record as complete.

---

## Notes

- `yg-node.yaml` is a reserved filename in model directories.
- Node types are defined in `yg-architecture.yaml`, not `yg-config.yaml`.
