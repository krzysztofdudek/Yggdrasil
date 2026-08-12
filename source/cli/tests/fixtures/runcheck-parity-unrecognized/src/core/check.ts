/**
 * A runCheck seam that READS the member the rule's ISSUE_TRANSFORM map lists,
 * but in shapes the whole-list-rewrite derivation does not match.
 *
 * That map's entry claims exactly one thing: the member is issue-affecting and
 * this body cannot act on it yet, so demanding it at every call site is safe and
 * costs nothing. The moment the body DOES read it, that claim is no longer the
 * fact keeping the entry honest — the shape it is read in is what decides
 * whether every call site is being asked for enough. So a body reading it in an
 * unrecognized shape must surface as a loud, classification-demanding refusal
 * rather than a quietly-trusted entry.
 *
 * Each of the three reads below differs from the recognized rewrite in EXACTLY
 * ONE respect, so each pins one of that matcher's requirements on its own:
 *
 *   - `pinsFirstArgument` — the transform rewrites a DIFFERENT list than the one
 *     the alternative hands back;
 *   - `pinsOptionFedIn`   — the option decides WHETHER to rewrite but is never
 *     handed to the transform, so the transform cannot vary on it;
 *   - `pinsReturnedList`  — a flawless rewrite of a list this function does not
 *     return as its issues (a byproduct).
 *
 * Delete any ONE of those three requirements from the rule and the read it
 * guards starts deriving: this seam's member becomes a derived key, the
 * unproven refusal disappears, and the caller — which passes every DERIVED
 * option and not this one — is refused for omitting it instead. Both halves of
 * that flip are asserted, so no requirement can be dropped in silence.
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
  /** Listed in the rule's ISSUE_TRANSFORM map — and read below in shapes it does not match. */
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
): string[] {
  const reviewOverdueIssues: string[] = options?.nowUtc
    ? [`review-overdue@${options.nowUtc().toISOString()}`]
    : [];

  const digestGateIssues: string[] = options?.rulesArtifacts
    ? options.rulesArtifacts.map((a) => `digest-stale:${a}`)
    : [];

  const assembled = [`graph:${graph}`, ...(gitTrackedFiles ?? []), ...reviewOverdueIssues, ...digestGateIssues];

  // pinsFirstArgument: the alternative hands back `assembled`, but the transform
  // rewrites `digestGateIssues` — so this is not a rewrite OF the list opposite
  // it, it is a choice between two unrelated lists.
  let issues = options?.changeScope ? rescope(digestGateIssues, options.changeScope) : assembled;

  // pinsOptionFedIn: same list on both branches, but the transform never
  // receives the option, so nothing about it can vary with what a caller passes.
  issues = options?.changeScope ? renumber(issues) : issues;

  // pinsReturnedList: a flawless rewrite — conditioned on the option, same list
  // on both branches, option handed in — of a list this function does NOT return
  // as its issues. It is a byproduct, and a byproduct alters no issue.
  const auditRows = [...assembled];
  const noted = options?.changeScope ? rescope(auditRows, options.changeScope) : auditRows;
  if (noted.length > 0) writtenIndex.push(`noted:${noted.length}`);

  if (options?.writeFeatureIndex) {
    const clock = options.now ?? (() => new Date());
    writtenIndex.push(`${clock().toISOString()}:${issues.length}`);
  }

  return issues;
}

function rescope(issues: string[], scope: string): string[] {
  return issues.map((i) => `${scope}:${i}`);
}

function renumber(issues: string[]): string[] {
  return issues.map((i, n) => `${n}:${i}`);
}

const writtenIndex: string[] = [];

export function readIndex(): string[] {
  return writtenIndex;
}
