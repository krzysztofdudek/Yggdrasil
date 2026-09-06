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

A node's `description:` is not an input either — and it is not sent to the reviewer at all. It is documentation for people reading the graph, so editing one changes nothing that was judged and re-verifies nothing. (The *aspect's* description is a different matter: it is part of the rule, so it is both sent and folded.) The node's path is sent, and is folded.

That leaves the hash covering every ingredient a prompt is built from, which is what lets an LLM entry also record the **size** of the prompt that produced it. The size is not an input — it is a record of inputs the hash already covers — so a `yg check` on a still-valid verdict answers the prompt-size gate from that number instead of resolving companions and re-assembling the whole prompt just to count its characters. On a large project where nothing has changed, that reassembly was most of what a check spent its time on. A tier's `max_prompt_chars` is still read live, so lowering a ceiling still re-gates verdicts that are otherwise untouched.

Entries written by an older version carry no size and are measured the old way; the first `yg check --approve` after upgrading records what it measured, at no reviewer cost.

## `yg check` vs `yg check --approve`

These are two different jobs.

`yg check` by default writes no verdicts and never touches the lock. It recomputes each pair's input hash and compares it against the lock. It runs no aspect reviewers, makes no LLM calls, and needs no provider keys — which is why it's the CI gate. (It does recompute relation conformance live; see below.) A mismatch means a pair changed without being re-verified, and check reports it.

However, when `auto_approve` is configured in `yg-config.yaml`, bare `yg check` may fill pairs automatically: `auto_approve: deterministic` behaves like `yg check --approve --only-deterministic`; `auto_approve: full` behaves like `yg check --approve`. CI scripts use explicit flags (`yg check --approve --only-deterministic`) and are unaffected by `auto_approve` — the CI-is-free-and-keyless guarantee holds.

`yg check --approve` is the only command that writes verdicts. It fills every unverified pair it answers for: deterministic checks first (they run locally, for free), then the LLM pairs. On a project that measures changes against a branch, the local checks still cover everything and the reviewer is asked only about the rules your change is accountable for. When a pair gets a real verdict — pass or refusal — the entry lands in the lock: the deterministic verdicts in the gitignored cache, the LLM verdicts in the committed `yg-lock.nondeterministic.json`. Then it reports, just like a plain check.

An aspect refusal never blocks other nodes' pairs. `--approve` records every result it gets and exits non-zero if any error remains. One exception: a node carrying an enforced deterministic refusal has its own LLM pairs skipped for that run, so a known-broken node never bills the reviewer — those pairs stay unverified until the refusal is cleared.

### `--only-deterministic` — fill the local cache, free and keyless

`yg check --approve --only-deterministic` fills **only** the deterministic pairs. It runs the `check.mjs` checks locally — no provider key, no LLM call, no cost — and writes **only** the gitignored `.yg-lock.deterministic.json` cache. The two committed files are left untouched. Then it reports.

This is the CI / pre-commit gate for the deterministic cache. A fresh checkout has no deterministic cache, so plain `yg check` reports those pairs as unverified; running `yg check --approve --only-deterministic` rematerializes the cache for free and clears them, without ever needing a key or touching a committed file. Use plain `yg check --approve` (no flag) when you also want the LLM pairs filled.

One consequence of writing no committed file: this run never records positive closure either (see [The log gate](#the-log-gate) below), so it never ends a node's log cycle. On a project whose only recording run is this free gate, the newest entry a node has goes on satisfying the requirement for every later source change, and a second entry is never asked for. Where each round of work should carry its own written reason, a full `yg check --approve` has to run somewhere — on a developer's machine before the change lands, or on a pipeline leg that has a reviewer configured.

## Refusals are cached

A refusal is a verdict, and it's cached like any other. For unchanged inputs it's **final** — re-running `yg check --approve` over a refused pair does not re-run the reviewer. For a deterministic check a re-run would return the same violations; for an LLM check it would be a re-roll of a judgment that already came back negative. There is deliberately no force-rejudge command.

There are exactly three ways out of a refusal:

1. **Fix the code.** This changes a subject file, which invalidates the pair, which re-verifies it.
2. **Sharpen the rule.** Editing `content.md` changes the rule hash and re-verifies **every** pair of that aspect — possibly many nodes. Run `yg impact --aspect <id>` first to see the count. For aspects with `companion.mjs`, editing that file also re-verifies every pair (via `companionHash`); editing a resolved companion file re-verifies only the pairs that read it (via `touched`). `yg impact --file <companion-file>` shows the exact blast radius — even cold, before any lock `touched` exists, by running the resolver (no LLM call).
3. **`yg-suppress`, with your sign-off.** A documented file-level waiver for known debt. Markers in companion files are ignored — suppression is scoped to the subject source files only. See [/reviewers](/reviewers).

A cosmetic edit to the rule or the source — a reworded comment, a whitespace change — would also re-roll the verdict. Don't. That is exactly the laundering the missing force command refuses to offer.

## The log gate

The third lock file, `yg-lock.logs.json`, holds what the graph records ABOUT a component rather than a verdict on it: the log gate's baseline, and a port's contract baseline (below). A node type can opt in to the log gate with `log_required: true` (see [Nodes](/nodes#node-types-the-architecture-file)), and a node of such a type must carry a fresh entry in its `log.md` — written with `yg log add` — before its work is verified. The entry records **why** a change was made; what changed is already in the diff.

**When an entry is required.** Both of these have to hold: the node's type opts in, *and* the node's mapped source has changed since the node last reached positive closure (or this is its first verification and it owns source files). Notably it does **not** depend on the node's rules: a node that owns source but carries no rules at all still needs an entry when that source changes. A re-verification triggered by something other than the source — a rule was edited, the files untouched — needs no new entry.

**Positive closure** is the moment a `yg check --approve` run ends with every *enforced* pair on that node settled — approved, or, on a project that measures changes against a branch, deliberately left unbought because the change was not accountable for it. (Anything else that leaves a pair unverified — a refusal, a check that could not run — keeps the cycle open, and one log entry keeps covering it.) At that point the lock records two things for the node: a **source fingerprint** (one hash folded over its whole mapping) and the freshness baseline of its newest log entry. The fingerprint is what "the source changed" is measured against afterwards, which is why it is recorded only for `log_required` nodes — no rule and no verdict reads it. (The portal reads it for one display: a node whose recorded bytes have since been edited. On a node that closed with reviewer work deliberately left unbought, the fingerprint says the rules that run answered for saw these bytes, not that every rule did — the unbought ones stay unverified and are reported that way.)

Corollaries worth knowing:

- An advisory refusal does not prevent closure. A red *enforced* pair keeps the cycle open — and the same log entry stays valid through every retry, because the intent behind the change did not move, only the execution. Iterate on the code without adding entries.
- A node with no pairs, or only advisory ones, closes vacuously — but still only once its log requirement is satisfied.
- Closure is recorded only by a run that writes the committed verdict files. `yg check --approve --only-deterministic` records no verdict there, so it never closes a cycle at all: a project that records nothing else keeps the node's newest entry answering for every later change to it, as described under that flag above. (It *can* write one thing into this file — a port's contract baseline, below — which is a record about the component, not a closure of its cycle.)

**The gate is read-only, and it is all-or-nothing.** A missing entry is a blocking `log-entry-missing` error on a plain `yg check`, computed live from the fingerprint at zero cost — not merely something `--approve` refuses. So CI catches an unlogged source change even on a node that produces no pairs to fill. And at `--approve`, if *any* `log_required` node is missing its entry, the run fills **nothing at all** — no pair on any node, related or not. Add the missing entries and re-run.

**Correcting an entry.** Entries are append-only and integrity-checked; editing history breaks the check. To retract a decision, append a new entry whose body opens with `### Supersedes: <the prior entry's timestamp>`. Two narrow exceptions operate through git rather than by hand-editing: a typo in an entry the node has **not** yet closed over can be dropped with `git checkout` on that one `log.md` and re-added (the baseline has not recorded it yet), and reverting a change you regret means reverting the source *and* the log together, then logging the revert — never adding a "correction" entry that leaves the wrong code in place.

**After a merge.** If both branches appended entries to the same node, run `yg log merge-resolve --node <path>` from the merge commit. It validates that the shared history is byte-identical on both sides and that the result is the union of both sets of new entries, then records the node's baseline — it reads your merge resolution, it never rewrites it. Never concatenate two log histories by hand. When a committed lock file conflicted *as well*, the order is: take one side of the lock file, then `merge-resolve` each conflicted log, then `yg check --approve`.

`yg log add` never verifies anything and never invalidates a verdict, so entries can be appended freely between code changes.

## A verdict somebody else made

A verdict does not have to come from the configured reviewer. When a judge outside the CLI decides a prose rule (see [Reviewers](/reviewers#a-judge-outside-the-cli)), the entry that lands here is the ordinary one — the same content hash, the same shape — with the judge's name recorded beside it.

The name is provenance, not an input: it is deliberately outside the hash, so the verdict is bound to exactly what a provider's would have been bound to. That is what lets CI stand it back up by hashing alone, with no key and no judge present, and what makes it fall out of force the moment the code it judged changes. `yg check` names the judge in its report, because an approval reports nothing on its own and a green run should never carry a judgement with no visible author.

## Port contract baselines

A port can name the test that *is* its contract, together with the version consumers pin to (see [Ports](/relations-flows-ports)). `yg-lock.logs.json` is where that contract is pinned down: for each such port it records, per contract version, what the named test contained when that version was first recorded.

```jsonc
"nodes": {
  "payments/service": {
    "ports": { "charge": { "1": { "hash": "<sha256>", "test": "tests/contracts/charge.test.ts" } } }
  }
}
```

Three properties are the whole mechanism:

- **An approving run writes it, including the free one.** `yg check --approve --only-deterministic` records a baseline for a port that has none at its current version. That is deliberate: the check the baseline feeds costs nothing and needs no key, so a project whose only approving runs are the free ones must still be able to record — otherwise it would stay red forever on a contract it was never allowed to pin.
- **It is committed, not cached.** A baseline a fresh clone rebuilds from whatever it happens to find is not a baseline. This is why it lives here rather than in the gitignored deterministic cache.
- **A record is never overwritten.** Raising `version:` records afresh *alongside* the old one. So going back to a version you used before goes back to the contract it named, instead of quietly re-pinning it to whatever the file says now.

With the baseline in place, a change to the test file at an unchanged version is a blocking `port-contract-changed` error naming the port, the file and the version, with both exits: raise the version (and say why with `yg log add`), or restore the file. A port whose `test:` path does not resolve is `port-test-missing` — nothing is baselined and nothing is compared, because a green over an unreadable contract would be worse than a red.

## The relation check is not in the lock

Alongside the aspect reviewers, every `yg check` runs one built-in check that confirms every real code dependency is declared as a relation. It's deterministic, but unlike an aspect verdict it is **never stored in the lock** — there is no relation verdict, no hash, and no section for it.

Instead it is recomputed live on every run, plain `yg check` and `yg check --approve` alike: the pass parses each mapped source file, resolves every statically-resolvable cross-node dependency, and checks it against the node's declared relations, from scratch. Because nothing is cached, it can never go stale and never needs re-validation — the result is always the current truth of your code against the graph, at zero LLM cost.

That is also why a keyless CI `yg check` catches an undeclared dependency: it makes no LLM calls and reads no verdict for this check, yet it still parses and resolves live. For what it detects and how to clear a refusal, see [/relations-flows-ports](/relations-flows-ports).

## Garbage-collection

At the end of a successful `yg check --approve` run, the lock is rewritten canonically: verdict entries whose pair no longer exists — the aspect was detached or deleted, the file was deleted or unmapped, a `scope`/filter change moved it out, or its `when` now evaluates false — are pruned, and any `nodes` entry for a node path that no longer exists is pruned too. Status plays no part in this: a `draft` pair keeps its entry exactly like an enforced one, which is what makes parking an aspect with `status: draft` and later un-parking it free — nothing to re-verify, because nothing was ever thrown away.

An entry is pruned only when the run can *positively* prove its pair is gone. Anything the run could not settle either way is retained instead — a node whose own rule set could not be computed this run (an `implies` cycle, reported separately), a file whose subject content was unreadable this run, and a file the type-level classifier could not decide a type for this run (reported as ambiguous). Each of those keeps its stored verdict untouched rather than losing it to an inconclusive run.

`--approve` and `--dry-run` (a preview computed over a disposable copy — it writes nothing) both print a one-line summary whenever anything is actually pruned, split into billed (LLM) vs. free (deterministic) counts with the reason per entry; nothing prints when nothing was pruned. Under `--only-deterministic` the rewrite is scoped to the gitignored cache, so a keyless CI run never rewrites — or prunes — the two committed files.

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
