## [2026-05-13T05:48:00.416Z]
Distinguish WhenPredicateInvalidError when loading architecture.

Why: Plan Task 1.7. Graph.architectureError changed from bare string to ArchitectureLoadError (string | { code; message }) so downstream validators can emit a 'when-predicate-invalid' error code instead of folding the failure into generic architecture-invalid.

How to apply: graph-loader catches WhenPredicateInvalidError and returns structured form; falls back to bare-string for all other errors so legacy consumers keep working. Plan Task 1.7.
## [2026-05-15T09:13:17.213Z]
Add version gate: after findYggRoot, detect config version via detectVersion(yggRoot). If version > CLI_SUPPORTED_SCHEMA (4.4.0), throw with upgrade instruction. Gate runs before config parsing and is not affected by tolerateInvalidConfig. Uses semver.gt and semver.valid for comparison.
## [2026-05-15T12:24:34.251Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:36:43.047Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.205Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.776Z]
R0.6: update file-when-parser import — graph-loader.ts now imports WhenPredicateInvalidError from ./parsing/file-when-parser (moved from io/). No logic change.
## [2026-05-16T05:58:05.723Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T13:40:07.885Z]
Version gate: CLI_SUPPORTED_SCHEMA updated 4.4.0 → 4.3.0 — versions above 4.3.0 now trigger upgrade instruction. Part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
## [2026-05-16T13:49:38.797Z]
Fix what-why-next aspect violation: nodeParseErrors now stores IssueMessage (what/why/next) instead of raw message string; architectureError raw-string case now returns structured { code, messageData } object. ArchitectureLoadError type updated to remove bare string option. Graph model and validator.ts updated to match.
## [2026-05-27T07:55:35.923Z]
Updated loadAspects and scanAspectsDirectory to collect parse errors from parseAspect into a structured parseErrors array. The function now returns {aspects, parseErrors} instead of just AspectDef[]. loadGraph wires the errors into Graph.aspectParseErrors so validators downstream can surface them. This is phase 7 of the v5 reviewer-tiers feature: aspect YAML malformation is now surfaced instead of silently swallowed.
## [2026-05-27T09:08:38.920Z]
Updated graph-loader.ts to capture ConfigParseError from config-parser.ts as a structured error. The ConfigParseError now carries an IssueMessage and error code, enabling the validator to distinguish between legacy-format config errors and generic parse failures. This allows downstream validators to suppress dependent checks (e.g., aspect-tier-unknown) when the config is in the legacy v4 format.
## [2026-05-27T12:59:41.327Z]
Bumped CLI_SUPPORTED_SCHEMA from '4.3.0' to '5.0.0' so the CLI accepts v5-versioned yg-config.yaml files. Without this, loading the dogfood config after the version bump fails with 'newer than this CLI supports'.
## [2026-05-29T10:09:44.015Z]
Re-approving after drift state was wiped during concurrent development session. No source changes — this approval records the baseline verdicts for newly-active aspects (silent-missing-files, deterministic, no-direct-fs, no-direct-console, no-nondeterminism-direct, posix-paths-source, posix-paths-output) that were approved previously but lost when drift state was restored from git HEAD.
## [2026-05-29T10:10:06.257Z]
Re-approving all aspects because the what-why-next aspect content was updated (clarified that structured messageData field access in CLI renderers satisfies the rule, not just direct buildIssueMessage calls). The aspect content change triggered a cascade drift requiring full re-approval to establish verdicts for all active aspects.
## [2026-05-31T06:24:50.327Z]
Two agent-facing diagnostics were corrected. A multi-node cascade target list rendered with a doubled path separator; it now renders with a single separator. And a configuration whose schema version is newer than this CLI supports was being wrapped as an internal bug with a file-an-issue prompt; it is now classified as the expected user error it is — telling the user to upgrade the CLI — without the bug framing. Neither changes the underlying detection; both make the output read correctly.
## [2026-05-31T16:03:33.534Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-05-31T16:51:20.474Z]
Moved the pure when-predicate parsers (file-level and aspect-level, plus the shared boolean-clause helper they both use) out of the core layer and into the shared utilities layer. The file-reading parsers in the io layer need these helpers, but the layering rules forbid the io layer from depending on core/engine code; placing the helpers among the leaf utilities — which any layer may import — makes that dependency legal without weakening the rule. The helpers are pure: they transform already-parsed objects and do no file I/O, so they belong with the other shared utilities rather than with the engine. Importers and the relocated files internal paths were updated accordingly.
## [2026-05-31T21:11:07.259Z]
Added a fail-closed lower schema-version gate to graph-loader. When the on-disk graph version is OLDER than the CLI's supported version (5.0.0), the loader now throws OutdatedSchemaVersionError immediately, refusing to parse the stale format. This is the symmetric lower bound to the existing upper-bound refusal. The rationale: 5.0.0 is a single-format runtime — it reads only the current on-disk format, not legacy formats. Older formats must be migrated via `yg init --upgrade` before the CLI can read them. Without this gate, the loader would silently attempt to parse outdated YAML structures, producing incorrect or missing graph data. Failing closed (hard error + nonzero exit) rather than warning ensures that CI catches ungated graphs immediately and agents cannot accidentally operate on stale architecture data. The error is rendered as a clean what/why/next message via OutdatedSchemaVersionError (caught in preamble.ts) rather than a generic crash.
## [2026-05-31T21:39:26.141Z]
Renamed OutdatedSchemaVersionError field cliVersion to minSupportedVersion for naming parity with the sibling UnsupportedSchemaVersionError class (which uses maxSupportedVersion). The field holds a schema version bound — the minimum schema version this CLI reads — not the CLI release version, so the prior name was misleading. Constructor parameter renamed to match.
## [2026-06-19T05:55:05.928Z]
Stops scanning a project for schema files when assembling the in-memory graph. Schema references moved out of every project into the tool itself, so the loader no longer collects them and the graph model carries no schema list.
## [2026-06-19T09:19:57.804Z]
The graph schema version the loader accepts advanced one minor step. The committed graph format changed: the schemas directory is no longer part of it, because schema references moved out of every project into the tool itself. Advancing the accepted version is how an older project is told to run the upgrade, which removes the now-obsolete directory before the project is considered current.
## [2026-06-19T11:07:36.829Z]
The diagnostic shown when an architecture predicate is malformed now points the reader at the built-in schemas command for the allowed shape, instead of a per-project schema file path. Reason: that file no longer exists in a project; the field reference moved into the tool and is reached through a command.
## [2026-06-28T18:13:50.473Z]
Graph loading now threads a committed-only read preference down to the configuration parser. A new loader option, when set, instructs the config read to skip the local secrets overlay so the loaded configuration reflects only committed material. Default behavior is unchanged — absent the option, the loader reads configuration exactly as before, secrets overlay included. This exists so a read-only consumer can load the graph with a provable guarantee that no developer-local secret file was opened or merged during the load.
## [2026-07-03T10:55:59.713Z]
Distinguish a failed business-process flow definition from an uninitialized project.

When a flow definition fails to load on an already-initialized graph — its file
absent, a directory instead of a file, unreadable, or syntactically malformed —
the failure was previously indistinguishable from having no graph at all. The
operator was told to re-initialize the project, or the failure surfaced as an
internal defect to report. Both are misleading: the graph exists and the fault
is one specific flow definition.

A flow-load failure is now raised as its own typed condition that carries the
offending flow file's location, so the command layer can tell the operator
exactly which flow definition is at fault and that the remedy is to correct or
remove that one file — never to re-initialize. The genuinely-uninitialized case
(no graph directory at all) keeps its own separate "initialize the project
first" guidance; the two are deliberately kept apart so neither masks the other.
