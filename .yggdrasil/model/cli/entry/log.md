## [2026-05-15T08:40:18.544Z]
Register registerTypeSuggestCommand in bin.ts entry point to expose yg type-suggest command.
## [2026-05-15T17:44:22.847Z]
Phase 2: reclassified from adapter to entry-point (maps source/cli/src/bin.ts).
## [2026-05-16T03:57:21.153Z]
Add unhandledRejection handler and try/catch around program.parse() — satisfies top-level-error-handler aspect: every unhandled error produces a structured message on stderr and a controlled exit code.
## [2026-05-29T08:26:02.108Z]
Added registration of the yg structure-test command (registerStructureTestCommand) in the main bin.ts dispatcher. This is the pattern used for all CLI commands — entry-point only imports and registers, no logic here.
## [2026-05-30T20:06:10.233Z]
The way a rule's verification is declared collapsed from three kinds — a human-language reviewer, a single-file programmable check, and a graph-aware programmable check — down to two: the human-language reviewer and one unified deterministic programmable check. The two programmable kinds were never a real choice, since the graph-aware kind is a superset of the single-file one; keeping both forced authors into a false up-front decision and made the tooling carry two parallel surfaces for one concept. Collapsing them removes that false choice. This change consolidates the remaining user-facing surface that still exposed the old split.

Specific to this node: the CLI entrypoint registers the one unified aspect-testing command in place of the two former commands.
## [2026-06-03T07:05:22.032Z]
Registered the new read-only suppressions inventory subcommand on the top-level CLI dispatcher so operators can list active waiver markers and get warned about unknown aspect ids, wildcards, and unbounded disable ranges.
## [2026-07-12T11:42:31.387Z]
Wires the new advise command family into the CLI so an operator can dismiss or defer an attention item from the command line. Registration only — the entry point continues to just assemble subcommands and owns none of the advise behavior itself.
