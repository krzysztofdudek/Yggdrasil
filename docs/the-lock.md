---
title: The lock
---

This is the depth page. Day to day you never touch the lock — your agent runs `yg check` and `yg check --approve`, and the lock takes care of itself. Read this when you want to know exactly how a verdict is stored, when it expires, and why CI can recheck your whole repo without an API key.

> **Note:** By default `yg check` writes no verdicts and never touches the lock, makes no LLM calls, and needs no keys. When `auto_approve` is set to `deterministic` or `full` in `yg-config.yaml`, bare `yg check` behaves like `yg check --approve --only-deterministic` or `yg check --approve` respectively. Explicit CLI flags always override the config. CI scripts use explicit flags and are unaffected by `auto_approve`.

The payoff is simple: every verdict is recorded so that CI doesn't re-run the reviewer — it recomputes a hash and confirms the recorded verdicts still match the current code. Fast, keyless, and it travels with the repo.

## The three lock files

On disk the lock is a **triad** of files under `.yggdrasil/`, partitioned by the *kind* of reviewer that produced each verdict:

- **`yg-lock.nondeterministic.json`** — **committed.** Holds the LLM-reviewer verdicts. These are expensive to recompute (they need a provider key and a reviewer call), so they travel with the repo. A repo with no LLM aspects has no LLM verdicts, so this file is **not written at all** (an empty husk is removed rather than committed).
- **`yg-lock.logs.json`** — **committed.** Holds the per-node log/closure baseline that the log gate checks against. A node's **source fingerprint** is recorded here only for `log_required` node types (the fingerprint is the gate's drift basis, so it would be dead weight anywhere else); any node that owns a `log.md` also gets its log-integrity baseline. When no node is `log_required` and none owns a `log.md`, there is nothing to record — and this file is **not written at all** (an empty husk is removed rather than committed).
- **`.yg-lock.deterministic.json`** — **gitignored local cache, never committed.** Holds the deterministic (`check.mjs`) verdicts. These are a pure performance cache: a deterministic check runs locally with no key and no LLM, so a fresh clone can recompute every one of them for free. Committing them only added bytes and merge noise without adding anything a checkout couldn't rebuild on demand. With no deterministic verdicts to cache, this file too is simply absent.

Every one of the three follows the same rule: **when a file's section is empty, the file is not written at all** (and an existing empty one is removed). An absent file reads back as empty state, so a repo only ever carries the lock files it actually needs.

The split is purely on disk, and purely by reviewer kind — there is no per-entry flag that decides which file an entry lands in. In memory the lock is a single object, `{ version, verdicts, nodes }`, exactly as before; loading reads the triad back into that one shape, and writing partitions it back out.

Because the deterministic verdicts live only in a gitignored cache, a fresh checkout starts with no deterministic cache. Plain `yg check` then reports those pairs as **unverified** until something rematerializes them — `yg check --approve --only-deterministic` (described below) rebuilds the cache for free, no key required.

Everything below names the machinery. The concept pages [/aspects](/aspects), [/nodes](/nodes), and [/relations-flows-ports](/relations-flows-ports) deliberately leave it out so you can start without it.

## Pairs and units

Verification runs per **pair**: one `(aspect, unit)`.

A **unit** is what a single verification covers. The aspect's `scope` sets it:

- `per: node` (the default) — the unit is the whole node. One verdict over all the node's mapped files.
- `per: file` — the unit is a single mapped file. One verdict each.

So a `per: node` aspect on a node with five files is one pair. The same aspect set to `per: file` over those five files is five pairs. Pairs are the unit of cost and caching: one lock entry per pair.

## What makes a verdict valid

Each entry stores the verdict and a hash of the inputs that produced it. The verdict is valid exactly while those inputs still hash to the stored value. Recompute the hash, compare — match means valid, mismatch means the pair is **unverified** again.

What the hash folds depends on the reviewer kind:

- **LLM pair (without companion)** — the rule text (`content.md`), the subject files, the aspect description, any reference files, and the **name** of the resolved reviewer tier. The tier's config (provider, model, endpoint, temperature, consensus) is not folded — only its name, so re-pointing a named tier at a different reviewer leaves verdicts valid.
- **LLM pair (with `companion.mjs`)** — all of the above, plus two additional ingredients folded only when present: `companionHash` (SHA-256 of `companion.mjs`, present whenever the aspect ships `companion.mjs`) and `touched` (the hook's observations — the companion files the runner read plus any `ctx.fs`/`ctx.graph` accesses — folded only when the set is non-empty). A plain LLM aspect passes neither, so its hash is byte-identical to before: there is no lock-format change, no schema-version bump, no migration.
- **Deterministic pair** — the rule (`check.mjs`), the subject files, and everything the check observed beyond those files: each file it read, each directory it listed, each existence probe (including the ones that came back `false`), and each piece of graph topology it looked at.

Change any folded input and the pair goes unverified. Edit a source file, edit the rule, point the aspect at a different named tier, move a file the check was watching — all of these. The next `yg check --approve` re-verifies them.

One thing is deliberately **not** an input: the aspect's status. Flipping `draft ↔ advisory ↔ enforced` changes how a verdict renders, never whether it's valid. A verdict survives every status flip, including a full `draft` round-trip. See [/aspect-status](/aspect-status).

## `yg check` vs `yg check --approve`

These are two different jobs.

`yg check` by default writes no verdicts and never touches the lock. It recomputes each pair's input hash and compares it against the lock. It runs no aspect reviewers, makes no LLM calls, and needs no provider keys — which is why it's the CI gate. (It does recompute relation conformance live; see below.) A mismatch means a pair changed without being re-verified, and check reports it.

However, when `auto_approve` is configured in `yg-config.yaml`, bare `yg check` may fill pairs automatically: `auto_approve: deterministic` behaves like `yg check --approve --only-deterministic`; `auto_approve: full` behaves like `yg check --approve`. CI scripts use explicit flags (`yg check --approve --only-deterministic`) and are unaffected by `auto_approve` — the CI-is-free-and-keyless guarantee holds.

`yg check --approve` is the only command that writes verdicts. It fills every unverified pair: deterministic checks first (they run locally, for free), then the LLM pairs. When a pair gets a real verdict — pass or refusal — the entry lands in the lock: the deterministic verdicts in the gitignored cache, the LLM verdicts in the committed `yg-lock.nondeterministic.json`. Then it reports, just like a plain check.

An aspect refusal never blocks other nodes' pairs. `--approve` records every result it gets and exits non-zero if any error remains. One exception: a node carrying an enforced deterministic refusal has its own LLM pairs skipped for that run, so a known-broken node never bills the reviewer — those pairs stay unverified until the refusal is cleared.

### `--only-deterministic` — fill the local cache, free and keyless

`yg check --approve --only-deterministic` fills **only** the deterministic pairs. It runs the `check.mjs` checks locally — no provider key, no LLM call, no cost — and writes **only** the gitignored `.yg-lock.deterministic.json` cache. The two committed files are left untouched. Then it reports.

This is the CI / pre-commit gate for the deterministic cache. A fresh checkout has no deterministic cache, so plain `yg check` reports those pairs as unverified; running `yg check --approve --only-deterministic` rematerializes the cache for free and clears them, without ever needing a key or touching a committed file. Use plain `yg check --approve` (no flag) when you also want the LLM pairs filled.

## Refusals are cached

A refusal is a verdict, and it's cached like any other. For unchanged inputs it's **final** — re-running `yg check --approve` over a refused pair does not re-run the reviewer. For a deterministic check a re-run would return the same violations; for an LLM check it would be a re-roll of a judgment that already came back negative. There is deliberately no force-rejudge command.

There are exactly three ways out of a refusal:

1. **Fix the code.** This changes a subject file, which invalidates the pair, which re-verifies it.
2. **Sharpen the rule.** Editing `content.md` changes the rule hash and re-verifies **every** pair of that aspect — possibly many nodes. Run `yg impact --aspect <id>` first to see the count. For aspects with `companion.mjs`, editing that file also re-verifies every pair (via `companionHash`); editing a resolved companion file re-verifies only the pairs that read it (via `touched`). `yg impact --file <companion-file>` shows the exact blast radius — even cold, before any lock `touched` exists, by running the resolver (no LLM call).
3. **`yg-suppress`, with your sign-off.** A documented file-level waiver for known debt. Markers in companion files are ignored — suppression is scoped to the subject source files only. See [/reviewers](/reviewers).

A cosmetic edit to the rule or the source — a reworded comment, a whitespace change — would also re-roll the verdict. Don't. That is exactly the laundering the missing force command refuses to offer.

## The relation check is not in the lock

Alongside the aspect reviewers, every `yg check` runs one built-in check that confirms every real code dependency is declared as a relation. It's deterministic, but unlike an aspect verdict it is **never stored in the lock** — there is no relation verdict, no hash, and no section for it.

Instead it is recomputed live on every run, plain `yg check` and `yg check --approve` alike: the pass parses each mapped source file, resolves every statically-resolvable cross-node dependency, and checks it against the node's declared relations, from scratch. Because nothing is cached, it can never go stale and never needs re-validation — the result is always the current truth of your code against the graph, at zero LLM cost.

That is also why a keyless CI `yg check` catches an undeclared dependency: it makes no LLM calls and reads no verdict for this check, yet it still parses and resolves live. For what it detects and how to clear a refusal, see [/relations-flows-ports](/relations-flows-ports).

## Merge conflicts

Only the two **committed** files can ever conflict — `yg-lock.nondeterministic.json` and `yg-lock.logs.json`. The deterministic cache is gitignored, so it never appears in a merge and never conflicts; it is simply rebuilt locally.

When two branches both wrote verdicts, git can leave conflict markers in one of the committed files. Do not hand-stitch the two sides. Pick one side of the conflicting file wholesale:

```bash
git checkout --ours -- .yggdrasil/yg-lock.nondeterministic.json    # or --theirs
yg check --approve
```

The same recovery applies per committed file: take one side of `yg-lock.logs.json` the same way if it also conflicted. Prefer the side that covers more of the merged code, to minimize re-verification. This is safe because the lock is self-validating: a verdict you kept by accident can't lie — its hash won't match the current inputs, so it re-verifies. The discarded side's verdicts are simply re-filled on that run.

Hand-merging entry by entry is the one thing to avoid. A stray conflict marker makes the whole file invalid, and Yggdrasil fails closed rather than trust a damaged lock. A duplicate key is worse in a quieter way — JSON parsing silently keeps only the last occurrence, with no error — which is exactly why you take one side wholesale instead of splicing entries by hand.

## Migrating an older single-file lock

Projects created before the split shipped a single committed `yg-lock.json`. `yg init --upgrade` migrates it in place: it splits that one file into the triad, relocating every verdict verbatim — the deterministic verdicts into the gitignored cache, the LLM verdicts and the log/closure baseline into the two committed files. Nothing is re-verified; every recorded verdict is carried over unchanged. The upgrade also adds the deterministic cache to `.yggdrasil/.gitignore` so it never gets committed.
