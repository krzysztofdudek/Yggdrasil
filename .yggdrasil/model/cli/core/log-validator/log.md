## [2026-05-15T12:24:34.352Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:36:43.152Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.821Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.882Z]
R0.6: update log-parser import — log-integrity.ts now imports parseLog from ./parsing/log-parser (moved from io/). No logic change.
## [2026-09-23T20:24:59.493Z]
Append-only validation normalises line endings before offsets and the prefix hash are taken, matching how the baseline is written, so a CRLF checkout of an unchanged log validates.
