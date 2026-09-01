/**
 * A runCheck seam carrying one near miss per REJECTING requirement of the
 * whole-list-rewrite matcher. Each differs from the recognized rewrite in
 * exactly ONE respect, so deleting the requirement it targets — and only that
 * one — makes it derive.
 *
 * Three of them read the member the rule's ISSUE_TRANSFORM map lists. That
 * map's entry claims exactly one thing: the member is issue-affecting and this
 * body cannot act on it yet, so demanding it at every call site is safe and
 * costs nothing. The moment the body DOES read it, that claim is no longer the
 * fact keeping the entry honest — the shape it is read in is what decides
 * whether every call site is being asked for enough. So a body reading it in an
 * unrecognized shape must surface as a loud, classification-demanding refusal
 * rather than a quietly-trusted entry.
 *
 *   - `pinsOptionsObject` — conditioned on a LOCAL that carries a same-named
 *     field rather than on the injected options object. Without the matcher's
 *     object check this derives a PHANTOM key: every call site is refused for
 *     omitting an option whose presence changes nothing about this ternary,
 *     while the rule simultaneously contradicts that option's own side-effect
 *     classification. It reads a side-effect member so that both consequences
 *     are visible at once;
 *   - `pinsFirstArgument` — the transform rewrites a DIFFERENT list than the one
 *     the alternative hands back;
 *   - `pinsOptionFedIn`   — the option decides WHETHER to rewrite but is never
 *     handed to the transform, so the transform cannot vary on it;
 *   - `pinsReturnedList`  — a flawless rewrite of a list this function does not
 *     return as its issues (a byproduct).
 *
 * Delete the requirement any one of them targets and that read starts deriving.
 * For the three on the map's member, the unproven refusal disappears and the
 * caller — which passes every DERIVED option and not this one — is refused for
 * omitting it. For the phantom, the caller is refused for omitting a key the
 * rule invented. Both halves of every flip are asserted.
 *
 * The matcher's fifth requirement, that the alternative be a bare identifier, is
 * subsumed by the first-argument comparison and provably cannot change a verdict
 * on its own, so nothing here pins it and the rule's own docblock says why.
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

  // pinsOptionsObject: a rewrite of the returned list in every respect the
  // matcher checks — except that it is conditioned on a locally assembled toggle
  // set rather than on the injected options, while the value handed to the
  // transform is the real option. Reading a local snapshot instead of the
  // injected input is an ordinary mistake, and the matcher must not turn the
  // local's field name into an option every call site owes.
  const localToggles: { runtimeDispositions?: unknown } = {};
  issues = localToggles?.runtimeDispositions ? annotate(issues, options?.runtimeDispositions) : issues;

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

function annotate(issues: string[], marker: unknown): string[] {
  return issues.map((i) => `${String(marker)}:${i}`);
}

const writtenIndex: string[] = [];

export function readIndex(): string[] {
  return writtenIndex;
}
