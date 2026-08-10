import type { CheckIssue } from '../core/check.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from '../core/check-codes.js';

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
 */
export const CODE_ONLY_GROUP_CODES = new Set(['unverified']);

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
export const FULL_WHAT_CODES = new Set([
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
 * the portal worklist partitions identically. NOTE: renderTopBody deliberately does
 * NOT use this set — the --top view renders coverage inside its cascade.
 */
export const COVERAGE_GROUP_EXCLUDED_CODES = new Set(['unmapped-files', 'uncovered-advisory']);

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
  // Warnings always last.
  return base + 4;
}

export function getIssueLabel(issue: CheckIssue): string {
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
