/**
 * source/cli/src/core/check-progressive.ts — the classification step: for each
 * finding a check produced, is the current change accountable for it?
 *
 * A finding the change reached keeps exactly what it was. A finding the change
 * did not reach is re-coded to its `-outside` twin at `severity: 'warning'`, so
 * it still appears in the report — named, counted, never hidden — without
 * blocking a build for debt the change inherited.
 *
 * ── The asymmetry that decides every ambiguous case ─────────────────────────
 * An error wrongly DOWNGRADED is a real violation shipping green: the whole
 * point of the gate defeated, silently. An error wrongly KEPT is merely
 * annoying — someone reads a finding that was not theirs. So every branch below
 * that cannot positively attribute a finding keeps the ERROR. "Cannot attribute"
 * is never read as "not touched": a finding whose identity is missing, whose
 * shape this module does not recognize, or whose pair this run never enumerated
 * all stay blocking. Only a positive match against the burn set downgrades
 * anything.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 * No filesystem, no git, no clock, no environment. Both the findings and the
 * burn set are supplied by the caller, which computed the scope from git output
 * it read itself. This module only intersects two things it was handed.
 */

import type { CheckIssue } from './check-contract.js';
import type { VerifiedPair } from './verify-lock.js';
import type { BurnSet } from './progressive-scope.js';
import { progressivePairKey } from './progressive-scope.js';
import { OUTSIDE_CODES, SCOPED_CODES, SINGLETON_INPUTS, outsideTwin } from './check-codes.js';
import { splitCoverageIssueByTouched } from './check-coverage-tiers.js';

/**
 * The codes whose finding is about a component's LOG rather than the component
 * itself. A change to a node's `log.md` re-gates that one channel and nothing
 * else about the node — see `BurnSet.logOnlyNodePaths`, which is deliberately
 * NOT folded into `nodePaths` for exactly this reason.
 */
const LOG_CODES: ReadonlySet<string> = new Set([
  'log-entry-missing',
  'log-integrity',
  'log-format',
  'log-conflict',
]);

/** Unit-key prefix for a unit that IS one file (`model/lock.ts`'s `fileUnit`). */
const FILE_UNIT_PREFIX = 'file:';

/**
 * The one aggregate coverage finding: it names a whole LIST of uncovered files
 * rather than one subject, so it is SPLIT rather than classified as a unit.
 */
const COVERAGE_AGGREGATE_CODE = 'unmapped-files';

/**
 * Which pair keys this run actually enumerated. Used only to tell "this pair
 * exists and the change did not reach it" (outside) from "no pair like this was
 * enumerated at all" (unattributable ⇒ stays an error). Without that
 * distinction a finding whose pair the enumeration never produced would be
 * silently reported as none of the change's business — the one claim this
 * module must never make.
 */
function knownPairKeys(pairs: VerifiedPair[]): Set<string> {
  const keys = new Set<string>();
  for (const vp of pairs) keys.add(progressivePairKey(vp.pair.aspectId, vp.pair.unitKey));
  return keys;
}

/**
 * Is this ONE finding something the change is accountable for?
 *
 * A ladder of decreasing precision. Each rung answers only for a finding
 * carrying the identity that rung can probe the burn set with; anything falling
 * off the bottom is unattributable and answers TRUE (stays blocking).
 *
 * Exported for the singleton rung, which `applyChangeScope` cannot reach today:
 * no `SINGLETON_INPUTS` code is a `SCOPED_CODES` member (their findings are
 * never about a change's own diff at all, which is precisely why they are not
 * scoped), so the rung exists so that a code admitted to BOTH sets later is
 * attributed by its real fixed inputs instead of falling through to
 * "unattributable". It is tested directly rather than through the classifier.
 */
export function issueIsInScope(
  issue: CheckIssue,
  scope: BurnSet,
  known: ReadonlySet<string>,
): boolean {
  // 1. A finding whose entire input is a fixed, well-known project file. Its
  //    subject does not depend on any other identity it happens to carry, so
  //    this rung answers first.
  const singletonInputs = SINGLETON_INPUTS.get(issue.code);
  if (singletonInputs !== undefined) return singletonInputs.some((p) => scope.files.has(p));

  // 2. A pair-derived finding names its pair exactly.
  if (issue.aspectId !== undefined && issue.unitKey !== undefined) {
    const key = progressivePairKey(issue.aspectId, issue.unitKey);
    if (scope.pairKeys.has(key)) return true;
    return !known.has(key);
  }

  // 3. A component-keyed finding. A component's log is its own channel: writing
  //    a log entry re-gates that log and nothing else, so a LOG finding is the
  //    change's business for that edit even though nothing else about the
  //    component moved — and, symmetrically, a non-log finding on the same
  //    component is not.
  if (issue.nodePath !== undefined) {
    if (scope.nodePaths.has(issue.nodePath)) return true;
    return LOG_CODES.has(issue.code) && scope.logOnlyNodePaths.has(issue.nodePath);
  }

  // 4. A per-file finding that named its file through the unit key.
  if (issue.unitKey?.startsWith(FILE_UNIT_PREFIX) === true) {
    return scope.files.has(issue.unitKey.slice(FILE_UNIT_PREFIX.length));
  }

  // 5. An aggregate finding carrying the concrete file-to-file edges it is
  //    about. ANY one of them being part of the change makes the whole finding
  //    the change's business — it is one finding and cannot be half-outside.
  if (issue.relationEdges !== undefined && issue.relationEdges.length > 0) {
    return issue.relationEdges.some((e) => scope.files.has(e.fromFile) || scope.files.has(e.toFile));
  }

  // 6. Nothing to attribute it by — keep it blocking.
  return true;
}

/** The same finding, re-coded to its outside twin. `messageData` is untouched:
 *  the what/why/next a person reads describes the finding, not its scope. */
function toOutsideTwin(issue: CheckIssue): CheckIssue {
  return { ...issue, code: outsideTwin(issue.code), severity: 'warning' };
}

/**
 * The aggregate coverage finding, partitioned into the part the change touched
 * (still blocking) and the part it merely inherited (the outside twin). Each
 * half is REBUILT from its own file list by the coverage builder, so the count
 * and sample inside each message are true for that half alone.
 *
 * A finding with no file list is unattributable and stays exactly as it was —
 * splitting an empty list would make a blocking error disappear.
 *
 * With a non-empty list at least one half always exists: the two halves
 * partition it, and the builder returns a finding for any non-empty side.
 */
function splitCoverageFinding(issue: CheckIssue, scope: BurnSet): CheckIssue[] {
  if (issue.uncoveredFiles === undefined || issue.uncoveredFiles.length === 0) return [issue];
  const { inScope, outside } = splitCoverageIssueByTouched(issue, scope.files);
  const halves: CheckIssue[] = [];
  if (inScope !== undefined) halves.push(inScope);
  if (outside !== undefined) halves.push(toOutsideTwin(outside));
  return halves;
}

/**
 * Classify every finding against the change scope.
 *
 * Rules, in the order they are applied:
 *   - a code outside `SCOPED_CODES` is never touched, whatever its severity
 *     (this is also what makes an outside twin un-re-twinnable: no twin code is
 *     a scoped code);
 *   - a finding already at warning severity is never touched;
 *   - the aggregate coverage finding is SPLIT, not re-coded wholesale;
 *   - everything else is kept as-is when {@link issueIsInScope} says the change
 *     reached it, and re-coded to its warning-severity twin when it did not;
 *   - a GLOBAL burn set means the change reached something no per-finding
 *     intersection can bound, so this is the identity function.
 *
 * The returned list is a new array in the SAME order (the coverage split
 * contributes its blocking half first), except under a global scope, where the
 * caller's own list is handed straight back.
 */
export function applyChangeScope(
  issues: CheckIssue[],
  scope: BurnSet,
  pairs: VerifiedPair[],
): CheckIssue[] {
  if (scope.global) return issues;
  const known = knownPairKeys(pairs);
  const classified: CheckIssue[] = [];
  for (const issue of issues) {
    if (!SCOPED_CODES.has(issue.code) || issue.severity !== 'error') {
      classified.push(issue);
      continue;
    }
    if (issue.code === COVERAGE_AGGREGATE_CODE) {
      classified.push(...splitCoverageFinding(issue, scope));
      continue;
    }
    classified.push(issueIsInScope(issue, scope, known) ? issue : toOutsideTwin(issue));
  }
  return classified;
}

/**
 * How many enforced obligations this run reports as outside the change.
 *
 * Counted from the CLASSIFIED list so there is exactly one definition of the
 * number, shared by the result the command renders and the single next step it
 * points at — two places that must never be able to disagree.
 *
 * One twin is one obligation, EXCEPT the aggregate coverage twin, which stands
 * for the uncovered files it names and contributes that count instead: it is
 * one finding about N obligations, and reporting it as 1 would understate the
 * inherited debt by however many files it lists.
 */
export function countOutside(issues: CheckIssue[]): number {
  let count = 0;
  for (const issue of issues) {
    if (!OUTSIDE_CODES.has(issue.code)) continue;
    count += issue.uncoveredCount ?? 1;
  }
  return count;
}
