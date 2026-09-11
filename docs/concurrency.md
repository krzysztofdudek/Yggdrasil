---
title: Running in parallel
---

Yggdrasil is safe to run many ways at once. There is one exception, and it only matters when several agents — or several terminals, or several teammates — work on the same repository at the same time. This page is the short rulebook.

## One approval at a time per repository

**Rule.** Run only one `yg check --approve` in a repository at a time. Let one finish (or stop it) before you start another.

**Why.** An approval writes its results and each component's history back to shared files as it runs — each finished result lands right away. Two approvals running side by side do not merge — as they progress they overwrite each other's results, the one that finishes last wins, and the work in between is lost. This is not a supported way to run, and nothing physically stops you today, so serializing is on you.

Parallelism *inside* a single run is handled for you: one approval fans out and writes its results safely. The free deterministic checks run across your cores automatically; the reviewer (LLM) verifications run one at a time by default — raise `parallel` in `yg-config.yaml` to fan those out too. The hazard is two separate `--approve` runs overlapping — not one busy run, however it is tuned.

## What is always safe to run concurrently

**Rule.** Read-only commands never conflict — run as many as you like, at the same time, including while an approval is in progress.

**Why.** They never write results. This covers plain `yg check` (without `--approve`), `yg structure`, `yg aspects`, and `yg log read`. One caveat: if the project has turned on auto-approval (the `auto_approve` setting in its config), a plain `yg check` performs an approval on its own — and therefore writes — so on such a repo it counts as an approval for the rule above, not a read-only command.

The local activity record is safe too: Yggdrasil keeps a small note of what each run checked (surfaced by `yg log read --with-verdicts`). It is git-ignored by default; a repo that opts into a shared record (`events: { committed_llm: true }` in its config) instead appends its reviewer-verification events to a committed, union-merged file. Either way every entry is a single atomic append, so two runs writing to it at the same moment never corrupt it — no coordination needed.

## When two agent sessions share one checkout

**Rule.** Serialize any session that changes files in the working tree; run read-only sessions freely in parallel.

**Why.** A few files are natural collision points — two sessions editing one of them at once clobber each other the same way any two writers to a single file would:

- the **Unreleased** section of `CHANGELOG.md`
- the generated agent-rules files (`AGENTS.md`, `CLAUDE.md`, `.clinerules/yggdrasil.md`), whenever `yg init --upgrade` refreshes them
- the graph files under `.yggdrasil/`
- the recorded results, written by `yg check --approve`

In practice: let one tree-touching session land before you start the next, and keep any parallel work read-only.

## Reading the graph at another commit

**Rule.** `yg` reads the graph of the directory it runs in — always the current working directory, never a commit named on the command line. To ask about a different commit, create a detached worktree checked out at that commit and run `yg` with that worktree as its working directory:

```bash
git worktree add --detach ../at-that-commit <sha>
cd ../at-that-commit && yg check --json
```

**Why.** Two worktrees of the same repository share their commits, objects and refs — nothing else. Nothing under `.yggdrasil/` is shared: the verdict lock, the event log and the deterministic cache each live inside their own worktree's own copy. Running `yg check --approve --only-deterministic` inside the temporary worktree writes to that worktree's `.yggdrasil/` alone; the tree you started from keeps its own lock and history exactly as they were. This is also why there is no `--root` or `-C` flag for pointing a command at another commit: a worktree already gives every command the working directory it needs, the same way a tool that spawns `yg` as a child process sets its `cwd` today.

Measured on this repository's own graph — the largest available today, at 453 nodes, 1,432 mapped files and 5,439 rule-and-subject pairs (all three read from `yg check --json`, not hand-counted). Three runs of each command, median taken, one warm-up run discarded first; `yg context` targets `cli/core/fill`, the node with the most pairs in that same run.

| Command | Median time | Output size | Measured | CLI version |
|---|---|---|---|---|
| `yg aspects --json` | 250 ms | 88,298 bytes (88.3 KB) | 2026-09-10 | 5.9.0 |
| `yg context --node cli/core/fill --json` | 2,221 ms | 30,921 bytes (30.9 KB) | 2026-09-10 | 5.9.0 |
| `yg check --json` | 3,845 ms | 2,315,841 bytes (2.32 MB) | 2026-09-10 | 5.9.0 |

Re-measure before trusting these numbers on a graph much larger than this one.

## When another tool changes a file mid-check

**Rule.** If a background tool rewrites a tracked file while a check is running, that single run can disagree with itself — flag a problem that a plain re-run then clears. Re-run once and it settles.

**Why.** A check reads each tracked file, decides, and then reports. If something else rewrites one of those files in the moment between the read and the report — a package manager pinning a version field, a formatter, a code generator — the run sees two different versions of the same file and flags the mismatch. Nothing is wrong with your code and nothing is lost: the next run reads a single, settled version and passes. This surfaces on any run that both fills and then reports in one pass — `yg check --approve` (and `--approve --only-deterministic`) as well as a plain `yg check` on a repo with auto-approval turned on. When Yggdrasil notices this exact self-disagreement it records a small, git-ignored note so you can confirm that is what happened rather than chasing a phantom failure — and the fix is simply to let the background tool finish, then re-run.

## A read-only file does not stop a write

**Rule.** `chmod 444` on a file Yggdrasil writes protects nothing. To make a write actually fail, take write permission away from the **directory** the file sits in — `chmod 555 .yggdrasil`, not `chmod 444 .yggdrasil/yg-lock.logs.json`.

**Why.** Every file Yggdrasil writes goes out as a fresh file beside the target and is then renamed over it. That is exactly what lets a reader always see a complete old version or a complete new one and never a half-written file, and it is why an interrupted run cannot corrupt a lock. But a rename replaces a *directory entry*: the permission the kernel checks is write on the directory, and the mode of the file being replaced never comes into it. A file you froze at `444` is therefore replaced silently — no error, no warning, nothing in the output to tell you the freeze did not hold. Removing a file behaves the same way for the same reason, which matters here because Yggdrasil deletes a lock file whose section has gone empty rather than leaving an empty husk behind.

This covers, among others: the committed lock files `yg-lock.nondeterministic.json` and `yg-lock.logs.json` and the gitignored `.yg-lock.deterministic.json`; every node's `log.md`; the package record `yg-packages.yaml` and the rule files `yg pack add` copies under `.yggdrasil/aspects/packages/`; the gitignored local state (`.ast-cache/`, `.feature-field.json`, `.yg-packages-versions.json`); and the offline page `yg portal --static` writes. `yg-config.yaml` is a split case, and a good illustration of why the file mode is the wrong lever: `yg init` and the reviewer setup write it in place, so a `444` there does refuse them with a permissions error, while the `yg init --upgrade` migration rewrites it by rename, so the same `444` does not stop that. Neither half is a protection you can lean on.

**What guards the lock is its hashing, not a permission bit.** Each verdict is keyed to a hash of the inputs that produced it, so a verdict that no longer matches the code it answers for reads as `unverified` on the next `yg check`; a node's `log.md` is append-only and integrity-checked, so a rewritten history fails the check outright (see [/the-lock](/the-lock)). Both are committed files, so any change to them also arrives in a diff, where a person reviews it. The design is detection after the fact, not prevention at the filesystem — and if prevention is what you want, the directory permission above is the lever, because it stops every writer at once instead of one file at a time.

## No lock file (yet)

Yggdrasil does not drop a lock file to physically block a second `--approve` from starting. That is deliberate. The guidance on this page is the mechanism for now; a real interlock ships only if and when an overlap is actually observed in practice. We do not add machinery ahead of a demonstrated need.
