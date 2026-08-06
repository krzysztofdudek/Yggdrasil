## [2026-07-31T03:10:00.964Z]
New node: classifies a yg aspect-test --file target once the command layer has confirmed the path exists and has no owning component — coverage-exclusion, single-type architecture classification, the nodeless type-coverage lookup, and the nodeless architecture-reach computation the companion-diagnostic path also needs. Split out of aspect-test.ts so that command's own relation count reflects dispatching a resolved target, not also the classification machinery that produces one.
## [2026-07-31T12:04:34.563Z]
The --file addressing refusal only ever checked an adopter's coverage.excluded config, never the filesystem-derived nested-project boundary — a file inside a vendored checkout could still be accepted as a --file target. Both sources now gate this refusal through the one shared exclusion authority the rest of the enforcement surface uses.
## [2026-07-31T14:13:50.186Z]
A comment describing which command-layer check feeds this module's classification path still named the old, unguarded owner lookup after the command file it describes switched to the exclusion-aware wrapper around it. Reworded to name the wrapper it now actually calls, so the comment stays an accurate account of the division of responsibility between the two files.
## [2026-08-02T12:05:05.504Z]
Now calls computeTypeCoverageCached and classifySingleFileCached instead of their uncached counterparts, so yg aspect-test benefits from the persistent on-disk type-classification cache instead of paying full classification cost every invocation.
## [2026-08-03T00:22:37.075Z]
The local variable holding this file's own plain repo walk (used to classify a --file target's type coverage) was named gitFiles, asserting a git-tracked backing the walk never had. Renamed to repoFiles, matching the name this identical walk already carries at its other call sites across the CLI.
