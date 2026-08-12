/**
 * Fixture mirror of the engine's runCheck seam.
 *
 * Shaped to match the real `source/cli/src/core/check.ts` in every way the
 * runcheck-injected-input-parity rule derives from:
 *   - two ISSUE-GATING options written as `options?.<key> ? <issues> : []`
 *     (nowUtc, rulesArtifacts) — absent input silently skips a check;
 *   - one ISSUE-TRANSFORM option written as
 *     `options?.<key> ? <fn>(<list>, options.<key>) : <list>` (scopeFilter) —
 *     absent input leaves the WHOLE assembled list unrewritten, which no gating
 *     ternary can express, since its alternative is that list and never `[]`;
 *   - a NEAR MISS of that rewrite shape, which must NOT derive;
 *   - one DECLARED-AHEAD-OF-ITS-CONSUMER option (changeScope) this body never
 *     reads, so neither derivation can see it and only the rule's
 *     ISSUE_TRANSFORM map classifies it — demanding it at every call site
 *     meanwhile;
 *   - six SIDE-EFFECT members (writeFeatureIndex, now, precomputedTypeCoverage,
 *     precomputedRelationPass, precomputedVerification, runtimeDispositions) —
 *     none of them written in either derived shape, so all six must be
 *     classified by the rule's allowlist instead;
 *   - a same-file helper carrying its OWN gating ternary AND its own whole-list
 *     rewrite, both of which a derivation scoped to the whole file (rather than
 *     to runCheck's own body) would wrongly turn into required call-site keys.
 */

export interface RunCheckOptions {
  /** INJECTED clock. Absent ⇒ the review-cadence check is skipped. */
  nowUtc?: () => Date;
  /** Byproduct switch — writes an index; never changes the issue set. */
  writeFeatureIndex?: boolean;
  /** INJECTED clock stamped into that byproduct; never reaches the issue set. */
  now?: () => Date;
  /** INJECTED artifacts snapshot. Absent ⇒ the digest gate is skipped. */
  rulesArtifacts?: string[];
  /** INJECTED scope. Absent ⇒ the assembled issue list is returned unrewritten. */
  scopeFilter?: string;
  /**
   * DECLARED AHEAD OF ITS CONSUMER: issue-affecting, but nothing in this body
   * reads it yet. Neither derivation can see it, so only the rule's
   * ISSUE_TRANSFORM map classifies it — and that map demands it at every call
   * site, which is what this fixture's `declared-omitted` caller proves.
   */
  changeScope?: string;
  /** INJECTED already-classified result — reused instead of a fresh classify; never reaches the issue set. */
  precomputedTypeCoverage?: unknown;
  /** An import-resolution pass the caller already ran — decides only whether it is run again. */
  precomputedRelationPass?: unknown;
  /** A lock verification the caller already computed against the same lock bytes. */
  precomputedVerification?: unknown;
  /** A same-run fill's own handoff facts — reused for a report field, never reaches the issue set. */
  runtimeDispositions?: unknown;
}

export interface HelperOptions {
  phantomKey?: boolean;
  phantomScope?: string;
}

export function runCheck(
  graph: string,
  gitTrackedFiles: string[] | null,
  options?: RunCheckOptions,
): string[] {
  const reviewOverdueIssues: string[] = options?.nowUtc
    ? [`review-overdue@${options.nowUtc().toISOString()}`]
    : [];

  const digestGateIssues: string[] = options?.rulesArtifacts
    ? options.rulesArtifacts.map((a) => `digest-stale:${a}`)
    : [];

  const assembled = [`graph:${graph}`, ...(gitTrackedFiles ?? []), ...reviewOverdueIssues, ...digestGateIssues];

  // ISSUE-TRANSFORM: the WHOLE assembled list is rewritten when the option is
  // supplied and handed back untouched when it is not. A caller that omits it
  // gets a different issue set from one that supplies it — the same defect a
  // missing gate causes, in a shape no gating ternary can be written in.
  const issues = options?.scopeFilter ? rescope(assembled, options.scopeFilter) : assembled;

  // NEAR MISS of that shape — same silhouette, but the two branches are
  // DIFFERENT lists, so nothing is being rewritten: the option only selects
  // which already-computed list this run notes. A matcher that accepted any
  // identifier as the alternative would derive this key and refuse every
  // compliant caller below, none of which passes it — it is a reuse switch,
  // classified side-effect-only.
  const noted = options?.precomputedVerification
    ? rescope(digestGateIssues, 'verified')
    : reviewOverdueIssues;
  if (noted.length > 0) writtenIndex.push(`noted:${noted.length}`);

  // Byproduct only: written AFTER the issue set is computed, and never merged
  // into it. Deliberately NOT the gating ternary shape.
  if (options?.writeFeatureIndex) {
    const clock = options.now ?? (() => new Date());
    writeIndex(clock().toISOString(), issues.length);
  }

  return issues;
}

function rescope(issues: string[], scope: string): string[] {
  return issues.map((i) => `${scope}:${i}`);
}

/**
 * A helper in the SAME file with its own gating ternary AND its own whole-list
 * rewrite. A derivation that walked the whole file instead of runCheck's own
 * body would pick `phantomKey` and `phantomScope` up and demand them at every
 * runCheck call site — refusing compliant code with a fix that would not even
 * typecheck.
 */
export function helper(options?: HelperOptions): string[] {
  const base = options?.phantomKey ? ['phantom'] : [];
  return options?.phantomScope ? rescope(base, options.phantomScope) : base;
}

const writtenIndex: string[] = [];

function writeIndex(stamp: string, issueCount: number): void {
  writtenIndex.push(`${stamp}:${issueCount}`);
}

export function readIndex(): string[] {
  return writtenIndex;
}
