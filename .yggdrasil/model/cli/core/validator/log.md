## [2026-05-15T06:43:15.644Z]
Restructure validate() pipeline: Stage 1 handles architectureError (architecture-invalid/when-predicate-invalid, returns early); Stage 2 schema-independent checks always run; Stage 3 architecture-level checks (type-unknown-parent implemented, cycles/enforce stubs) short-circuit per-node + global stages on fatal errors; Stages 4/5 stubs wired for future implementation.
## [2026-05-15T06:47:52.136Z]
Implement checkTypeWithoutWhenWithMapping: emits type-without-when-with-mapping error when a node's type has no when predicate (organizational type) but the node's mapping is non-empty.
## [2026-05-15T06:58:19.218Z]
Add checkArchitectureParentCycles: two-pass DFS+BFS cycle detection. Pass 1 (DFS three-color) identifies back-edges forming cycles. Pass 2 (BFS per type excluding back-edges) emits architecture-cycle only when no rootable type reachable, allowing self-loops with alternative parents (escape path exists). Runs only after checkTypeUnknownParent passes (skips if dangling parents exist). Spec §9.
## [2026-05-15T07:00:20.290Z]
Fix: wrap architectureError branches in buildIssueMessage (what-why-next aspect). Both when-predicate-invalid and architecture-invalid branches were passing raw strings directly as message. Now use structured format per aspect requirement.
## [2026-05-15T07:05:26.982Z]
Add checkEnforceStrictWithoutWhen: emits enforce-strict-without-when when type declares enforce: strict without a when predicate. enforce: strict without when is meaningless — no files to evaluate against. Spec §7 Klasa 5.
## [2026-05-15T07:15:16.618Z]
Add checkTypeWhenMismatch: per-node check evaluating each mapped file against the node type's when predicate. Emits type-when-mismatch with predicate trace on failure. Emits file-unreadable (not type-when-mismatch) for files that cannot be opened. Imports evaluateFileWhen and renderTrace.
## [2026-05-15T07:18:26.460Z]
Fix: scope-filter block was passing raw parseError.message instead of buildIssueMessage. Now uses structured what/why/next.
## [2026-05-15T07:22:55.685Z]
Fix: scope-filter block was passing raw parseError.message as issue message instead of buildIssueMessage. Now uses structured what/why/next format to satisfy what-why-next aspect.
## [2026-05-15T07:28:53.036Z]
Fix checkTypeWhenMismatch: unreadable issues were collected but never merged into the main issues list. Now allUnreadable accumulates from Stage 4 (whenMismatch) and Stage 5 (strict), de-duplicated by message, then pushed into issues.
## [2026-05-15T07:32:22.551Z]
Add checkFileMappingGitignored: emits file-mapping-gitignored when a concrete file in a node mapping is excluded by .gitignore (root or cascading). Uses walkRepoFiles to build the tracked-file set, then flags mapping entries absent from it. Only fires for files that exist on disk (not typo errors).
## [2026-05-15T08:09:40.563Z]
Add checkStrictBackwardCoverage: scans all repo files against each strict type's when predicate, emitting type-strict-orphan (file matches strict type but unmapped), type-strict-misplaced (file mapped to wrong-type node), and strict-overlap-conflict (two strict types' when predicates overlap — one error per ordered pair). Overlap detection supersedes orphan/misplaced for conflicting files. Also fixed checkStrictBackwardCoverage tests: intermediate directories without yg-node.yaml are not scanned by loadGraph; tests now use flat (one-level) node paths.
## [2026-05-15T08:14:21.206Z]
Split file-duplicate-mapping from overlapping-mapping: exact path duplicate in two nodes now emits file-duplicate-mapping (new code); containment (non-ancestor) continues to emit overlapping-mapping. Updated two test cases that were checking overlapping-mapping on exact duplicates.
## [2026-05-15T12:12:58.789Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:34:39.053Z]
R0.4: file-content-cache import updated from ./file-content-cache to ../io/file-content-cache (no logic change)
## [2026-05-15T13:55:50.486Z]
R0.1 Phase 4: populate messageData via issueMsg() helper on every ValidationIssue. buildIssueMessage still called for backward compat message field; Phase 5 will drop message.
## [2026-05-15T14:17:01.550Z]
Drop deprecated message field: issueMsg() returns only messageData; buildIssueMessage import removed; de-duplication uses messageData.what. R0.1 Phase 5.
## [2026-05-15T19:28:50.442Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-16T05:58:05.841Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T13:56:23.582Z]
Fix what-why-next violation: read messageData from nodeParseErrors and architectureError instead of reconstructing IssueMessage inline. Align with updated Graph model where nodeParseErrors stores IssueMessage and architectureError removes bare string variant.
## [2026-05-16T17:00:56.632Z]
Removed duplicate collectAncestors in effective-aspects.ts; now imports the canonical root-first implementation from context-builder. Reason: the local version returned leaf-first (push) while the exported version returns root-first (unshift); two definitions with opposing orderings would silently reverse traversal if a future caller imported the wrong one. Order is irrelevant for the two existing call sites (both iterate ancestors as a set to test membership). Eliminated the bug-in-waiting.
## [2026-05-16T19:31:38.646Z]
Removed effective-aspects.ts from mapping; the file moved to core/graph/aspects.ts under the cli/core/graph node. validator.ts import path updated accordingly.
## [2026-05-26T10:00:43.918Z]
Four new structural error codes for AST aspect language field: missing-required, scalar-not-array, empty-list, unknown-language. Imports LANGUAGES from core/graph/language-registry per existing core→core/graph precedent. LLM aspects retain optional language field with same registry membership check.
## [2026-05-27T07:22:23.992Z]
Phase 6 type-bridge: updated reviewer comparisons from string form (aspect.reviewer === 'ast') to object form (aspect.reviewer.type === 'ast'); updated checkAspectReviewerEnum to use aspect.reviewer.type; updated checkAspectRuleSources to derive reviewer from aspect.reviewer.type.
## [2026-05-27T08:00:17.924Z]
Updated the when-predicate-invalid branch to access archErr.messageData (IssueMessage) instead of archErr.message (string). This aligns with the ArchitectureLoadError type change: the when-predicate-invalid variant now uses messageData: IssueMessage instead of message: string, matching the architecture-invalid variant and satisfying the what-why-next aspect requirement that engine-returned diagnostics carry structured IssueMessage.
## [2026-05-27T09:16:11.504Z]
Updated validator to use configErrorMessage (IssueMessage) when available, falling back to the plain configError string for backward compatibility. This ensures structured what/why/next propagation is preserved through the validation pipeline for structured config parse errors (ConfigParseError), while unstructured parse errors (generic Error) continue to work as before. The error code in the ValidationIssue now comes from graph.configErrorCode when present, defaulting to 'config-invalid'.
## [2026-05-27T09:35:52.453Z]
Phase 9: validator emits aspectParseErrors as structured codes, adds config-reviewer-missing check (fires when reviewer section absent from config), aspect-tier-unknown check (fires when aspect references a tier not configured), and secrets-non-credential-field check (fires when yg-secrets.yaml has fields other than api_key). All checks suppress correctly when configError is set.
## [2026-05-27T10:12:55.169Z]
Phase 9 Task 36/36b/37/38: emit aspectParseErrors as structured validator codes; add checkReviewerPresence (config-reviewer-missing), checkAspectTierReferences (aspect-tier-unknown), and checkSecretsCredentialsOnly (secrets-non-credential-field) validation functions; import inspectSecretsForValidation from secrets-parser. These checks enforce v5 reviewer tier requirements: every project needs a reviewer section, aspect tier references must match configured tiers, and yg-secrets.yaml must contain only api_key credentials.
## [2026-05-27T13:54:46.807Z]
Removed dead reviewer-enum guard that targeted the pre-mapping scalar shape and removed a gratuitous cast on the discriminated reviewer union. The parser is the single point of structural rejection for the reviewer field; the validator only checks cross-file invariants (tier reference resolution, secrets narrowing). User-facing message strings no longer name a specific schema version.
## [2026-05-28T08:00:15.280Z]
Added validateAspectReferences — a new async validation step that checks every LLM aspect's references array. For each declared reference path, the function resolves it against the project root and calls statPath (which follows symlinks). If the path does not exist, an aspect-reference-broken error is emitted with a message telling the developer to create the file, fix the path, or remove the reference. If the path exists but is a directory rather than a regular file, a separate aspect-reference-broken error is emitted explaining that directories cannot be loaded into the reviewer prompt. This validation runs in Stage 4, after checkAspectRuleSources and before the Stage 5 global checks. The check is intentional — we want to fail early when a declared reference is missing or mispointed, rather than letting approve fail at runtime.
## [2026-05-28T08:06:23.925Z]
Extended checkAspectReferences to enforce per-file and total-bytes size limits on LLM aspect references. Added two new error codes (aspect-reference-too-large and aspect-references-total-too-large) and a warning code (aspect-references-empty-array) for aspects that explicitly declare an empty references list. Size limits are resolved from the aspect's tier configuration (references.max_bytes_per_file and references.max_total_bytes_per_aspect fields) with fallback defaults of 64 KiB per file and 256 KiB total per aspect. The validator now imports selectTierForAspect to perform canonical tier resolution. Both size checks and the existing broken-path check run in a single pass over each aspect's references list.
## [2026-05-28T10:05:35.163Z]
Updated checkAspectReferences to include the tier name and KiB-formatted sizes in aspect-reference-too-large and aspect-references-total-too-large error messages. Added formatBytes helper (returns 'N bytes' for values under 1024, 'N KiB' for values >= 1024). Tier name is captured from sel.tierName when tier resolution succeeds; falls back to 'for the resolved tier' when it does not. Messages now read: 'is 142 KiB, exceeding the per-file limit of 64 KiB for tier standard' rather than raw byte counts with no tier name — giving agents actionable context.
## [2026-05-28T12:19:37.368Z]
Add aspect-status-downgrade validation: for each (node, effective-aspect), walk per-channel sources via getAspectStatusSources and emit an error when an explicit attach-site status is strictly below the anchor (max of other sources, falling back to the aspect default when no other source exists). This prevents an explicit override from silently weakening a status that already cascades onto the node via another channel — channel-1 own, channel-2 ancestor node, channel-3 own arch type, channel-4 ancestor arch type, channel-5 flow, or channel-6 port. Only EXPLICIT declarations (sites where the aspect id is a key in the side-table aspectStatus map) are flagged; cascaded defaults are anchors, never violators.
## [2026-05-29T05:46:51.137Z]
Extended checkAspectRuleSources to handle structure aspects. Structure aspects require check.mjs and forbid content.md, using the same validation rules as AST aspects. Dynamic labels in error messages distinguish 'Structure' from 'AST' based on reviewer type.
## [2026-05-29T22:21:12.500Z]
The graph validation checks were extracted from a single oversized validator module into domain-grouped modules (architecture, aspects, mapping and coverage, relations and flows) plus a small shared helper, leaving the orchestrator that runs every check and assembles the result in place to compose them. The move was verbatim: no change to which rules run, their order, their diagnostic messages, or their verdicts. The motivation is that one very large source file degrades reviewer accuracy and risks context-window truncation that can spuriously reject unchanged code; keeping each unit small enough to be reviewed in full removes that failure mode.
## [2026-05-30T02:29:44.353Z]
The per-node size guard changed from limiting the raw count of mapped source files to limiting the total number of characters in a node's reviewer context — its mapped source files plus the reference files of its effective aspects — and from a non-blocking warning to a blocking error. The motivation is that the reviewer concatenates all of a node's files into each aspect prompt, so an oversized node risks exceeding the model's context window, which deterministically rejects unchanged code near the truncation point; a file-count limit missed this because one very large file could stay under the count while still blowing the prompt. Binary files do not count toward the budget, and a node mapping a single unsplittable generated or binary artifact (a lockfile, an append-only changelog, an image) may carry a documented per-node exemption with a required justification.
## [2026-05-30T02:50:36.953Z]
Made the validation-scope-not-found diagnostic carry an explicit issue code and an explicit structured message payload, matching every other diagnostic the orchestrator returns. Previously it set only the spread message fields and relied on the helper to attach the payload, which made it the lone diagnostic without an explicit code — leaving its category ambiguous to the rendering layer and inconsistent with its siblings.
## [2026-05-30T04:04:46.131Z]
Threaded the shared file-content cache into the per-node size check so files already read by earlier validation passes are reused from memory rather than read from disk a second time.
## [2026-05-31T16:03:34.431Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-05-31T16:28:49.067Z]
Two related correctness improvements to the validation layer. First, the set of structural error codes — the codes that always block the check regardless of drift — had been hard-coded in two places, once for the summary tally and once for the rendered grouping, and the two had silently diverged so the count could disagree with what was shown to the agent. They now share a single definition, so the tally and the grouping can never drift apart again. Second, a new validation rejects a node mapping that resolves outside the repository root — an absolute path, or one that climbs above the root with a parent-directory segment. The mapping-path normalizer only converts separators and strips a leading current-directory prefix and trailing slashes; it does not collapse parent-directory segments, so without this guard a mapping could claim files outside the project and bypass coverage and aspect enforcement.
## [2026-06-08T16:40:57.823Z]
The mapping-overlap validation step became asynchronous because it now resolves globs to concrete files to detect file-level overlaps; the validator awaits it. No change to which violations are reported beyond the added glob-overlap detection.
## [2026-06-16T09:52:39.897Z]
Dropped the secrets-non-credential check registration: yg-secrets is now a general deep-merge overlay over yg-config, so non-credential fields in it are valid and must not be flagged.
## [2026-06-19T05:55:06.181Z]
Stops enforcing that schema files are present. The presence requirement is gone because schema references are now embedded in the tool and reached through a command rather than copied into each project, so validation no longer wires in that check.
## [2026-07-05T20:58:29.353Z]
The reviewer-section requirement is now conditional: the missing-reviewer error is raised only when a judgment rule is actually effective on some component, so a script-only project verifies clean without configuring a model to judge code.
## [2026-07-10T08:10:35.648Z]
Wired the error-direction contract into the validation pipeline so it runs on every check. A label that records how a rule can be wrong must be verified for legality across the whole graph, next to the other rule-definition contracts, so drift is refused at the gate rather than slipping through.
## [2026-07-10T10:30:26.493Z]
Wired the dead-attach linter into the validation run so that a rule which is attached but effectively applies to no component surfaces as a non-blocking warning on every check. It runs only after the architecture vocabulary itself has been validated, because deciding whether a rule applies requires evaluating its conditional predicates, and those are meaningless on a structurally broken architecture — running earlier could produce misleading results before the real structural error is fixed.
