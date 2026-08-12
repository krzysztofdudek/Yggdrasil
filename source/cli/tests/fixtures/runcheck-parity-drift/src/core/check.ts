/**
 * A DRIFTED mirror of the engine's runCheck seam — the realistic, PARTIAL kind
 * of drift a parity-only rule cannot see.
 *
 * Two things moved out from under the rule's knowledge:
 *   - `strictMode` is a THIRD issue-gating input, but it is written as an
 *     if-statement instead of the `options?.<key> ? <issues> : []` ternary the
 *     derivation matches. It is therefore NOT derived, so no call site is asked
 *     for it — the rule silently under-enforces exactly as before, while the
 *     already-derived keys keep the zero-key canary quiet.
 *   - `now` is gone, but the rule's side-effect allowlist still names it — a
 *     stale exemption that would silently pre-approve any future member taking
 *     that name.
 *
 * Both must surface as loud, classification-demanding refusals.
 */

export interface RunCheckOptions {
  /** INJECTED clock. Absent ⇒ the review-cadence check is skipped. */
  nowUtc?: () => Date;
  /** Byproduct switch — writes an index; never changes the issue set. */
  writeFeatureIndex?: boolean;
  /** INJECTED artifacts snapshot. Absent ⇒ the digest gate is skipped. */
  rulesArtifacts?: string[];
  /** ISSUE-GATING, but written in a shape the derivation does not match. */
  strictMode?: boolean;
  /**
   * DECLARED AHEAD OF ITS CONSUMER — nothing in this body reads it. The rule's
   * ISSUE_TRANSFORM map classifies it and demands it at every call site; the
   * single caller passes it, so it contributes no violation here. Present so
   * that map holds no entry naming a member this seam does not declare.
   */
  changeScope?: string;
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

  const issues = [`graph:${graph}`, ...(gitTrackedFiles ?? []), ...reviewOverdueIssues, ...digestGateIssues];

  // A gate on an injected input — same seam, different shape. Omitting
  // strictMode silently drops these issues, with no error anywhere.
  if (options?.strictMode) {
    for (const f of gitTrackedFiles ?? []) issues.push(`strict:${f}`);
  }

  if (options?.writeFeatureIndex) {
    writtenIndex.push(`${issues.length}`);
  }

  return issues;
}

const writtenIndex: string[] = [];

export function readIndex(): string[] {
  return writtenIndex;
}
