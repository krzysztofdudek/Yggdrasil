---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file. `yg init --platform <name>` (with no `--provider`)
writes it with no `reviewer:` section at all — a keyless, script-only start.
A reviewer is configured separately, interactively or via `--provider [--model]
[--endpoint]`, whenever the graph gains its first judgment (LLM) rule.
`yg init --upgrade` lifts the graph's config version to the current one and
refreshes the rules and platform files.

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

Node types are defined in the separate **architecture file** (`.yggdrasil/yg-architecture.yaml`),
not in `yg-config.yaml`.

---

## Full annotated example

```yaml
version: "5.1.0"

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
| `config.model` | yes | Provider-specific model identifier |
| `config.temperature` | no | Sampling temperature. Defaults to `0`. |
| `config.endpoint` | required for `openai-compatible` (ollama defaults to `http://localhost:11434`) | API endpoint URL |
| `config.timeout` | no | Per-call timeout in seconds. Defaults to `300`. Applies to CLI providers only (non-CLI/API providers ignore it). |

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

Controls which git-tracked files must be mapped to a node in `yg check`.

- **`required`** — List of roots. Files under a required root that are not mapped to any node produce an `unmapped-files` error (blocks CI). Default: `["/"]` (the whole repo — reproduces the previous always-map-everything behavior). An explicit empty list `[]` means **require nothing** — every uncovered file (outside `excluded`/nested) becomes a non-blocking `uncovered-advisory` warning and nothing blocks (pure-advisory adoption: you still see the full uncovered surface, but CI stays green on coverage). The empty list only takes effect when written explicitly; omitting the whole `coverage` block keeps the `["/"]` default. `yg init` writes an explicit `required: []` into a fresh `yg-config.yaml`, so newly-initialized projects start in require-nothing mode (green from the first check) — add roots as you bring areas under enforcement.
- **`excluded`** — List of roots. Files under an excluded root are silently ignored regardless of other rules.
- **Roots accept the same forms as a node `mapping:` entry** — an exact file, a directory prefix (e.g. `src/`), or a [minimatch](https://github.com/isaacs/minimatch) glob (`*` within a path segment, `**` across segments). So `excluded: ["**/*.generated.ts"]` ignores generated files anywhere, and `required: ["services/*/api/**"]` scopes the blocking tier to a pattern. `/` still means the whole repo.
- Files that match neither a required nor an excluded root produce a non-blocking `uncovered-advisory` warning.
- Subtrees that contain their own nested `.yggdrasil/` are auto-skipped by all repo-walking checks — they are governed by their own graph, not the root graph.

Each file is scored against all roots independently; the longest matching root (or pattern, by length) wins, and on an equal-length tie between a required and an excluded root, excluded wins.

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

## Upgrading

```bash
yg init --upgrade
```

Lifts the graph's config version to the current one and refreshes the rules,
schemas, and platform files. The legacy single-section reviewer format (flat
provider keys + `reviewer.active`) is migrated to `reviewer.tiers` automatically.
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
| `full` | Behaves like `yg check --approve` — fills every unverified pair including LLM pairs. |

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
