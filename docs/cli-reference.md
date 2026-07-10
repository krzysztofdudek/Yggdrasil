---
title: CLI Reference
---

You do not need to run these commands in day-to-day use.
Your AI agent runs them automatically.

This page is for inspecting or debugging your graph and enforcement state.

---

## Core workflow (5)

| Command | Purpose |
|---------|---------|
| `yg context --file <path>` / `--node <path>` | Assemble context package |
| `yg impact --file <path>` / `--node <path>` / `--aspect <id>` / `--flow <name>` / `--type <id>` | Blast radius analysis |
| `yg check` | Unified gate — by default writes nothing, no LLM, no keys (see `auto_approve` in [Configuration](/configuration)) |
| `yg check --approve` | Verify every unverified pair and record the verdicts in the lock |
| `yg check --approve --only-deterministic` | Fill only the deterministic pairs, free and keyless; writes only the gitignored cache |
| `yg log add` / `read` / `merge-resolve` | Per-node append-only business log |

### `yg context`

Shows the exact context package your agent reads before working on a node. Output is
structured text with `read:` pointers to content files. Agents read files individually
using their file-reading tool.

```bash
yg context --node <node-path>
yg context --file <file-path>
```

- `--file <path>` — Resolves the owning node automatically, then assembles context. Prints
  owner mapping to stderr. If the file has no graph coverage but other files in the same
  directory are mapped, lists candidate nodes with file counts and a hint to use `--node`.
  Exits 1 if no coverage. Mutually exclusive with `--node`.

The node view also reports, per effective aspect, how many files form its subject
set (including `0 files — vacuous` when a `scope.files` filter excludes everything),
and a log-state line — whether a fresh log entry is required before `yg check
--approve` and whether one is present.

### `yg impact`

Predicts which pairs an edit to a node, aspect, flow, or type would invalidate —
the cost surface before you make the change. Deterministic pairs are free; LLM
pairs are counted as reviewer calls × consensus.

For `--node`, the output ends with a one-line cost summary that folds each LLM
pair's resolved-tier consensus into the reviewer-call count:

```text
  Editing this node re-verifies: 3 LLM pair(s) = 9 reviewer call(s) (consensus included); 2 deterministic = free; 4 currently-green verdict(s) re-rolled.
```

For `--file`, it ends with a precise `Total to re-verify:` block — billed
reviewer calls, free deterministic pairs, and currently-green verdicts re-rolled —
preceded by a per-node breakdown tagged with why each node is affected (own
pairs / references this file / companion observes this file / deterministic check
observes this file). To compute this precisely even before the first fill,
`yg impact` runs the companion resolver for cold companion-backed pairs — it
makes no LLM call, never runs `check.mjs`, and writes nothing. A companion whose
hook fails is listed under `Unresolved` (cost unknown; it will infra-fail at
fill). `--file` resolves the owning node, then reports a precise `Total to
re-verify` block for the edit (its own output, not the `--node` summary). Editing
a graph file under `.yggdrasil/` redirects you to `yg impact --aspect <id>`.

```bash
yg impact --node <path>
yg impact --file <path>
yg impact --aspect <id>
yg impact --flow <name>
yg impact --type <id>
```

- `--node` — Reverse dependencies, descendants, structural dependents of descendants, flows, aspects, and co-aspect nodes
- `--file` — Resolve owner, then report a precise `Total to re-verify` block for the edit (its own output, not the `--node` summary). Also reflects deterministic checks whose recorded observations touched this file (cross-node impact). Runs the companion resolver for cold companion-backed pairs (no LLM call). Editing a `.yggdrasil/` graph file redirects to `yg impact --aspect <id>`. A companion whose hook fails appears under `Unresolved`.
- `--aspect` — All nodes where this aspect is effective (own, hierarchy, flow, or implied), plus structural dependents of affected nodes — the pairs an edit to its rule, description, references, scope, tier, or `companion.mjs` would re-verify. Editing `companion.mjs` re-verifies every pair of the aspect (billed, not free); editing a resolved companion file re-verifies only the pairs that read it (also billed). `--file <companion-file>` reflects this fan-out via the lock's `touched` observations.
- `--flow` — All participants and their descendants, plus structural dependents of participants
- `--type <id>` — All nodes of that architecture type and their source files. Useful
  before adding a default aspect to a type — see how many nodes would be affected.

Exactly one of `--node`, `--file`, `--aspect`, `--flow`, or `--type` is required.

### `yg check`

Unified gate combining structural integrity, the prompt-size gate, lock
verification, coverage, and completeness. It **writes nothing** — it recomputes
each expected pair's input hash and compares it to the recorded verdict in the
lock (the committed `yg-lock.nondeterministic.json` and `yg-lock.logs.json`, plus
the gitignored `.yg-lock.deterministic.json` cache; see [The lock](/the-lock)). By default it
makes no LLM calls, runs no aspect reviewers, and needs no provider config or keys.
If `auto_approve` is set to `deterministic` or `full` in `yg-config.yaml`, bare
`yg check` behaves like `yg check --approve --only-deterministic` or `yg check
--approve` respectively — explicit CLI flags (`--approve`, `--no-approve`,
`--only-deterministic`) always take precedence over the config setting.
The one thing it always runs over your code is the built-in relation-conformance
check, live and parse-based, at zero LLM cost.

On a fresh checkout the gitignored deterministic cache is absent, so `yg check`
reports the deterministic pairs as unverified until `yg check --approve
--only-deterministic` rebuilds the cache for free.

```bash
yg check
yg check --approve
yg check --approve --only-deterministic
yg check --approve --dry-run
```

Outputs: header (project, counts, coverage), errors grouped by rule — each group
identifies the failing rule (`(code, aspectId)`) and lists the affected
nodes/files compactly; `--details` expands to the old per-pair view; warnings,
result (PASS/FAIL with group counts), and suggested next command. On color-capable
terminals, verdict and error/warning headers include emoji decoration (stripped
under `NO_COLOR` and in CI).

When at least one pair is verified, the header appends `N verified (D
deterministic, L LLM)` — splitting the green count into pairs machine-checked
locally for free versus pairs an LLM actually reviewed, so a clean run never
hides how much of it was reviewed by an LLM. On a fresh checkout with no local
deterministic cache the deterministic figure honestly reads 0 until `yg check
--approve --only-deterministic` rebuilds it — those pairs are genuinely
unverified, not a display glitch.

Exit code 0 if fully clean, 1 if any errors found.

#### `--top [N]`, `--summary`, `--details`, `--aspect <id>`, and `--quiet` — output control

The default output groups issues by rule. When a rule's fix is **node-specific**
(the `Next:` command names the node — e.g. a per-node log entry, or declaring a
dependency in one node's file), the group prints **each** affected node's own fix
beneath its line, instead of a single shared `Fix:` that would name only the first
node. Rules with a genuinely shared fix (reviewer refusals, unverified pairs)
still collapse to one `Fix:` line.

Several flags adjust the view; they are all **read-only** views of the plain read
and apply only to it. None combines with a fill flag — neither `--approve` nor
`--only-deterministic` (the fill path has its own `--dry-run` cost preview).
`--top`, `--summary`, `--details`, and `--aspect` are mutually exclusive with
each other.

```bash
yg check --top 5      # only the 5 highest-priority rule groups
yg check --top        # only the single suggested-next group (flag with no value)
yg check --summary    # per-node counts only — no per-issue blocks
yg check --details    # ungrouped per-pair view (old full output)
yg check --aspect <id>  # drill into one rule — all pairs for that aspect
yg check --approve --quiet  # suppress progress output during --approve (stderr)
```

`--top N` renders the N highest-priority **rule groups**, in the same priority
order the `Next:` line draws from. A bare `--top` (no value) renders exactly
one group — the suggested-next one, the one concrete thing to fix next.
`--summary` prints one line per node — `K unverified (J deterministic-free, L
LLM), M refused` — plus an `other` bucket for non-pair errors (coverage, log,
relation, structural) so the per-node totals reconcile with the header.
`--details` expands the output to the old per-pair view (useful when you need to
see every individual file in a group). `--aspect <id>` restricts output to pairs
of a single aspect, useful for drilling into one rule after seeing it in the
grouped view. An **unknown / mistyped** `--aspect` id is a guided error naming
the id (run `yg aspects` for the real list) rather than a misleading `0 of N`
view; when a valid aspect simply has no issues this run while other errors remain,
the drill-in still surfaces the global `Next:` so you are never left at a dead end.
`--quiet` / `-q` silences the `--approve` fill-progress on stderr, leaving only the
final report on stdout. With `--dry-run` the budget preview is the command's
deliverable, so `--dry-run` wins over `--quiet` — the budget still prints on
stdout; `--quiet` only suppresses the non-dry-run progress.

**Precedence:** explicit CLI flags (`--approve`, `--no-approve`,
`--only-deterministic`) override `auto_approve` in `yg-config.yaml`. The config
setting affects bare `yg check` only; CI scripts should always use explicit flags.

**Guardrail:** every view always prints the true aggregate `Errors (N)` /
`Warnings (N)` header and preserves the real exit code, so a narrowed view can
never read as a clean build. When a `--top` slice leaves a section (Errors or
Warnings) with a true count > 0 but no chosen groups, a parenthetical note is
printed beneath that subheader instead of leaving it dangling empty. An invalid
`--top` value — negative, fractional, non-numeric, or an explicit `0` — is a
guided error, never a silent full dump; for the single suggested-next group use
bare `--top`. Use `--summary` and `--top` to orient, then drill into a specific
rule group with `--aspect <id>` or the full view with plain `yg check`.

#### `--approve` — fill unverified pairs

`yg check --approve` runs every unverified pair, repo-wide (there is no scoping —
verification is all-or-nothing), then reports. Deterministic pairs run first,
locally, for free; a node with an enforced deterministic refusal has its LLM
pairs skipped this run. LLM pairs then go to the reviewer per tier and consensus.
Each real verdict — approved or refused — is recorded in the lock; infrastructure
failures (provider unreachable, no reviewer configured, a `check.mjs` that throws,
or a `companion.mjs` hook that fails to assemble a companion)
write nothing and leave the pair unverified. A refusal is cached and final for
unchanged inputs: re-running does not re-roll it.

`yg check --approve` prints a pre-dispatch header naming how many pairs and nodes
it will fill and how many are deterministic (free) vs. reviewer calls. For a full
preview before committing to the cost, use `--dry-run` (below); use `yg impact` to
predict cost before an edit, and `yg aspect-test --dry-run` to preview a single LLM
prompt.

#### `--dry-run` — free cost preview, no writes

`yg check --approve --dry-run` is a cost preview. It runs the same structural gate,
pair classification, and budget computation as a real fill, prints the pre-dispatch
header plus a per-node / per-aspect breakdown — each deterministic pair labelled
free, each LLM pair labelled with its consensus call count — then exits 0 **without
calling the reviewer, running any `check.mjs`, or writing a single byte to any lock
file**. The reviewer-call total is an **upper bound**: a node with an enforced
deterministic refusal has its LLM pairs skipped, and a fresh refusal or an
infrastructure failure can leave a pair unfilled, so the real `--approve` bills at
most that many calls.

The preview always exits 0, even when enforced pairs are unverified — it never
blocks the build. The only thing that aborts a preview is a broken configuration
(the structural gate), which surfaces the same blocker a real `--approve` would hit.
A cost estimate never demands a fresh log entry, so the preview also **bypasses the
per-node log gate** — it previews even on `log_required` nodes whose source changed
since their last closure, where the real `--approve` would require the log entry
first. `--dry-run` requires `--approve`; used on its own it is a usage error (plain
`yg check` is already a free, no-write read).

#### `--only-deterministic` — fill the deterministic cache only

`yg check --approve --only-deterministic` fills **only** the deterministic
(`check.mjs`) pairs. It runs them locally — no provider key, no LLM call, no cost —
and writes **only** the gitignored `.yg-lock.deterministic.json` cache; the two
committed lock files are left untouched. Then it reports, like any other check.

This is the CI / pre-commit gate for the deterministic cache. A fresh checkout has
no deterministic cache, so plain `yg check` reports those pairs as unverified;
running this command rematerializes the cache for free and clears them, without a
key and without touching a committed file. Use plain `yg check --approve` (no flag)
when you also want the LLM pairs filled.

#### Verification and aspect-status issue codes

The validator emits the following codes (see [Aspect Status](/aspect-status) for
status semantics):

| Code | Severity | Meaning |
|------|----------|---------|
| `unverified` | error (enforced) / warning (advisory) | Expected pair has no valid verdict — new, edited, tampered, or a fill that failed on infrastructure. Next: `yg check --approve`. |
| `aspect-violation-enforced` | error | Valid `refused` verdict on an enforced pair — blocks `yg check`. |
| `aspect-violation-advisory` | warning | Valid `refused` verdict on an advisory pair — does not block. |
| `prompt-too-large` | error | Assembled LLM prompt exceeds the resolved tier's `max_prompt_chars`. Takes precedence over `unverified`; `--approve` skips the pair. |
| `lock-invalid` | error | A lock file is unparseable, garbled, conflict-markered, or an unknown version — fail closed. |
| `relation-undeclared-dependency` | error (always) | Built-in relation-conformance check — a component depends on another component's code without a declared relation. Not an aspect: no status, not suppressible. Fix by declaring the relation in `yg-node.yaml` or removing the dependency. |
| `aspect-check-runtime-error` | error (`--approve` only) | A `check.mjs` failed to import or threw at fill time — fail closed, no verdict written. |
| `aspect-companion-runtime-error` | error (`--approve` only) | A `companion.mjs` failed to resolve/run at fill time (threw, returned a bad shape, resolved a missing or out-of-reach path, or observations stayed inconsistent) — fail closed, no verdict written; plain `yg check` shows the pair as unverified. |
| `aspect-companion-without-content` | error (structural) | An aspect ships `companion.mjs` without `content.md`. Companions are an add-on to LLM aspects; `companion.mjs` alone is invalid. |
| `aspect-companion-with-check` | error (structural) | An aspect ships both `companion.mjs` and `check.mjs`. Companions apply to LLM aspects only. |
| `log-entry-missing` | error (`--approve` only) | A `log_required` node changed source without a fresh log entry. |
| `aspect-status-invalid` | error | Declared `status:` is not one of `draft`, `advisory`, `enforced`. |
| `aspect-status-downgrade` | error | An attach site declares a status lower than the cascade would yield (bump up OK, downgrade is an error). |
| `implies-status-inherit-invalid` | error | `status_inherit:` is not `strictest` or `own-default`. |
| `aspect-effective-nowhere` | warning | A rule that ships a rule source and is not draft is effective on zero components after the full cascade and every `when` — a rule that looks enforced but is never verified anywhere. Silent while the model has no components. Fix by correcting the attach sites / `when`, or set `status: draft` until the component or type it targets exists. |

### `yg log`

Per-node append-only log of business decisions, constraints, and reasoning. Agents write
to this log before approving changes so that future agents have context about why code
is written the way it is.

```bash
yg log add --node <path> --reason "<text>"
yg log add --node <path> --reason-file <file>
yg log read --node <path> [--top N]
yg log read --node <path> --all
yg log read --node <path> --with-verdicts
yg log merge-resolve --node <path>
```

- `add` — Append an entry. `--reason "<text>"` for inline text; `--reason-file <path>` for
  multi-line content from a file. The entry gets a timestamp header automatically.
  Requires `--node`. When a node's type opts in with `log_required: true`, `yg check
  --approve` requires a fresh log entry before it records a verdict for a source change
  on that node.
- `read` — Print entries newest-first. Default: top 10. `--top N` shows N entries.
  `--all` shows the full history. `--top` and `--all` are mutually exclusive. Use this
  before editing a node to understand past decisions.
  - `--with-verdicts` — Interleave the node's own recent verification events with its
    log entries, newest first, under a `local telemetry since <timestamp>` header.
    The events come from a local, gitignored telemetry sidecar written during
    `yg check --approve`; only the node's own fill outcomes are shown (keyed by the
    node itself or by one of its mapped files). Unknown or malformed lines are
    tolerated and skipped. If the sidecar is unexpectedly committed (git-tracked),
    the header says so and drops the "local" label — a tracked sidecar is shared
    history, not local-only telemetry.
- `merge-resolve` — Reconcile `log.md` after a git merge. Must be run from a merge commit.
  Validates byte-exact ancestor portion and unions new entries from both branches.
  Never manually concatenate log files — integrity hashes will break.

---

## Navigation (5)

| Command | Purpose |
|---------|---------|
| `yg tree [--root <path>] [--depth <n>]` | Graph structure |
| `yg structure` | Read-only structural dashboard: tunnels, module groups, change reach |
| `yg find "<query>"` | Natural-language graph search |
| `yg aspects` | List aspects |
| `yg flows` | List flows |
| `yg owner --file <path>` | Quick ownership lookup |
| `yg suppressions` | Inventory of active `yg-suppress` markers |
| `yg type-suggest --file <path>` | Suggest architecture type for a file |

### `yg tree`

Prints all nodes with path, type, and description in a hierarchical tree.

```bash
yg tree [--root <path>] [--depth <n>]
```

- `--root <path>` — Show only subtree rooted at this path
- `--depth <n>` — Maximum depth

### `yg structure`

A read-only structural dashboard over the graph. It reports the shape of your
dependencies in three sections:

- **Tunnels** — the dependencies that reach farthest across the hierarchy, each
  named with how many levels of the tree it jumps and whether it crosses through
  a declared contract.
- **Modules** — at each level of the tree, how component groups depend on one
  another: how many groups, how many dependencies between them, and whether those
  dependencies all flow one way or some form a cycle.
- **Change reach** — from an average component, how much of the system is
  reachable by following dependencies.

```bash
yg structure
```

The edges it reports are the union of your declared structural relations (`calls`
/ `uses` / `extends` / `implements`) and the dependencies detected statically in
the source; event relations (`emits` / `listens`) are excluded. It is an
instrument, not a gate: it never reads or writes the lock, never calls a
reviewer, and always exits `0` as long as the graph loads — even when `yg check`
is red. It fails only when there is no graph to load.

### `yg find`

Natural-language search across nodes and aspects (flows are not indexed). Returns results
ranked by relevance. Each result shows the `score`, the `Kind` (node/aspect), and a short
`Description`. Node results also print a `Type:` line; aspect results print a `status:` line.
A `Matched:` line lists the query terms that matched (deduplicated and capped to the
first few, with a `(+N more)` suffix when the full set is longer).

```bash
yg find "order cancellation"
yg find "authentication middleware"
```

Use this when you know the feature you want to work on but not the node path.
The `score` is **relative to the best match in this query** — the top result is
always `1.00` and the rest are its fraction, not an absolute confidence. Read the
gap: a large drop from `1.00` to the next result signals a confident winner;
closely-clustered scores mean the query is ambiguous, so confirm the top
candidate with `yg context` before relying on it.

### `yg aspects`

Lists all defined aspects with metadata.

```bash
yg aspects
```

Output: a custom human-readable line format (not YAML). Each aspect renders as a header line
`<id> [<status>] — <description>` (the description falls back to the aspect name when no
description is set — there is no separate `name` field), followed by a `Reviewer:` line (for
`llm` reviewers it also shows the tier), a usage line `Used by: N nodes
(architecture/direct/implied/flow)` — or `Used by: 0 nodes — orphaned` when nothing references
it — and an `Implies:` line when the aspect implies others.

### `yg flows`

Lists all defined flows with metadata.

```bash
yg flows
```

Output: a custom human-readable line format (not YAML) with fields: `name`, `nodes`
(participants), `aspects`.

### `yg owner`

Finds which node owns a given file. Path is relative to repository root.
Quick ownership check — use `yg context --file` when you need the full context package.

```bash
yg owner --file <path>
```

### `yg type-suggest`

Suggests which architecture type(s) a file belongs to, based on `when` predicates
in `yg-architecture.yaml`. Useful when creating a new file and you're not sure which
node type to assign.

```bash
yg type-suggest --file src/orders/refund.service.ts
```

If the file does not exist yet, runs path-predicate checks only and shows which types
match the path pattern. If the file exists, runs the full `when` predicate (path +
content). If multiple types match, the architecture has overlapping `when` rules that
need disambiguating. If no type matches, shows the closest types by satisfied-fraction
to help you choose where to move or refactor the file.

---

## Knowledge base (1)

| Command                              | Purpose                        |
|--------------------------------------|--------------------------------|
| `yg knowledge list` / `read <name>` | Built-in deep-dive documentation |

### `yg knowledge`

Accesses built-in documentation on Yggdrasil mechanisms. The agent uses this
to answer detailed questions about how things work without reading source code.

```bash
yg knowledge list
yg knowledge read <name>
```

Available topics include: `working-with-architecture`, `aspects-overview`, `aspect-status`,
`writing-llm-aspects`, `writing-deterministic-aspects`,
`conditional-aspects`, `suppress-syntax`, `verification-and-lock`, `configuration`,
`cli-reference`, `log-management`, `ports-and-relations`, `flows`.

Run `yg knowledge list` to see the current list with one-line descriptions.

---

## Development (1)

| Command                                                          | Purpose                               |
|------------------------------------------------------------------|---------------------------------------|
| `yg aspect-test --aspect <id> --node <path>` / `--files <paths...>` | Run an aspect of either kind on demand; never writes the lock |

### `yg aspect-test`

Runs a single aspect — deterministic or LLM — against a node or an explicit file
list, and prints the result. It is a **diagnostic**: it always runs live and never
writes the lock, so use it freely while authoring a rule. Every run carries a
one-line verdict stamp `yg aspect-test: satisfied|refused|incomplete|dry-run` —
leading on deterministic runs, as a trailing summary after the per-unit verdict
lines on LLM runs (`incomplete` means some unit could not be verified — fail
closed, exit 1). Every run that produces a result ends with `diagnostic only —
lock unchanged; yg check judges the lock against your files, not this run`. On an
LLM run against a tier with `consensus` greater than 1, each per-unit line also
carries the vote split — `[votes 2/3]` — how many of the review passes were
satisfied, so a bare-majority verdict is visible as such rather than hidden
behind the aggregate.

Aspect status never gates `aspect-test`: a `draft` aspect runs here exactly like
an enforced one (drafts stay dormant only in `yg check` / `--approve`). Use
`--dry-run` for a zero-cost prompt preview while authoring; a run without
`--dry-run` makes a real reviewer call.

```bash
yg aspect-test --aspect <id> --node <node-path>
yg aspect-test --aspect <id> --files <path> [<path2> ...]
yg aspect-test --aspect <id> --node <node-path> --check-determinism
yg aspect-test --aspect <id> --node <node-path> --dry-run
yg aspect-test --aspect <id> --node <node-path> --repeat <N>
```

- `--aspect <id>` — Required. The aspect's kind is inferred from its rule source.
- `--node <path>` — Run against the files mapped to this node, with the node's allow-listed
  `ctx` (its own files plus, via declared relations, related nodes' files and metadata). The
  allow-list is a read *discipline* that scopes which files count as observations — not a
  security sandbox; `check.mjs` runs with full Node privileges.
- `--files <paths...>` — Run against an explicit file list (deterministic aspects). Useful
  for ad-hoc testing before wiring the aspect into the graph.
- `--check-determinism` — (deterministic) Runs the check twice and exits 1 if the violation
  sets differ (lexically sorted), catching side effects and machine-dependence in `check.mjs`.
- `--dry-run` — (LLM) Runs the companion hook live (if present), then prints the resolved companion
  paths and the assembled reviewer prompt(s) for the aspect's scope. Makes no LLM calls and does
  not touch the lock. The sanctioned way to inspect a prompt — including which companion files
  resolved — before switching an aspect to `per: file`. Not available for companion aspects with
  `--files` (an explicit file list provides no node context for the hook's allowed-reads boundary).
- `--repeat <N>` — (LLM only, N ≥ 2) Re-runs each unit N times against the identical prompt and
  prints a per-unit `stability: k/N satisfied` line — how often the reviewer returned the same
  verdict. Each run is forced to a single vote, so the figure measures the reviewer's raw
  self-consistency, **not** correctness: a rule can be consistently wrong, and `3/3 satisfied` says
  only that the reviewer agreed with itself. Use it while authoring to catch a prompt so ambiguous
  the reviewer flips its own verdict run to run. The total reviewer-call budget (`repeat N × units`)
  prints before the first call; provider-error runs are excluded from the ratio and reported
  separately; any single refused run marks the unit refused, and a unit whose runs all erred is
  stamped `incomplete`. Rejected with `--dry-run`, with `--files`, and for deterministic aspects
  (already exactly reproducible — use `--check-determinism` there).

For a deterministic aspect it runs `check.mjs` and prints violations. For an LLM
aspect it runs the reviewer (or just prints the prompt under `--dry-run`). Exits 0
when clean, 1 when violations or refusals are found — or when a unit could not be
verified at all (fail closed, stamped `incomplete`).

When `yg aspect-test` repeatedly approves what the lock has refused, the rule text
is ambiguous — sharpen `content.md` (which re-verifies every pair of the aspect; check
`yg impact --aspect` first) or propose a suppress. There is deliberately no command
to drop or re-roll a recorded verdict.

---

## Setup (1)

| Command | Purpose |
|---------|---------|
| `yg init` | Initialize or reconfigure |

```bash
yg init
```

With no flags in a terminal, an interactive wizard: on a new project it walks
you through platform selection and reviewer setup; on an existing project it
offers upgrade, reviewer reconfiguration, or platform change. Every flag
combination below also runs non-interactively (Docker, devcontainer, CI) —
flags are authoritative, so a fully-specified command never opens the wizard,
even from a terminal.

**Fresh repo (no `.yggdrasil/` yet):**

```bash
yg init --platform <name>                              # keyless bootstrap — no judge configured
yg init --platform <name> --provider <name> [--model <m>] [--endpoint <url>]   # bootstrap with a judge
```

`--platform <name>` alone scaffolds the graph and installs that platform's
rules file with no `reviewer:` section at all — script rules, dependency
control, and the CI gate work immediately at zero cost, no API key needed. Add
`--provider` (same command, or later against the now-existing repo) once the
graph gains its first judgment (LLM) rule. A non-interactive run naming no
`--platform` errors with guidance rather than guessing which agent platform to
install.

**Existing repo:**

```bash
yg init --provider <name> [--model <m>] [--endpoint <url>]   # configure/replace the judge
yg init --platform <name>                                    # switch the platform rules file
yg init --upgrade --platform <name>                          # refresh rules/platform files
```

`--provider` and `--platform` can be combined in one command; each applies its
own operation. With neither flag and a TTY, the interactive reconfiguration
menu opens; with neither flag and no TTY, the command reports there is
nothing to do rather than guessing.

**Defaults:** `--model` defaults to `sonnet` only for `claude-code`; every
other provider requires `--model` explicitly. `--endpoint` defaults to
`http://localhost:11434` for `ollama` only; `openai-compatible` has no default
and requires `--endpoint`. Credentials are never a flag — an API provider's
key is read only from its own environment variable
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`) at init time,
keeping keys out of shell history; a missing key is non-fatal and can be set
later before `yg check --approve`.

`yg init` also maintains a `.gitattributes` entry marking the committed lock files
as generated (`linguist-generated=true`), adds the gitignored deterministic cache
(`.yg-lock.deterministic.json`) to `.yggdrasil/.gitignore`, and writes
`max_prompt_chars: 50000` into the generated reviewer tier.

`--upgrade --platform <name>` lifts the config version to the current one and
refreshes rules and platform files — without prompts. Useful in scripts and CI.
On a project still using the older single-file `yg-lock.json`, `--upgrade` also
splits it into the triad in place — relocating every verdict verbatim, with no
re-verification — and gitignores the deterministic cache. See
[The lock](/the-lock) for the file layout.
