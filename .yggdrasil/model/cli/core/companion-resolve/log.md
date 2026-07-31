## [2026-06-19T19:18:53.046Z]
Provide one shared home for turning a resolver hook's returned paths into prompt-ready companion files: normalise paths to the repo root, drop any path that is already the subject, enforce the reachable-reads boundary, and read the bytes. The review fill and the aspect diagnostic share this single implementation so a path that resolves in the preview resolves identically when the review actually runs; divergence would make the preview lie.
## [2026-06-21T13:05:51.521Z]
Now hosts the shared per-pair companion resolver so both the approve path and the read-only size gate resolve companions the same way — one hook run with the inconsistent-observation retry guard followed by descriptor resolution. It still never calls a reviewer and never mutates the lock.
## [2026-07-28T19:46:04.024Z]
The paired-file resolver's inputs now admit a review subject with no owning component, so its type-checking no longer assumes every subject belongs to one.
## [2026-07-30T09:19:30.416Z]
The companion-hook call now passes an explicit unit descriptor instead of a bare node path, matching the runner boundary it calls into. A pair with no owning component still resolves through an empty node path and fails closed exactly as before — companion resolution for such a pair is a separate, not-yet-built design, and this change deliberately preserves its current behavior rather than extending it.
## [2026-07-30T19:19:36.189Z]
Comment text referenced a planning label that only makes sense with access to material outside the repository, which conflicts with this project's own rule that a source comment must stand on its own. Reworded the affected comments to state what the code does and why in their own terms; no behavior changed.
## [2026-07-31T01:47:55.736Z]
A companion-backed LLM rule can now resolve its paired files for a subject that has no owning component, a file enforced by its architecture type alone: the allowance comes from what the architecture already permits that type to reach, computed once per type and shareable with the deterministic path's own cache, and the out-of-reach message never names a component that does not exist. A companion hook written for a component, one that touches the node or graph context, now fails with a clear message naming both exits instead of a generic node-not-found error.
## [2026-07-31T08:26:00.122Z]
Companion path resolution now rejects a path inside a separate project's own boundary before checking it against the allowed-reads set, closing a gap where a directory or glob mapping entry could textually cover a foreign project's files and let a companion hook put that project's source into a billed reviewer prompt.
## [2026-07-31T12:04:36.244Z]
Companion-path resolution rejected a path inside a nested project but had no awareness of an adopter's own coverage.excluded config, so a companion.mjs could still name, and have read into a billed prompt, a file that is otherwise fully excluded from the graph. The shared allowed-read guard now takes the graph's coverage config too, closing that gap at the one place all three read surfaces already share.
