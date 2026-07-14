## [2026-07-13T15:31:42.972Z]
Introduce a read-only replay command that answers "if I had shipped this
deterministic rule, what would it have caught across the history I can honestly
reach?" It replays a candidate check over recent commits and reports, per commit,
one of three first-class outcomes — clean, refused (with a count), or not
comparable — and never gates a build.

Several choices are deliberate and safety-driven, recorded here so a future change
does not quietly undo them:

- Clone-in-temp, never in-place. Every checkout and the candidate overlay happen in
  a throwaway clone under the OS temp directory, so the real working tree is left
  byte-for-byte unchanged. The overlay writes only the candidate rule, never any
  other graph file, and can never target the real project.

- Clone-boundary guard (the security crux). The graph-root resolver walks UP the
  directory tree. A checked-out commit that predates project initialization has no
  graph directory of its own in the clone, so a naive resolve would climb OUT of the
  clone and silently bind to the real project's graph — simulating against the wrong
  rules. The guard refuses to escape: if the clone has no graph directory of its own
  it returns "not comparable" without walking up at all, so the real project is never
  consulted; such a commit is reported as not comparable, never as a clean pass.

- One fresh subprocess per commit. Each commit is replayed in a new process because a
  reused process would pin the previous commit's rule module in the module cache and
  replay stale logic.

- Deterministic candidates only. An LLM- or companion-reviewed rule is refused up
  front: a language-model verdict is point-in-time testimony of a reviewer, not a
  value a rerun over history can reproduce, so it is not replayable.

- Honest horizon by schema equality. Replay reaches only commits whose committed
  graph schema equals the schema this graph is at now — the world the candidate would
  ship into. A commit whose graph would need a migration is reported as not
  comparable and never silently upgraded in the throwaway tree.

- Report tool, not a gate. It exits zero whatever it finds; only a precondition
  failure on the real project (no graph, missing candidate, wrong candidate kind, or
  an inability to make the isolated clone) exits non-zero. Every replay prints a
  survivorship-bias caveat, because the old gate already refused code that never
  landed, so the counts are bounds rather than ground truth.
## [2026-07-13T16:33:04.685Z]
Harden the replay against two ways it could misbehave.

First, path-traversal containment. The candidate id and the target node path are
untrusted inputs that end up in filesystem operations: the candidate is written
into the clone under a directory named after the candidate id, and that write
removes any existing directory there first. A value containing a parent-directory
component, an absolute path, or a drive-letter prefix could make that removal and
copy resolve OUTSIDE the isolated clone, onto the real project tree — a recursive,
forced removal of real files. Two defences now stand in the way: the candidate id
and node path are rejected up front, before anything is cloned or touched, unless
they are plain relative names with no parent-directory, absolute, or drive-letter
components; and immediately before the destructive removal-and-copy, the
destination is hard-asserted to resolve inside the clone, aborting rather than
proceeding if it ever escaped. The same containment assertion guards the read of
the candidate directory in the real project. The invariant this protects is the
reason the whole command clones in the first place: the real tree must be left
byte-for-byte unchanged.

Second, deterministic output from the per-commit subprocess. Each commit's outcome
is read from the child process's own verdict line, which is colorized. The child
inherits the parent environment, so a parent that forces color on would make that
line carry color escape codes the outcome reader cannot match, silently collapsing
every commit to "not comparable". The child is now run with color explicitly
turned off in its environment, so its verdict line is plain text regardless of how
the parent was invoked; the version-control subprocesses are likewise pinned to
plain output.
## [2026-07-14T00:54:17.364Z]
Hardened the isolated-clone containment against symlink escape. The deterministic-rule replay can be run inside an untrusted, downloaded repository to replay its own history; a checked-out commit can commit the graph directory itself (or the overlay destination beneath it) as a symlink whose real target sits OUTSIDE the throwaway clone. A purely name-based containment test (comparing resolved path strings) waves such a link through, because a stat follows the link and reports a directory that lexically appears to live inside the clone — while the destructive remove/copy that seeds the candidate rule would then act on the real target through the link, escaping the clone onto real files. The fix adds a filesystem-level containment layer: the clone boundary and the candidate graph-root / overlay destination are resolved through the filesystem (following symlinks) before the containment check, with a not-yet-created leaf handled by resolving the nearest existing ancestor and re-appending the remainder. An escaping link is now refused rather than followed — the graph-root resolution reports the commit as non-comparable, and the overlay operation is refused — so no filesystem operation ever touches a link target outside the clone. The layer degrades to refuse (never a crash) if a path cannot be resolved, preserving the tool as strictly read-only against the real tree. The earlier name-based rejection of traversing arguments is kept as the earliest-firing guard; this adds defense in depth for the symlink case it could not see.
