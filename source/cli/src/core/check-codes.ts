/**
 * Single source of truth for issue-code categories shared between the check
 * engine (core/check.ts — summary tallies) and the check command renderer
 * (cli/check.ts — error grouping). Keeping one definition means the count in the
 * summary line and the rendered "Structural" group can never drift apart, which
 * is exactly what happened when each file hard-coded its own set.
 */

/**
 * Structural validation codes — graph-shape and config errors that always block
 * `yg check` regardless of verification state. Both the summary tally and the
 * rendered grouping read this one set.
 */
export const STRUCTURAL_CODES = new Set<string>([
  'yaml-invalid',
  'type-invalid',
  'relation-broken',
  'flow-node-broken',
  'aspect-undefined',
  'overlapping-mapping',
  'file-duplicate-mapping',
  'structural-cycle',
  'config-invalid',
  'duplicate-aspect-id',
  'node-yaml-missing',
  'implied-aspect-missing',
  'aspect-implies-cycle',
  'event-unpaired',
  'type-without-when-with-mapping',
  'type-when-mismatch',
  'file-mapping-gitignored',
  'enforce-strict-without-when',
  'architecture-cycle',
  // A relation allow-list in yg-architecture.yaml names a target type that is
  // not a defined node type (and not the '*' wildcard) — a dangling reference
  // that silently over-restricts the relation. Blocking, like type-unknown-parent.
  'relation-target-type-unknown',
  'when-predicate-invalid',
  'when-unknown-type',
  'when-unknown-node',
  'when-unknown-port',
  // Port-contract codes — blocking architecture-gate errors (documented in the
  // ports-and-relations knowledge topic); belong in the single-source structural set.
  'port-missing-consumes',
  'port-undefined',
  'port-missing-aspect',
  'consumes-without-ports',
  'relation-target-forbidden',
  'aspect-unexpected-rule-source',
  'aspect-missing-rule-source',
  'aspect-empty',
  'aspect-companion-without-content',
  'aspect-companion-with-check',
  'file-unreadable',
  'aspect-references-on-deterministic',
  'aspect-scope-invalid',
  // Malformed aspect-level (or implies-edge) when: predicate. Structural
  // graph-shape error — blocks like the other aspect-contract codes, so a
  // broken when: can never be silently dropped into a clean PASS.
  'aspect-when-invalid',
  'aspect-scope-on-aggregate',
  'aspect-references-on-aggregate',
  'aspect-reference-broken',
  'aspect-reference-invalid-form',
  'aspect-reference-blank-path',
  'aspect-reference-escape',
  'aspect-reference-duplicate',
  'aspect-tier-unknown',
  // errs label declared on a non-deterministic aspect, or a malformed errs
  // literal — always blocks (structural graph-shape error), like the other
  // aspect-contract codes.
  'aspect-errs-invalid',
  'mapping-escapes-repo',
  // The lock file is unparseable, garbled, conflict-markered, or an unknown
  // version. Fail closed — blocking, structural, independent of any pair state.
  'lock-invalid',
  // Built-in relation-conformance refusal/unverified emitted by the parse-free
  // re-validation in runCheck. Always an error (not an aspect, not suppressible);
  // a node depends on another node without a declared, sanctioned relation, or its
  // relation verdict could not be confirmed against the current tree.
  'relation-undeclared-dependency',
  // Type-level coverage (coverage.type_level): an uncovered file matches 2+
  // non-strict classifying types and no strict type. The classification
  // lattice (core/type-coverage.ts) refuses to guess which type's rules
  // apply — always blocking, independent of whether the file sits under a
  // required or advisory coverage root.
  'ambiguous-node-type',
]);

/**
 * Metadata-completeness codes surfaced in the summary. NOTE: despite the
 * historical "non-blocking" framing, `description-missing` is emitted at
 * `severity: 'error'` (see checkMissingDescriptions) and therefore BLOCKS
 * `yg check`. Membership here governs grouping/tally only, not severity —
 * the emitting check decides whether a code blocks.
 */
export const COMPLETENESS_CODES = new Set<string>(['description-missing']);

/**
 * Gating codes — a structural validation failure that makes reviewer/tier
 * resolution impossible. When any of these is present, the `--approve` fill
 * stage ABORTS before dispatching any verification (no fills, no LLM calls):
 * the graph is broken in a way that would make every verdict meaningless.
 *
 * Shared gating-code set consumed by the fill stage (core/fill.ts).
 */
export const APPROVE_GATING_CODES = new Set<string>([
  'config-reviewer-missing',
  'config-tiers-missing',
  'config-tiers-empty',
  'config-default-tier-missing',
  'config-default-tier-unknown',
  'config-tier-provider-missing',
  'config-tier-provider-unknown',
  'config-tier-config-missing',
  'config-tier-config-not-mapping',
  'config-tier-consensus-invalid',
  'config-tier-name-invalid',
  'config-tier-name-reserved',
  'config-reviewer-unknown-key',
  'config-tier-unknown-key',
  'aspect-reviewer-missing',
  'aspect-reviewer-not-mapping',
  'aspect-reviewer-type-missing',
  'aspect-reviewer-type-invalid',
  'aspect-reviewer-unknown-key',
  'aspect-tier-on-deterministic',
  'aspect-tier-on-aggregate',
  'aspect-tier-unknown',
  // Defense-in-depth for the mapping path-traversal hole (belt-and-suspenders;
  // the node-parser's parse-time escapesRepo guard is primary — an escaping
  // mapping fails to load, so the node never reaches the fill stage). If an
  // escaping mapping ever reaches a loaded graph another way, gate the fill
  // stage here so it ABORTS before any subject-file read — an out-of-repo file's
  // bytes must never flow into a reviewer prompt.
  'mapping-escapes-repo',
]);

/**
 * Non-blocking warning codes. Warnings are emitted at `severity: 'warning'` and
 * render in the grouped Warnings block; they are deliberately NOT members of the
 * three sets above (STRUCTURAL / COMPLETENESS / APPROVE_GATING), because those
 * sets gate blocking, categorization, or the fill stage — a warning must never
 * block `yg check` or abort `--approve`. This registry documents the ones the
 * check engine emits so a code is not silently mistaken for a blocking error.
 *
 *   - aspect-effective-nowhere — dead-attach linter (C4): an aspect that ships a
 *     rule source (content.md or check.mjs) and is not draft, yet after the full
 *     7-channel cascade and every `when` predicate is effective on ZERO nodes.
 *     "Dead law that looks enforced." Emitted by checkAspectEffectiveNowhere.
 *
 *   - aspect-review-overdue — constitution review-cadence linter (RZ-18): an
 *     aspect whose `review_by:` date has passed (against an INJECTED clock, so it
 *     is skipped when no clock is supplied). Status-independent. Emitted by
 *     checkReviewOverdue. It NEVER writes the lock, changes a verdict, or gates
 *     `--approve` — a pure read-only warning, deliberately outside every blocking
 *     set.
 *
 *   - incident-ledger-out-of-order — incident-ledger integrity linter (spec §3.2):
 *     the committed `.yggdrasil/incidents.md` is append-only human testimony whose
 *     entry datetimes must be strictly ascending; this warns (never blocks) when two
 *     consecutive entries are not — the signature of a hand-edit or a reordering
 *     merge. Emitted by checkIncidentLedger. There is NO hash baseline in v1: the
 *     ledger is the tower's only external oracle and must never break CI, so this is
 *     a pure read-only WARNING, deliberately outside every blocking set. Absence is
 *     tolerated (no file ⇒ no warning).
 *
 *   - rules-digest-stale — committed agent-rules digest gate (fresh-rules
 *     distribution): AGENTS.md's digest block / .clinerules/yggdrasil.md copy /
 *     CLAUDE.md `@AGENTS.md` import is missing, hand-modified (a body no longer
 *     matches its own sha256 anchor), duplicated, or older than the installed
 *     CLI's canonical digest. Computed ONLY from injected
 *     RunCheckOptions.rulesArtifacts (the CLI boundary reads the three files and
 *     supplies the canonical hash; core does no fs of its own). Pure read-only
 *     warning, deliberately outside every blocking set — it never writes the
 *     lock, changes a verdict, or gates `--approve`. Emitted by checkDigestGate.
 *
 *   - coverage-required-shadowed — dead-config-line linter: coverage exclusion is
 *     absolute, so a coverage.required root that is fully contained in a
 *     coverage.excluded root can never match a file (exclusion always wins once
 *     it matches at all), so the required line is dead. Only decided for plain
 *     roots on both sides — glob-vs-glob containment is not statically
 *     decidable and is documented rather than warned. Emitted by
 *     checkRequiredShadowedByExcluded. Pure config check (no file list needed),
 *     read-only, never blocks, never gates --approve.
 *
 * (Pre-existing warnings such as `orphaned-aspect`, `high-fan-out`, and
 * `aspect-references-empty-array` follow the same convention: warning severity,
 * outside every blocking set.)
 *
 * NOTE on the sibling parse error `aspect-review-by-malformed`: it is NOT a
 * warning. It is a BLOCKING parse-time error emitted via `graph.aspectParseErrors`
 * (severity error) when an aspect declares a present-but-malformed `review_by:`
 * value — the exact same classification as `aspect-status-invalid` (also a
 * parse-time blocking error carried by aspectParseErrors, intentionally NOT a
 * member of STRUCTURAL_CODES). No set membership is required for it to block.
 */

