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
## [2026-07-31T01:47:48.441Z]
Added a --file addressing mode, mutually exclusive with --node: it replays the candidate rule over a type-covered file's historical content at each commit, but classifies it against today's architecture and coverage settings, overlaid into the isolated clone alongside the candidate only after the existing schema-equality guard already holds, rather than whatever the historical commit happened to have. Otherwise a commit that predates the matching architecture type or the coverage flag itself could never be compared at all, even though the code at that commit is exactly what the replay exists to judge.
## [2026-09-23T19:15:15.035Z]
The report printed the survivorship caveat twice: a paraphrase and then the verbatim label saying the same thing. It is now one line that states the cause and ends with the verbatim label.
## [2026-09-23T20:49:37.365Z]
The schema version is now read through the one shared config reader instead of a private regex, so simulate, the loader and the migrator agree on what the field holds. The streamed report now exits through the flush-aware helper so a long report is not cut short on a pipe.
## [2026-09-23T23:00:38.503Z]
Command errors now go through the shared CLI output layer (fail, or failAndExit where the command exits at once) instead of each command writing its own red Error: what/why/next line to stderr, and the commands that kept a private failWith or emitError copy of that line now use the shared one. One place now owns how a command error reads and where it goes, so wording and stream change once for every command. When the invocation answers in JSON, that layer also writes a yg-error/1 document (code, what, why, next) to stdout, because a machine reader used to get zero bytes on stdout for a failed command and had to parse English from stderr.
## [2026-09-24T07:23:37.297Z]
The CLI now speaks one output grammar: every finding is a block headed error[label] or warning[label] with lowercase labelled at:, why: and fix: fields, every command error is error[code]: what with a labelled why and a next: step, and a report ends with one next: step and optionally a then: step. Scripts that parsed the old capitalised Why:, Fix: and Next: lines are sent to the JSON documents, which carry the same facts. This command's remaining capitalised Next: or Warning: lines are lowercase, its counts agree with their nouns, and its first-level text says reviewer rule where it said LLM aspect.
## [2026-09-24T13:51:06.996Z]
Every byte this command prints now goes through the output layer: stdout and stderr through writeOut and writeErr, colour through paint, instead of process.stdout.write, process.stderr.write and a chalk import of its own. The repository now refuses a direct stream write, a console call or a chalk import outside that layer, so that where output goes, what guards it and when it is decorated are decided in one place and cannot drift command by command again, as they had across hundreds of write sites before the layer existed.
## [2026-09-24T14:23:24.322Z]
The same idea went by several names across the docs, the agent manual and the CLI's own messages, so a reader could not tell whether two words meant one thing or two. The words this component prints now follow the Glossary, which defines each term once: the reviewer is only the model configured under reviewer:, a rule is a reviewer rule, a script rule or a bundle, the --approve run is a fill whose verdicts are passed or refused, a rule's draft/advisory/enforced is its status, covered only means the graph accounts for a file, tier only means a reviewer tier, and a file enforced by its type alone is a type-covered file. JSON fields, codes and config values are unchanged, so no machine consumer is affected.
## [2026-09-24T15:11:12.958Z]
Two release lines met here: one that routes every piece of CLI output through the shared output layer with count() for grammatical numbers, and one that gives each meaning a single word across the CLI text (reviewer rule, script rule, bundle, passed, look-alike group, type-covered file, status) with retired synonyms guarded against. Both are kept whole in this node: its messages use the glossary's words and still go through the output layer, so neither change undoes the other.
## [2026-09-25T13:16:53.824Z]
An unexpected failure of the replay now goes through the command contract shared unexpected-error path, and every step of the realpath walk records its failure in the debug log, so no fallback in this command is silent.
## [2026-09-25T21:13:51.302Z]
simulate now refuses a candidate id that names no rule with the shared aspect-not-found error. An unknown rule id used to be refused in about six different wordings under two codes depending on the command, so an agent could not recognise the one situation or learn one remedy.
## [2026-09-26T04:16:39.865Z]
The command description called simulate read-only. It writes nothing to the repository, but it runs the candidate rule's script once per replayed commit, with the permissions of whoever runs it. Calling that read-only let an agent or a CI author treat it as safe on an untrusted branch, so the description now says both halves: nothing written, code executed.
