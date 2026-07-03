import type { CheckIssue } from '../core/check.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from '../core/check-codes.js';

export interface IssueGroup {
  code: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  label: string;
  pairCount: number;
  nodeCount: number;
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
]);

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
  'mapped-file-gitignored',
];

export function issuePriorityRank(issue: CheckIssue): number {
  const idx = ERROR_CODE_PRIORITY.indexOf(issue.code);
  if (idx >= 0) return idx;
  // Unranked errors sub-rank by the SAME category cascade computeSuggestedNext
  // uses (core/check.ts §6 steps 7→9): structural → coverage → completeness →
  // any other error, so the group bare `--top` renders is the group the `Next:`
  // line names. Within a category, groupIssues tie-breaks alphabetically by
  // label (= code); computeSuggestedNext mirrors that same tie-break, so the two
  // surfaces cannot drift. (lock-invalid / mapped-file-gitignored are structural
  // AND explicitly ranked above — the idx>=0 branch already caught them, so they
  // never fall into the structural bucket here.)
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
    const sorted = [...members].sort((a, b) =>
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
    const rep = sorted[0];
    const nodes = new Set(sorted.map((m) => m.nodePath ?? ''));
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
