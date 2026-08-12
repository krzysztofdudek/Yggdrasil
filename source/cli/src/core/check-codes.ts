/**
 * Single source of truth for issue-code categories shared between the check
 * engine (core/check.ts — summary tallies) and the check command renderer
 * (cli/check.ts — error grouping). Keeping one definition means the count in the
 * summary line and the rendered "Structural" group can never drift apart, which
 * is exactly what happened when each file hard-coded its own set.
 */

/**
 * Standing notice: coverage.type_level is on, but no type in the architecture
 * declares when:, so the classification lattice can never match a single
 * file (classifyFile skips every type without when — core/type-classifier.ts)
 * — the flag is committed but does nothing yet. Shared verbatim between yg
 * check's coverage-section render and yg init's closing summary so the same
 * fact reads identically on both surfaces.
 */
export const ZERO_CLASSIFYING_TYPES_NOTICE =
  "Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — no file can be type-covered until you add classifying types.";

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
  'file-mapping-excluded',
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
  // Live type-to-type relation gate (coverage.type_level): a statically-resolved
  // import edge between two classified endpoints (an explicit node and/or a
  // type-covered file) has no allowed relation type under the architecture's
  // allow-list. Always an error, independent of the endpoints' coverage tier.
  'type-relation-forbidden',
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
  // A cycle in the aspect `implies` graph makes effective-aspect resolution
  // undefined for every node the cycle can reach — not just the cycle's own
  // members, since `implies` composes with type defaults, `when`, and other
  // channels in ways a fill run cannot cheaply bound. Gate the WHOLE fill
  // rather than dispatch reviewer calls for pairs that look unrelated: a
  // narrower gate would still spend money before ending red, and the
  // resolution the cost was spent on cannot be trusted anyway.
  'aspect-implies-cycle',
  // Defense-in-depth for the mapping path-traversal hole (belt-and-suspenders;
  // the node-parser's parse-time escapesRepo guard is primary — an escaping
  // mapping fails to load, so the node never reaches the fill stage). If an
  // escaping mapping ever reaches a loaded graph another way, gate the fill
  // stage here so it ABORTS before any subject-file read — an out-of-repo file's
  // bytes must never flow into a reviewer prompt.
  'mapping-escapes-repo',
]);

/**
 * Wide-tier scoped codes — the codes progressive mode is ever allowed to consider
 * downgrading from a blocking error to a non-blocking warning when a change cannot
 * be honestly held accountable for them. Nothing consumes this set yet; declaring
 * it is the whole of this module's job here. Everything NOT in this set keeps
 * blocking unconditionally, forever, regardless of what a future consumer does —
 * so membership is doctrine, not convenience. Adding a code requires its own
 * documented policy rationale, the same bar as every entry below; it must never
 * be added merely because a downgrade would be convenient for some caller.
 *
 * Four codes are deliberate carve-outs FROM `STRUCTURAL_CODES` above: each stays a
 * structural member (self-consistency of the graph still requires it to block
 * unconditionally today) AND is admitted here, because each is a
 * code-versus-graph drift finding — a brownfield reality an adopter inherits from
 * code that predates or diverges from the graph — rather than a graph-authoring
 * self-inconsistency the graph author alone could have avoided:
 *
 *   - relation-undeclared-dependency — the drift is between the SOURCE TREE's
 *     import graph and the architecture's declared relations; the graph itself
 *     is well-formed, but the code a change touches may or may not be the code
 *     that introduced the undeclared edge.
 *   - type-relation-forbidden — same shape, one layer more specific: a
 *     statically-resolved import between two classified endpoints has no
 *     allowed relation type. The architecture's allow-list is not wrong; the
 *     code's actual dependency is what disagrees with it.
 *   - ambiguous-node-type — an uncovered FILE's own shape matches two
 *     classifying types at once. Nothing about the type definitions is
 *     self-contradictory; the file is the thing that is ambiguous, and a
 *     change that never touched it did not create the ambiguity.
 *   - type-when-mismatch — a node's own mapped file fails its declared type's
 *     `when:` predicate. The type definition and the node's declaration are
 *     both well-formed; the drift is between the file's actual content and
 *     the shape the graph asserts for it — exactly the same family as the
 *     three above, just keyed to a node's own mapping instead of a relation.
 *
 * No other `STRUCTURAL_CODES` member may be added here without the same kind of
 * documented rationale — a code stays out by default.
 */
export const SCOPED_CODES = new Set<string>([
  // Pair-verdict codes: a reviewer/deterministic verdict a change's own pairs
  // did or did not reach.
  'unverified',
  'aspect-violation-enforced',
  'prompt-too-large',
  'aspect-companion-runtime-error',
  // Log-gate codes: a component's log is its own channel, reached only when
  // the component itself is touched.
  'log-entry-missing',
  'log-integrity',
  'log-format',
  'log-conflict',
  // Metadata completeness: a per-node fact, reached only when that node is
  // touched.
  'description-missing',
  // Coverage codes: per-file findings, reached only when the named file is
  // touched.
  'unmapped-files',
  'tracked-file-gitignored',
  // Strict-mapping codes: per-file/per-node overlap findings, reached only
  // when the file or node in question is touched.
  'type-strict-orphan',
  'type-strict-misplaced',
  'strict-overlap-conflict',
  // Carve-outs from STRUCTURAL_CODES — see the four rationale bullets above.
  'type-when-mismatch',
  'relation-undeclared-dependency',
  'type-relation-forbidden',
  'ambiguous-node-type',
]);

/**
 * The ONLY place the `-outside` suffix is spelled. Every producer and consumer
 * of an outside-twin code must call this function rather than re-spelling the
 * suffix inline — a hand-spelled copy that drifts from this one would silently
 * stop matching, defeating the twin scheme without raising any error.
 */
export function outsideTwin(code: string): string {
  return `${code}-outside`;
}

/**
 * The outside-twin of every `SCOPED_CODES` member, derived — never hand-listed.
 * A hand-listed copy would drift from `SCOPED_CODES` the first time this set
 * changes and nobody remembered to update a parallel list.
 */
export const OUTSIDE_CODES = new Set<string>(Array.from(SCOPED_CODES, outsideTwin));

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

