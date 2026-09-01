import type { CheckIssue } from '../core/check.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES, SCOPED_CODES, baseCodeOfOutsideTwin, outsideTwin } from '../core/check-codes.js';

/**
 * The same codes, plus the `-outside` twin of every one of them that a change
 * scope can actually produce a twin for.
 *
 * DERIVED, never hand-listed. Each of the three sets below decides how a code
 * renders — collapsed into one group, shown with its full actionable body, or
 * pulled out as a file-list block — and a twin that fell out of one silently
 * rendered worse than the finding it stands for: fragmented into a group per
 * aspect, truncated to its first line with the reviewer's reason gone, or
 * stripped of the file list that IS its content. A parallel hand-written list
 * of twins would drift from `SCOPED_CODES` the first time that set changed, so
 * the twins are computed from it here. A code that is not scoped has no twin
 * and contributes nothing, which is why the filter is not merely decorative.
 */
function withOutsideTwins(codes: readonly string[]): Set<string> {
  return new Set([...codes, ...codes.filter((c) => SCOPED_CODES.has(c)).map(outsideTwin)]);
}

/**
 * How a finding put outside the change reads: exactly what the finding it
 * mirrors reads, plus the one phrase that says whose business it is.
 *
 * DERIVED from the base code, never a second list of labels. A twin with no
 * label rule of its own falls through to the bottom of {@link getIssueLabel} and
 * renders as its raw code — `aspect-violation-enforced-outside` sitting beside
 * `unverified (not yet reviewed)` — which puts an internal identifier on a
 * person's screen and reads as a different, unexplained kind of finding rather
 * than a familiar one the change did not cause.
 */
export const OUTSIDE_LABEL_SUFFIX = ' (outside changes)';

export interface IssueGroup {
  code: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  label: string;
  pairCount: number;
  /**
   * How many DISTINCT graph nodes the group's members name. Zero for a
   * repo-level group — one whose members carry no node at all (the committed
   * agent-rules digest, an unreadable lock): counting a missing node as one
   * made those render "1 pairs · 1 nodes" and list an empty node bullet,
   * reporting a component that does not exist. The renderer keys off zero to
   * drop the node-shaped framing entirely.
   */
  nodeCount: number;
  /**
   * How many DISTINCT type-covered FILES the group's members name — a member
   * with no `nodePath` but a `file:`-prefixed `unitKey` (a nodeless pair-derived
   * issue; core/check.ts's emitPairIssue sets `unitKey` from `pair.unitKey`).
   * Deduped by unitKey (several aspects can share one file's unit key), so a
   * shared file counts once, not once per aspect. Zero when the feature is off
   * or no member is file-level — the header then keeps its pre-existing
   * "N pairs  M nodes" wording untouched (see the renderer's own byte-identical
   * contract).
   */
  fileCount: number;
  sharedWhy: string;
  sharedNext: string;
  perMemberReason: boolean;
  /**
   * True when the group's members carry ≥2 DISTINCT `next` values — the fix is
   * NODE-SPECIFIC (e.g. `log-entry-missing` → `yg log add --node X`,
   * `relation-undeclared-dependency` / architecture errors whose `next` names the
   * node). A single shared `Fix:` line (the alphabetically-first member's) would
   * mislead the agent: it fixes one node, re-runs, stays red. When set, the
   * renderer surfaces EACH member's own `next` beside its bullet instead.
   * False when every member shares one `next` (LLM refusals, unverified, etc.) —
   * those keep the collapsed single `Fix:` block.
   */
  divergentNext: boolean;
  /**
   * True when the group's members carry ≥2 DISTINCT `why` values (e.g.
   * `relation-target-forbidden` — allow-list-excludes vs default-deny). When set,
   * the renderer surfaces each member's own `why` rather than only the first's.
   */
  divergentWhy: boolean;
  members: CheckIssue[];
}

/**
 * Issue codes that group by CODE ONLY — all instances collapse into a single
 * group regardless of aspectId. The shared why+fix renders once; the aspect
 * is shown on each body line (`- <node>  aspect '<id>'`) instead of the
 * group header.
 *
 * `unverified` is the primary case: editing one aspect previously produced
 * N near-identical group blocks (one per aspect) with the same why+fix text.
 * Now they collapse into one block, with each line annotating its aspect.
 *
 * Its twin collapses the same way, and must: a run reporting inherited debt
 * typically carries far MORE unverified pairs than a blocking one, so leaving
 * `unverified-outside` to fragment into a block per aspect would push genuine
 * warnings past the section's overflow cap and out of view entirely.
 */
export const CODE_ONLY_GROUP_CODES = withOutsideTwins(['unverified']);

// ── Shared code-set constants ────────────────────────────────

/** Architecture-rule issue codes (relation, parent, type, port violations). */
const ARCHITECTURE_CODES = new Set(['relation-target-forbidden', 'parent-type-forbidden', 'type-undefined', 'port-missing-aspect', 'port-missing-consumes', 'port-undefined', 'consumes-without-ports']);

/** Strict-type enforcement issue codes. */
const STRICT_CODES = new Set(['type-strict-orphan', 'type-strict-misplaced', 'strict-overlap-conflict']);

/**
 * Codes whose `messageData.what` carries the actionable refusal detail (the
 * reviewer's reason / the deterministic violation list) on lines AFTER the first.
 * For these, the full multi-line `what` is rendered — truncating to line 1 would
 * hide the very thing the agent needs to fix the code, leaving plain `yg check`
 * strictly less informative than `yg aspect-test`. All other codes keep the
 * terse one-line summary.
 */
export const FULL_WHAT_CODES = withOutsideTwins([
  'aspect-violation-enforced',
  'aspect-violation-advisory',
  // The relation refusal's `what` carries the violation list (each
  // `<file>:<line> → undeclared dependency on <node>`) on lines after the
  // first; truncating to line 1 would hide which import in which file drives
  // the refusal — the very thing the agent needs to declare or remove.
  'relation-undeclared-dependency',
  // The live type-relation gate's `what` carries its sample-edges list (each
  // `<fromFile> -> <toFile>`, up to five, plus a remainder count) on lines
  // after the first; truncating to line 1 would hide exactly which imports
  // the agent needs to allow, graduate, or remove.
  'type-relation-forbidden',
]);

/**
 * Coverage issue codes the grouped SECTION renderers exclude from groupIssues and
 * render as their own file-list blocks (renderUnmappedBlock). Single-sourced here so
 * the portal worklist partitions identically, and so the details and --top views
 * decide the same way — each of those dispatches on THIS set rather than on its own
 * literal codes, which is what stopped a coverage finding's file list from being
 * truncated away in one view while rendering in another.
 *
 * The inherited half of a split coverage finding (`unmapped-files-outside`) belongs
 * here for the same reason its blocking half does: the file list IS the finding, and
 * the generic issue renderer shows only the first line of `what` — "N source files
 * not covered by any node." with every filename gone.
 *
 * NOTE, unchanged: renderTopBody does not EXCLUDE these from grouping the way the
 * section renderers do — the --top view renders coverage inside its priority cascade,
 * so a coverage finding can be one of the `n` blocks it shows. It consults this set
 * only to choose the block renderer.
 */
export const COVERAGE_GROUP_EXCLUDED_CODES = withOutsideTwins(['unmapped-files', 'uncovered-advisory']);

/**
 * The label `renderUnmappedBlock` heads a coverage block with. `uncovered-advisory`
 * is the non-blocking visibility tier and says so; everything else in
 * {@link COVERAGE_GROUP_EXCLUDED_CODES} is an unmapped-files finding.
 *
 * A coverage finding SPLIT by a change scope produces two of these blocks in one
 * report, and this is the only label either half gets — so the outside half
 * carries the same marker every other outside finding carries, derived the same
 * way (see {@link OUTSIDE_LABEL_SUFFIX}). Leaving it off was not merely terse:
 * both halves then rendered under the identical word, distinguishable only by
 * which severity section they happened to sit in, which is exactly the reading a
 * person scanning for their own work should not have to do.
 */
export function coverageBlockLabel(code: string): string {
  const baseCode = baseCodeOfOutsideTwin(code);
  if (baseCode !== undefined) return coverageBlockLabel(baseCode) + OUTSIDE_LABEL_SUFFIX;
  return code === 'uncovered-advisory' ? 'uncovered' : 'unmapped';
}

/**
 * Priority rank for an issue, mirroring computeSuggestedNext's §6 cascade so the
 * --top view surfaces the same issues the suggestedNext line points at, in the
 * same order. Lower rank = higher priority. Errors always outrank warnings.
 */
const ERROR_CODE_PRIORITY: string[] = [
  'lock-invalid',
  'log-entry-missing',
  'unverified',
  'aspect-violation-enforced',
  'prompt-too-large',
  'aspect-companion-runtime-error',
  'log-conflict',
  'log-integrity',
  'log-format',
];

export function issuePriorityRank(issue: CheckIssue): number {
  const idx = ERROR_CODE_PRIORITY.indexOf(issue.code);
  if (idx >= 0) return idx;
  // Unranked errors sub-rank by the SAME category cascade computeSuggestedNext
  // uses (core/check.ts §6 steps 6→8): structural → coverage → completeness →
  // any other error (this last bucket is where a variable-severity code like
  // tracked-file-gitignored lands when it is an error — it carries no dedicated
  // rank, same as unverified's non-ERROR_CODE_PRIORITY siblings), so the group
  // bare `--top` renders is the group the `Next:` line names. Within a category,
  // groupIssues tie-breaks alphabetically by label (= code); computeSuggestedNext
  // mirrors that same tie-break, so the two surfaces cannot drift. (lock-invalid
  // is structural AND explicitly ranked above — the idx>=0 branch already caught
  // it, so it never falls into the structural bucket here.)
  const base = ERROR_CODE_PRIORITY.length;
  if (issue.severity === 'error') {
    if (STRUCTURAL_CODES.has(issue.code)) return base;       // structural
    if (issue.code === 'unmapped-files') return base + 1;    // coverage
    if (COMPLETENESS_CODES.has(issue.code)) return base + 2; // completeness
    return base + 3;                                          // any other error
  }
  // Warnings always last, and a `-outside` twin sub-ranks after every ORDINARY
  // warning — an aspect-violation-advisory, a review-cadence overdue notice, a
  // `tracked-file-gitignored` sitting outside `coverage.required` — rather than
  // sharing their rank and falling back to alphabetical label order. A twin's
  // label is exactly its mirror's label plus a suffix (getIssueLabel), so an
  // early-alphabet base code (e.g. `aspect-violation-enforced`, label
  // "enforced") used to sort its twin AHEAD of an unrelated warning whose own
  // label happens to sort later (e.g. "tracked-file-gitignored") — burying a
  // finding the change IS accountable for beneath debt it merely inherited. A
  // run whose only warnings are inherited debt must not make that debt look
  // more urgent than a genuine warning would; sub-ranking twins last fixes the
  // GROUP order the full/`--top` views render (the standing "Next:" line for a
  // warnings-only run already has its own carve-out — see
  // check-suggested-next.ts's standingOutsideLine — this is the other half of
  // the same concern, for the body above that line).
  if (baseCodeOfOutsideTwin(issue.code) !== undefined) return base + 5;
  return base + 4;
}

export function getIssueLabel(issue: CheckIssue): string {
  // An outside twin borrows its mirror's label, whatever that turns out to be —
  // including a future label rule added for the base code alone.
  const baseCode = baseCodeOfOutsideTwin(issue.code);
  if (baseCode !== undefined) {
    return getIssueLabel({ ...issue, code: baseCode }) + OUTSIDE_LABEL_SUFFIX;
  }

  // Verdict-lock states (spec §10).
  if (issue.code === 'unverified') return 'unverified';
  if (issue.code === 'prompt-too-large') return 'prompt-too-large';
  if (issue.code === 'lock-invalid') return 'lock-invalid';
  if (issue.code === 'aspect-violation-advisory') return 'advisory';
  if (issue.code === 'aspect-violation-enforced') return 'enforced';
  if (issue.code === 'log-conflict') return 'log-conflict';
  if (issue.code === 'log-integrity') return 'log-integrity';
  if (issue.code === 'log-format') return 'log-format';
  if (STRUCTURAL_CODES.has(issue.code)) return issue.code;
  if (ARCHITECTURE_CODES.has(issue.code)) return issue.code;
  if (COMPLETENESS_CODES.has(issue.code)) return issue.code;
  if (STRICT_CODES.has(issue.code)) return issue.code;
  return issue.code;
}

export function groupIssues(issues: CheckIssue[]): IssueGroup[] {
  const byKey = new Map<string, CheckIssue[]>();
  for (const i of issues) {
    const key = CODE_ONLY_GROUP_CODES.has(i.code)
      ? i.code
      : (i.aspectId !== undefined ? `${i.code} ${i.aspectId}` : i.code);
    const arr = byKey.get(key) ?? [];
    arr.push(i);
    byKey.set(key, arr);
  }
  const groups: IssueGroup[] = [];
  for (const members of byKey.values()) {
    // Sort key: nodePath when present, else the nodeless member's OWN unitKey
    // (never collapsed to '' — file members then sort among themselves by
    // path, rather than all comparing equal and falling back to insertion
    // order). A genuinely repo-level member (neither) still sorts to ''.
    const sorted = [...members].sort((a, b) =>
      (a.nodePath ?? a.unitKey ?? '').localeCompare(b.nodePath ?? b.unitKey ?? '', 'en'));
    const rep = sorted[0];
    // Only members that actually name a node count toward nodeCount; a
    // repo-level group scores 0 rather than 1-for-nothing.
    const nodes = new Set(sorted.filter((m) => m.nodePath).map((m) => m.nodePath));
    // Nodeless members with a `file:`-prefixed unitKey count toward fileCount
    // instead — deduped by unitKey (several aspects can share one file).
    const files = new Set(
      sorted.filter((m) => m.nodePath === undefined && m.unitKey?.startsWith('file:')).map((m) => m.unitKey),
    );
    // For code-only groups the aspectId spans multiple aspects — set to
    // undefined so the group header does NOT print `aspect '<id>'`.
    const isCodeOnly = CODE_ONLY_GROUP_CODES.has(rep.code);
    // Detect whether the per-node fix (next) and/or rationale (why) diverge across
    // members. ≥2 distinct values means the shared single block (the first
    // member's) would misrepresent the others — render per-member instead.
    const distinctNext = new Set(sorted.map((m) => m.messageData.next ?? ''));
    const distinctWhy = new Set(sorted.map((m) => m.messageData.why ?? ''));
    groups.push({
      code: rep.code,
      aspectId: isCodeOnly ? undefined : rep.aspectId,
      severity: rep.severity,
      label: getIssueLabel(rep),
      pairCount: sorted.length,
      nodeCount: nodes.size,
      fileCount: files.size,
      sharedWhy: rep.messageData.why,
      sharedNext: rep.messageData.next,
      perMemberReason: FULL_WHAT_CODES.has(rep.code),
      divergentNext: distinctNext.size > 1,
      divergentWhy: distinctWhy.size > 1,
      members: sorted,
    });
  }
  groups.sort((a, b) => {
    const ra = issuePriorityRank(a.members[0]);
    const rb = issuePriorityRank(b.members[0]);
    if (ra !== rb) return ra - rb;
    if (a.label !== b.label) return a.label.localeCompare(b.label, 'en');
    return (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en');
  });
  return groups;
}
