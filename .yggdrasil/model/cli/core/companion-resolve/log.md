## [2026-06-19T19:18:53.046Z]
Provide one shared home for turning a resolver hook's returned paths into prompt-ready companion files: normalise paths to the repo root, drop any path that is already the subject, enforce the reachable-reads boundary, and read the bytes. The review fill and the aspect diagnostic share this single implementation so a path that resolves in the preview resolves identically when the review actually runs; divergence would make the preview lie.
## [2026-06-21T13:05:51.521Z]
Now hosts the shared per-pair companion resolver so both the approve path and the read-only size gate resolve companions the same way — one hook run with the inconsistent-observation retry guard followed by descriptor resolution. It still never calls a reviewer and never mutates the lock.
## [2026-07-28T19:46:04.024Z]
The paired-file resolver's inputs now admit a review subject with no owning component, so its type-checking no longer assumes every subject belongs to one.
## [2026-07-30T09:19:30.416Z]
The companion-hook call now passes an explicit unit descriptor instead of a bare node path, matching the runner boundary it calls into. A pair with no owning component still resolves through an empty node path and fails closed exactly as before — companion resolution for such a pair is a separate, not-yet-built design, and this change deliberately preserves its current behavior rather than extending it.
