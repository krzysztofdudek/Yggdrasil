## [2026-05-15T10:17:15.781Z]
Fix posix-paths violation: normalize yggRoot (trim, backslash replace, trailing slash strip) at entry of each exported function
## [2026-05-15T13:32:17.143Z]
R0.9: remove direct node:fs imports — readFile and writeFile replaced with readTextFile and writeTextFile from io/graph-fs.ts. Engine types must not import node:fs directly per graph boundary conventions.
## [2026-05-27T07:22:23.741Z]
Phase 1 change: AspectDef.reviewer changed from optional string union to required AspectReviewerSpec object; migrator updated to handle v4-to-v5 config migration including new ReviewerConfig.tiers structure.
## [2026-05-31T16:03:34.240Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-07-15T04:26:23.555Z]
The migration rewrite of the project config now goes through the crash-safe atomic write path (temp file plus rename) instead of a direct overwrite, so an interrupt mid-migration can never leave a truncated or half-written config on disk — the same durability every other committed-state writer already has.
