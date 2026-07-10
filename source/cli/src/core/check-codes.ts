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
  // A git-tracked file is matched by a directory/glob mapping entry (so the
  // coverage scan counts it covered) but is gitignored — the hash layer drops it
  // from the node's subject set, so no reviewer ever sees it (a false green).
  // Blocking, distinct from the plain "not covered" coverage error.
  'mapped-file-gitignored',
  'enforce-strict-without-when',
  'architecture-cycle',
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
  'aspect-tier-unknown',
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
 * (Pre-existing warnings such as `orphaned-aspect`, `high-fan-out`, and
 * `aspect-references-empty-array` follow the same convention: warning severity,
 * outside every blocking set.)
 */

