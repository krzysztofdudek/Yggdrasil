/**
 * Fixture mirror of the engine's runCheck seam.
 *
 * Shaped to match the real `source/cli/src/core/check.ts` in every way the
 * runcheck-injected-input-parity rule derives from:
 *   - two ISSUE-GATING options written as `options?.<key> ? <issues> : []`
 *     (nowUtc, rulesArtifacts) — absent input silently skips a check;
 *   - two SIDE-EFFECT switches (writeFeatureIndex, now) written as an
 *     if-statement, so they never derive as gating and must be classified by
 *     the rule's allowlist instead;
 *   - a same-file helper carrying its OWN `options?.<key> ? … : []` ternary,
 *     which a derivation scoped to the whole file (rather than to runCheck's
 *     own body) would wrongly turn into a required call-site key.
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
}

export interface HelperOptions {
  phantomKey?: boolean;
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

  // Byproduct only: written AFTER the issue set is computed, and never merged
  // into it. Deliberately NOT the gating ternary shape.
  if (options?.writeFeatureIndex) {
    const clock = options.now ?? (() => new Date());
    writeIndex(clock().toISOString(), issues.length);
  }

  return issues;
}

/**
 * A helper in the SAME file with its own gating ternary. A derivation that
 * walked the whole file instead of runCheck's own body would pick `phantomKey`
 * up and demand it at every runCheck call site — refusing compliant code with a
 * fix that would not even typecheck.
 */
export function helper(options?: HelperOptions): string[] {
  return options?.phantomKey ? ['phantom'] : [];
}

const writtenIndex: string[] = [];

function writeIndex(stamp: string, issueCount: number): void {
  writtenIndex.push(`${stamp}:${issueCount}`);
}

export function readIndex(): string[] {
  return writtenIndex;
}
