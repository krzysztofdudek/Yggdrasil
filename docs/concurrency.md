---
title: Running in parallel
---

Yggdrasil is safe to run many ways at once. There is one exception, and it only matters when several agents — or several terminals, or several teammates — work on the same repository at the same time. This page is the short rulebook.

## One approval at a time per repository

**Rule.** Run only one `yg check --approve` in a repository at a time. Let one finish (or stop it) before you start another.

**Why.** An approval writes its results and each component's history back to shared files as it runs — each finished result lands right away. Two approvals running side by side do not merge — as they progress they overwrite each other's results, the one that finishes last wins, and the work in between is lost. This is not a supported way to run, and nothing physically stops you today, so serializing is on you.

Parallelism *inside* a single run is fine and already handled for you: one approval fans out across many components at once and writes its results safely. The hazard is two separate `--approve` runs overlapping — not one busy run.

## What is always safe to run concurrently

**Rule.** Read-only commands never conflict — run as many as you like, at the same time, including while an approval is in progress.

**Why.** They never write results. This covers plain `yg check` (without `--approve`), `yg structure`, `yg aspects`, and `yg log read`. One caveat: if the project has turned on auto-approval (the `auto_approve` setting in its config), a plain `yg check` performs an approval on its own — and therefore writes — so on such a repo it counts as an approval for the rule above, not a read-only command.

The local activity record is safe too: Yggdrasil keeps a small, git-ignored note of what each run checked (surfaced by `yg log read --with-verdicts`). Every entry is a single atomic append, so two runs writing to it at the same moment never corrupt it — no coordination needed.

## When two agent sessions share one checkout

**Rule.** Serialize any session that changes files in the working tree; run read-only sessions freely in parallel.

**Why.** A few files are natural collision points — two sessions editing one of them at once clobber each other the same way any two writers to a single file would:

- the **Unreleased** section of `CHANGELOG.md`
- the generated agent-rules file, whenever it is regenerated
- the graph files under `.yggdrasil/`
- the recorded results, written by `yg check --approve`

In practice: let one tree-touching session land before you start the next, and keep any parallel work read-only.

## When another tool changes a file mid-check

**Rule.** If a background tool rewrites a tracked file while a check is running, that single run can disagree with itself — flag a problem that a plain re-run then clears. Re-run once and it settles.

**Why.** A check reads each tracked file, decides, and then reports. If something else rewrites one of those files in the moment between the read and the report — a package manager pinning a version field, a formatter, a code generator — the run sees two different versions of the same file and flags the mismatch. Nothing is wrong with your code and nothing is lost: the next run reads a single, settled version and passes. This only surfaces on a repo with auto-approval turned on, because that is the run that both checks and reports in one pass. When Yggdrasil notices this exact self-disagreement it records a small, git-ignored note so you can confirm that is what happened rather than chasing a phantom failure — and the fix is simply to let the background tool finish, then re-run.

## No lock file (yet)

Yggdrasil does not drop a lock file to physically block a second `--approve` from starting. That is deliberate. The guidance on this page is the mechanism for now; a real interlock ships only if and when an overlap is actually observed in practice. We do not add machinery ahead of a demonstrated need.
