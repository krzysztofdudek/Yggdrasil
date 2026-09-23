---
title: Running in parallel
---

Yggdrasil is safe to run many ways at once. There is one exception, and it only matters when several agents — or several terminals, or several teammates — work on the same repository at the same time. This page is the short rulebook.

## One approval at a time per repository

**Rule.** One `yg check --approve` runs in a repository at a time, and Yggdrasil enforces it: a second one started while the first is still running stops at once with `Another approval is already running in this repository`, naming the process that holds it, and writes nothing. Let the first finish (or stop it), then run the second.

**Why.** An approval reads the recorded results once, then writes its own copy of them back as it fills. Two approvals running side by side would each overwrite the other's copy, the one that finished last would win, and the verdicts of the other would be lost — paid reviewer verdicts included. So for the whole run, from that first read to its last write, an approval holds a lock file, `.yggdrasil/.yg-approve.lock`, which records the holder's process id, machine and start time; the operating system lets only one process create it. The portal's Approve button obeys the same lock: while an approval is running — started from the portal or from a terminal — it answers `409` instead of starting a second one. The lock is released when the run ends, including on Ctrl+C. A lock left by a run that crashed does not block you: when its process no longer exists on this machine, the next approval replaces it. The one case Yggdrasil cannot check is a holder on another machine sharing the directory; such a lock counts as abandoned after 12 hours, or you delete the file once you know that run is gone. A plain `yg check` on a repo with auto-approval turned on takes the same lock, because it approves too. A cost preview (`--dry-run`) writes nothing and takes no lock.

**What an interruption costs.** Results are written as the run goes, in small batches rather than by rewriting the whole record after every single result (which made a large first fill spend most of its disk traffic rewriting the same file). Each paid reviewer verdict is written before its slot takes the next pair; free deterministic results are written at least every 256 results and at least once a second. Stopping a run with Ctrl+C (or `kill`) writes everything decided so far before the process exits. A hard kill that nothing can intercept (`kill -9`, a machine losing power) loses at most the free results of the batch being written and the one being gathered — at most two batches of 256 deterministic results plus the few in progress at that instant, all re-computed for free by the next run — and the reviewer verdicts whose write was in flight at that instant. What was written is always a complete, readable file.

Parallelism *inside* a single run is handled for you: one approval fans out and writes its results safely. The free deterministic checks run across your cores automatically; the reviewer (LLM) verifications run one at a time by default — raise `parallel` in `yg-config.yaml` to fan those out too. The hazard is two separate `--approve` runs overlapping — not one busy run, however it is tuned.

## What is always safe to run concurrently

**Rule.** Read-only commands never conflict — run as many as you like, at the same time, including while an approval is in progress.

**Why.** They never write results. This covers plain `yg check` (without `--approve`), `yg structure`, `yg aspects`, and `yg log read`. One caveat: if the project has turned on auto-approval (the `auto_approve` setting in its config), a plain `yg check` performs an approval on its own — and therefore writes — so on such a repo it counts as an approval for the rule above, not a read-only command.

The local activity record is safe too: Yggdrasil keeps a record of what each run checked (surfaced by `yg log read --with-verdicts`), one line per checked pair. It is git-ignored, and once it reaches 5 MiB it is moved aside to `.yg-events.jsonl.1` (replacing the previous one) and a fresh file is started, so it stays at about 10 MiB however long the checkout lives; the reader reads both. A repo that opts into a shared record (`events: { committed_llm: true }` in its config) instead appends its reviewer-verification events to a committed, union-merged file, `yg-events.llm.jsonl`. That file is not rotated — moving a committed file aside would itself be a commit — so it grows by one line per reviewer verdict for as long as the option is on. Either way every entry is a single append, so two runs writing to it at the same moment never corrupt it — no coordination needed.

## Two log entries at once

**Rule.** Adding log entries concurrently is safe — `yg log add`, `yg aspects log add`, and a run that records a rule's changed standing all take turns.

**Why.** An entry is added by reading the log, appending to it and replacing the file, and two writers doing that at the same moment would each replace the file with only their own entry added — the second silently dropping the first while both reported success. So every log write holds a short-lived lock file, `.yggdrasil/.yg-log.lock`, for the few milliseconds it takes. A writer that finds it held waits its turn; one still waiting after 10 seconds gives up with an error saying nothing was written, never writing unguarded. Like the approval lock, it is git-ignored (`.yg-*.lock`) and one left by a crashed process is replaced.

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

**Why.** The files that hold Yggdrasil's state — the ones listed below — are written as a fresh file beside the target, which is then renamed over it. That is exactly what lets a reader always see a complete old version or a complete new one and never a half-written file, and it is why an interrupted run cannot corrupt a lock. But a rename replaces a *directory entry*: the permission the kernel checks is write on the directory, and the mode of the file being replaced never comes into it. A file you froze at `444` is therefore replaced silently — no error, no warning, nothing in the output to tell you the freeze did not hold. Removing a file behaves the same way for the same reason, which matters here because Yggdrasil deletes a lock file whose section has gone empty rather than leaving an empty husk behind.

This covers, among others: the committed lock files `yg-lock.nondeterministic.json` and `yg-lock.logs.json` and the gitignored `.yg-lock.deterministic.json`; every node's `log.md`; the package record `yg-packages.yaml` and the rule files `yg pack add` copies under `.yggdrasil/aspects/packages/`; the gitignored local state (`.ast-cache/`, `.feature-field.json`, `.yg-packages-versions.json`); and the offline page `yg portal --static` writes. `yg-config.yaml` is a split case, and a good illustration of why the file mode is the wrong lever: `yg init` and the reviewer setup write it in place, so a `444` there does refuse them with a permissions error, while the `yg init --upgrade` migration rewrites it by rename, so the same `444` does not stop that. Neither half is a protection you can lean on.

The files Yggdrasil only ever **appends** to are the exception: those are written in place, so a `444` on one of them does refuse the write. They are the local activity record `.yg-events.jsonl` (moved aside to `.yg-events.jsonl.1` by rename when it rotates) and the committed `yg-events.llm.jsonl`; the local rule-drill results `.drill-results.jsonl`; the committed records `incidents.md`, `advise-decisions.jsonl` and `advise-imported.jsonl`; the opt-in `.debug.log`; and `.yggdrasil/.gitignore`, to which a command adds the one line it needs if it is missing. An append never leaves a half-written file either — each entry is one write — but the directory-permission reasoning above does not apply to them.

**What guards the lock is its hashing, not a permission bit.** Each verdict is keyed to a hash of the inputs that produced it, so a verdict that no longer matches the code it answers for reads as `unverified` on the next `yg check`; a node's `log.md` is append-only and integrity-checked, so a rewritten history fails the check outright (see [/the-lock](/the-lock)). Both are committed files, so any change to them also arrives in a diff, where a person reviews it. The design is detection after the fact, not prevention at the filesystem — and if prevention is what you want, the directory permission above is the lever, because it stops every writer at once instead of one file at a time.
