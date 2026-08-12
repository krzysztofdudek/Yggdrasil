/**
 * A runCheck seam whose rewrites reach the returned issue set WITHOUT ever being
 * bound to a name a `return` hands back.
 *
 * The rule's rewrite matcher requires that a rewrite's result become the issue
 * set runCheck returns, and it recognizes three ways for that to happen: the
 * result is bound (or assigned) to an identifier a `return` names, it IS the
 * returned expression, or it is the `issues` property of a returned object
 * literal. Only the first of those needs a returned identifier to exist. The
 * other two are the ones this seam is made of, and both shipped unreachable:
 * the rule collected the identifiers a `return` names and gave up when that set
 * came back empty — which is exactly what it is for a body written this way. A
 * rewrite in a shape the rule documents as recognized therefore did not derive,
 * and the member's refusal told its author to write the code already on screen.
 *
 *   - `scopeInProperty` — the rewrite sits directly in the `issues` property of
 *     a returned object literal;
 *   - `scopeInReturn`   — the rewrite is the returned expression itself.
 *
 * Neither is bound to anything, so this seam names no returned identifier at
 * all. Both must derive and be demanded at every call site; restore that
 * give-up-when-empty step and both stop deriving, and the caller below that
 * omits them is no longer refused.
 */

export interface CheckResult {
  issues: string[];
  count: number;
}

export interface RunCheckOptions {
  /** INJECTED clock. Absent ⇒ the review-cadence check is skipped. */
  nowUtc?: () => Date;
  /** Byproduct switch — writes an index; never changes the issue set. */
  writeFeatureIndex?: boolean;
  /** INJECTED clock stamped into that byproduct; never reaches the issue set. */
  now?: () => Date;
  /** INJECTED artifacts snapshot. Absent ⇒ the digest gate is skipped. */
  rulesArtifacts?: string[];
  /** Rewrites the returned list from inside the returned object literal. */
  scopeInProperty?: string;
  /** Rewrites the returned result as the returned expression itself. */
  scopeInReturn?: string;
  /** Listed in the rule's ISSUE_TRANSFORM map; this body never reads it. */
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

export function runCheck(
  graph: string,
  gitTrackedFiles: string[] | null,
  options?: RunCheckOptions,
): CheckResult {
  const reviewOverdueIssues: string[] = options?.nowUtc
    ? [`review-overdue@${options.nowUtc().toISOString()}`]
    : [];

  const digestGateIssues: string[] = options?.rulesArtifacts
    ? options.rulesArtifacts.map((a) => `digest-stale:${a}`)
    : [];

  const assembled = [`graph:${graph}`, ...(gitTrackedFiles ?? []), ...reviewOverdueIssues, ...digestGateIssues];

  if (gitTrackedFiles === null) {
    // The rewrite as the `issues` property of the returned object literal.
    return {
      issues: options?.scopeInProperty ? rescope(assembled, options.scopeInProperty) : assembled,
      count: assembled.length,
    };
  }

  // The rewrite as the returned expression itself.
  const result: CheckResult = { issues: assembled, count: assembled.length };
  return options?.scopeInReturn ? rescopeResult(result, options.scopeInReturn) : result;
}

function rescope(issues: string[], scope: string): string[] {
  return issues.map((i) => `${scope}:${i}`);
}

function rescopeResult(result: CheckResult, scope: string): CheckResult {
  const issues = rescope(result.issues, scope);
  return { issues, count: issues.length };
}
