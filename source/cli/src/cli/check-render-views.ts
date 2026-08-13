// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { ZERO_CLASSIFYING_TYPES_NOTICE, OUTSIDE_CODES } from '../core/check-codes.js';
import { groupIssues, issuePriorityRank, COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel, type IssueGroup } from './group-issues.js';
import { renderHeader, useEmoji, renderTypeVisibilityBlock, renderChangeScope, renderByteGuardNotice } from './check-render-header.js';
import { renderErrorSection, renderWarningSection, renderDetailsSection, renderUnmappedBlock, renderGroup } from './check-render-groups.js';
import { toPosixPath } from '../utils/posix.js';

// ── Output formatting ──────────────────────────────────────

/**
 * Read-only render mode for `yg check`. Selected by --top / --summary; the
 * --approve path always uses `full`. EVERY view renders the same header with the
 * TRUE error/warning counts and keeps the single `Next:` line — only the body
 * (which issue blocks, if any, are rendered) changes. The exit code is computed
 * outside this function from the full issue set, so no view can read as green.
 *   - full    : header + every error/warning block grouped by (code, aspectId)
 *               + Next. Default view.
 *   - details : header + every error/warning block ungrouped (one block per
 *               issue, old per-pair style) + Next. Opposite of full.
 *   - top  n  : header + at most n highest-priority GROUPS in suggestedNext
 *               priority order + Next. Bare --top maps to n = 1 (the single
 *               suggested-next group); a subheader with TRUE count > 0 but no
 *               chosen groups is annotated, never left dangling.
 *   - summary : header + per-node aggregate counts + Next (no per-issue blocks).
 *   - aspect  : header + issue group for the named aspect only + Next.
 */
export type CheckView = { kind: 'full' } | { kind: 'top'; n: number } | { kind: 'summary' } | { kind: 'details' } | { kind: 'aspect'; id: string };

/**
 * Parse a raw --top value into a block count, or null on garbage.
 *   - undefined  → caller treats as absent (full view); tolerated → 0.
 *   - true       → bare `--top` (commander gives boolean true for an optional
 *                  arg supplied with no value) → 1 (the single suggested-next
 *                  group — the same group the `Next:` line draws from).
 *   - "<int≥1>"  → that integer (the number of GROUPS to render).
 *   - "0"        → null (guided error): an EXPLICIT `--top 0` is meaningless
 *                  garbage — it would render zero groups. For the single
 *                  suggested-next group, pass bare `--top` (which maps to 1).
 *   - NaN / negative / fractional / non-numeric → null (guided error).
 * NOTE: commander 15 yields boolean `true` (not a registered default) for a bare
 * `--top`, so the caller branches on `typeof opts.top`; this mirrors that here.
 */
export function resolveTopValue(raw: boolean | string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw === true) return 1; // bare --top → the single suggested-next group
  if (raw === false) return null; // not a shape commander produces here, but be explicit
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // rejects negatives, decimals, "abc", ""
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1) return null; // explicit "0" is garbage; bare --top (→ 1) is the single-group path
  return n;
}

/**
 * The `Next:` footer (and the `Next (this group):` triage line) normally shows
 * only the FIRST line of an issue's `next` — the actionable command, with the
 * trailing explanation trimmed. That assumes line 1 stands alone. It does not
 * for a heading-introduced list such as a refusal's `Three exits:\n  1. …\n
 * 2. …`, where line 1 is a bare heading and the actionable content is the lines
 * beneath it. Truncating there dead-ends the reader on `Next: Three exits:` with
 * nothing after the colon. Rule: a first line that ends in `:` is a heading, so
 * surface the WHOLE block; otherwise keep the terse first-line-only form.
 */
function nextPointer(next: string): string {
  const firstLine = next.split('\n')[0];
  return firstLine.trimEnd().endsWith(':') ? next : firstLine;
}

/**
 * When `result.suggestedNext` starts with `yg check --approve` AND there is at
 * least one error whose code is NOT `unverified` (i.e. refused/relation/
 * structural/etc.), returns a parenthetical annotating partial coverage:
 *   (fills <N> unverified; <K> errors remain — need code/graph fixes)
 * where N = count of error issues with code `unverified` AND the fillable
 * `next` ('yg check --approve' — that pair can still change), K = every
 * other error, INCLUDING an `unverified` one whose `next` already names its
 * own real remedy (`cannotRunUnverifiedMessage` — `core/type-visibility.ts`):
 * re-running `--approve` reproduces that pair's identical result, so it
 * belongs in "errors remain — need code/graph fixes", never in the count
 * this line promises `--approve` will fill. Otherwise returns ''.
 */
function residualAfterNext(result: CheckResult): string {
  if (!result.suggestedNext?.startsWith('yg check --approve')) return '';
  const errors = result.issues.filter(i => i.severity === 'error');
  const N = errors.filter(i => i.code === 'unverified' && i.messageData.next === 'yg check --approve').length;
  const K = errors.length - N;
  if (K === 0) return '';
  return `  (fills ${N} unverified; ${K} error${K === 1 ? '' : 's'} remain — need code/graph fixes)`;
}

export function formatOutput(result: CheckResult, view: CheckView = { kind: 'full' }, autoFilled = false, emoji = useEmoji): string {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  // isTTY controls node-list truncation inside groups (CAP_NODES per group).
  const opts = { isTTY: process.stdout.isTTY ?? false };

  // Header ALWAYS uses the full counts — in every view. Only the body changes.
  const header = renderHeader(result, errors.length, warnings.length, autoFilled, emoji);
  const sections: string[] = [header];

  // Standing config fact, not an issue — printed ahead of every view.
  if (result.typeLevel && (result.classifyingTypeCount ?? 0) === 0) {
    sections.push('');
    sections.push(chalk.dim(ZERO_CLASSIFYING_TYPES_NOTICE));
  }

  // The content check's own statement of fact, same posture as the notice above
  // and printed in every view (the --aspect drill-in replaces only sections[0],
  // so this survives it). Absent entirely on a run that met neither of the two
  // states it reports, which is every ordinary run.
  const byteGuardNotice = renderByteGuardNotice(result);
  if (byteGuardNotice !== undefined) {
    sections.push('');
    sections.push(chalk.dim(byteGuardNotice));
  }

  // Type-visibility: a statement of fact about the type tier's own coverage,
  // not an issue — printed ahead of every view, same posture as the notice
  // above. The two triage views (--summary, --top) exist to keep the wall
  // short, so this block stays to counts there too — never the full per-
  // aspect reason breakdown a narrowed view is supposed to avoid.
  if (result.typeVisibility && result.typeVisibility.byType.length > 0) {
    sections.push('');
    const countsOnly = view.kind === 'summary' || view.kind === 'top';
    sections.push(renderTypeVisibilityBlock(result, { countsOnly }));
  }

  if (view.kind === 'summary' || view.kind === 'top') {
    // Both triage views ALWAYS print the aggregate Errors(N)/Warnings(N)
    // subheaders with the TRUE totals — only the body beneath them changes
    // (per-node counts for summary; up-to-n priority blocks for top). This is
    // what stops a truncated view from reading as a clean build.
    const body = view.kind === 'summary'
      ? renderSummaryBody(errors, warnings)
      : renderTopBody(errors, warnings, view.n, opts);
    // A top-view section can carry a TRUE count > 0 while the slice chose none
    // of its groups; annotate it rather than leave the subheader dangling.
    // (Summary bodies are never empty when their count is > 0.)
    if (errors.length > 0) {
      sections.push('');
      const errPrefix = emoji ? '❌ ' : '';
      sections.push(chalk.red(`${errPrefix}Errors (${errors.length}):`));
      if (body.errorLines) {
        sections.push(body.errorLines);
      } else if (view.kind === 'top') {
        sections.push(topEmptySectionNote('error', view.n));
      }
    }
    if (warnings.length > 0) {
      sections.push('');
      const warnPrefix = emoji ? '⚠️ ' : '';
      sections.push(chalk.yellow(`${warnPrefix}Warnings (${warnings.length}):`));
      if (body.warningLines) {
        sections.push(body.warningLines);
      } else if (view.kind === 'top') {
        sections.push(topEmptySectionNote('warning', view.n));
      }
    }
  } else if (view.kind === 'aspect') {
    // --aspect <id>: drill-in view — show ONLY issues for the named aspect,
    // grouped, with the full node list (no truncation). The TRUE total error
    // count (N) stays visible in the header line so the user knows how much
    // of the total wall this aspect represents.
    const drillOpts = { isTTY: false }; // never truncate in drill-in
    const filtered = result.issues.filter(i => i.aspectId === view.id);
    const filteredErrors = filtered.filter(i => i.severity === 'error');
    const filteredWarnings = filtered.filter(i => i.severity === 'warning');
    const K = filteredErrors.length;
    const N = errors.length;
    // Verdict word mirrors renderHeader logic: FAIL if total errors > 0, else PASS.
    const verdictWord = errors.length > 0 ? chalk.red('FAIL') : chalk.green('PASS');
    // Emoji prefix mirrors renderHeader: same gate (chalk.level > 0) and same symbols.
    const aspectEmojiPrefix = emoji ? (errors.length > 0 ? '❌ ' : '✅ ') : '';
    // Replace the header already added with the aspect-scoped header line — but
    // reprint the progressive qualifier the plain header would have carried
    // (same computation, same TRUE total N, never a second aspect-scoped
    // tally): a project measuring changes against a reference otherwise loses
    // that fact the moment anyone drills into one aspect, silently discarding
    // it along with the rest of `sections[0]`.
    const changeScope = renderChangeScope(result, N);
    const changeScopeSeg = changeScope !== undefined ? `  ·  ${changeScope}` : '';
    sections[0] = `${aspectEmojiPrefix}${verdictWord}  (aspect '${view.id}' — ${K} of ${N} errors)${changeScopeSeg}`;
    if (filteredErrors.length > 0) {
      sections.push('');
      sections.push(renderErrorSection(filteredErrors, drillOpts));
    }
    if (filteredWarnings.length > 0) {
      sections.push('');
      sections.push(renderWarningSection(filteredWarnings, drillOpts));
    }
    // Next (this group): the first line of the highest-priority filtered issue's next.
    // Pick by the same priority cascade computeSuggestedNext and groupIssues use —
    // not raw emission order — so the drill-in pointer cannot disagree with the
    // global Next when a lower-priority issue happens to be emitted first. Stable
    // min-by: strict `<` keeps the first-encountered on equal rank.
    //
    // A finding put OUTSIDE the change can never be that pointer, and is dropped
    // before the pick rather than ranked down. Its `messageData` is deliberately
    // untouched by the classifier (check-progressive.ts's `toOutsideTwin`), so its
    // `next` still reads as the remedy for the finding it mirrors — `yg check
    // --approve`, which reviews the WHOLE project rather than this one pair, on a
    // run that has just declined to hold this change accountable for it. Every
    // other surface already refuses to say that: the group renderer suppresses the
    // Fix: line on a twin in all four of its shapes (check-render-groups.ts's
    // `isOutsideFinding`), and the run's bottom line points at the audit instead
    // (check-suggested-next.ts's `standingOutsideLine`). With nothing left after
    // the filter, this view falls through to that same standing line below —
    // which is the honest answer, and is also what a scoped recording run does:
    // it declines out-of-scope work, so the advice would not even act.
    const combined = [...filteredErrors, ...filteredWarnings].filter((i) => !OUTSIDE_CODES.has(i.code));
    const firstFiltered =
      combined.length > 0
        ? combined.reduce((best, cur) => (issuePriorityRank(cur) < issuePriorityRank(best) ? cur : best))
        : undefined;
    if (firstFiltered?.messageData.next) {
      const nextCmd = nextPointer(firstFiltered.messageData.next);
      sections.push('');
      sections.push(`Next (this group): ${nextCmd}`);
      sections.push('');
      return sections.join('\n');
    }
    // Nothing left to point at — this aspect has zero issues THIS run, or every
    // one of them was put outside the change: do NOT dead-end. Fall through to
    // the global `result.suggestedNext` block below so the agent still gets a
    // next step pointing at the rest of the wall (the audit when everything here
    // is inherited; whatever else remains when other errors do). With no global
    // suggestedNext (a clean run) nothing prints — self-evidently done. The
    // aspect-scoped header (K of N) is already in place either way.
  } else if (view.kind === 'details') {
    // --details: ungrouped, one block per issue, grouped only by severity into
    // Errors(N): / Warnings(N): sections. Coverage issues still render via
    // renderUnmappedBlock. No (code,aspectId) collapsing.
    if (errors.length > 0) {
      sections.push('');
      const errPrefix = emoji ? '❌ ' : '';
      sections.push(chalk.red(`${errPrefix}Errors (${errors.length}):`));
      sections.push(renderDetailsSection(errors, 'error'));
    }
    if (warnings.length > 0) {
      sections.push('');
      const warnPrefix = emoji ? '⚠️ ' : '';
      sections.push(chalk.yellow(`${warnPrefix}Warnings (${warnings.length}):`));
      sections.push(renderDetailsSection(warnings, 'warning'));
    }
  } else {
    if (errors.length > 0) {
      sections.push('');
      sections.push(renderErrorSection(errors, opts, emoji));
    }
    if (warnings.length > 0) {
      sections.push('');
      sections.push(renderWarningSection(warnings, opts, emoji));
    }
  }

  if (result.suggestedNext) {
    // Render the Next line whenever computeSuggestedNext produced one — including a
    // warnings-only PASS, where it falls back to the first advisory aspect-violation
    // warning's `next`. A FULLY-GREEN run (no errors, no warnings) yields a null
    // suggestedNext and prints no Next line — a clean run is self-evidently done.
    // Show only the first line — the actionable command, without annotation text
    // — UNLESS that first line is a heading introducing a list (e.g. a refusal's
    // "Three exits:"), where the whole block IS the actionable content.
    const nextCmd = nextPointer(result.suggestedNext);
    // In the full view, annotate the Next line when --approve will only partially
    // clear errors (some refused/structural/relation errors remain after filling
    // unverified pairs). Triage views (top/summary) are already narrowed — they
    // do not annotate to avoid double-messaging.
    const residual = (view.kind === 'full' || view.kind === 'details') ? residualAfterNext(result) : '';
    sections.push('');
    sections.push(`Next: ${nextCmd}${residual}`);
  }

  sections.push('');
  return sections.join('\n');
}

// ── Top view: prioritized blocks ───────────────────────────

/** A triage-view body split by severity, so each block lands under its
 *  aggregate Errors(N)/Warnings(N) subheader (rendered by formatOutput). */
interface ViewBody { errorLines: string; warningLines: string }

/**
 * Render at most `n` highest-priority GROUPS in priority order (errors before
 * warnings), splitting the chosen groups by severity so each lands under its
 * aggregate Errors(N)/Warnings(N) subheader. Each group is rendered via
 * renderGroup so the node list, shared why/fix, and per-member detail all appear.
 * n <= 0 renders no groups (defensive — the CLI never produces n < 1: bare
 * --top maps to 1, explicit "0" is a guided error); formatOutput then
 * annotates each non-empty section via topEmptySectionNote.
 *
 * Priority is taken from the group's representative member (groupIssues already
 * sorts by representative priority). The combined list of error groups followed
 * by warning groups is sliced at n; sliced groups are then split by severity
 * for the two subheaders.
 */
function renderTopBody(errors: CheckIssue[], warnings: CheckIssue[], n: number, opts: { isTTY: boolean }): ViewBody {
  if (n <= 0) return { errorLines: '', warningLines: '' };
  // groupIssues returns groups sorted by representative priority within each
  // severity. Errors always outrank warnings, so combine errors first.
  const errorGroups = groupIssues(errors);
  const warningGroups = groupIssues(warnings);
  const allGroups = [...errorGroups, ...warningGroups];
  const chosenGroups = allGroups.slice(0, n);
  const chosenErrors = chosenGroups.filter(g => g.severity === 'error');
  const chosenWarnings = chosenGroups.filter(g => g.severity === 'warning');
  const renderOneGroup = (g: IssueGroup): string => {
    const lines: string[] = [];
    // Same shared coverage set the full and details views dispatch on, so a
    // coverage finding cannot render as a file-list block in one view and as a
    // truncated one-liner in another.
    if (COVERAGE_GROUP_EXCLUDED_CODES.has(g.code)) {
      renderUnmappedBlock(g.members[0], lines, coverageBlockLabel(g.code));
    } else {
      renderGroup(g, lines, opts);
    }
    return lines.join('\n');
  };
  // Lead each group block with a blank line (separating it from the subheader
  // and from the preceding block), matching the full-view spacing.
  const lead = (groups: IssueGroup[]): string => groups.map(g => `\n${renderOneGroup(g)}`).join('\n');
  return { errorLines: lead(chosenErrors), warningLines: lead(chosenWarnings) };
}

/**
 * Annotation beneath a --top subheader whose TRUE count is > 0 but whose slice
 * chose no groups of that severity (e.g. --top 1 where the top group is an
 * error, so no warning group made the slice). Indented FOUR spaces on purpose:
 * group blocks start at a two-space indent and block-counting parsers key on
 * that — the annotation must never register as a group block.
 */
function topEmptySectionNote(kind: 'error' | 'warning', n: number): string {
  return chalk.dim(`    (no ${kind} groups within --top ${n} — run yg check for the full list)`);
}

// ── Summary view: per-node aggregate counts ────────────────

/**
 * Render per-node aggregate counts only — no per-issue blocks, no Why:/Fix:
 * lines. Each node line reports its pair states split by reviewer kind plus a
 * refused tally; NON-PAIR errors (coverage / log / relation / structural — no
 * pairKind) are bucketed per node as "other" so the per-node totals reconcile
 * with the true header Errors(N)/Warnings(N) counts and are NEVER silently
 * dropped. Rows are split by severity so each lands under its aggregate
 * subheader; a node with both error and warning issues appears under both.
 */
function renderSummaryBody(errors: CheckIssue[], warnings: CheckIssue[]): ViewBody {
  return { errorLines: renderSummaryRows(errors), warningLines: renderSummaryRows(warnings) };
}

function renderSummaryRows(issues: CheckIssue[]): string {
  if (issues.length === 0) return '';

  interface NodeAgg {
    unverifiedDet: number;
    unverifiedLlm: number;
    refused: number;
    /**
     * Findings put outside the change — a `-outside` twin, whatever code it
     * mirrors. Bucketed BEFORE the unverified/refused checks below (which key
     * on the untwinned codes, e.g. `unverified`, and would otherwise never
     * match a twin's OWN code, e.g. `unverified-outside`) so a run with
     * inherited debt does not fold every twin into "other" beside genuinely
     * unclassified findings — indistinguishable from real, in-scope debt this
     * change actually owes.
     */
    outside: number;
    other: number;
  }
  const byNode = new Map<string, NodeAgg>();
  const agg = (node: string): NodeAgg => {
    let a = byNode.get(node);
    if (!a) {
      a = { unverifiedDet: 0, unverifiedLlm: 0, refused: 0, outside: 0, other: 0 };
      byNode.set(node, a);
    }
    return a;
  };

  for (const issue of issues) {
    // A file-level (nodeless) pair-derived issue rows under its OWN file path —
    // collapsing it into '(repo)' would fold the whole type-covered tier into
    // one undifferentiated row. '(repo)' keeps its meaning for an issue with
    // NEITHER a component nor a file unit (a stale digest, an unreadable lock).
    const node = issue.nodePath
      ?? (issue.unitKey?.startsWith('file:') ? toPosixPath(issue.unitKey.slice('file:'.length)) : '(repo)');
    const a = agg(node);
    if (OUTSIDE_CODES.has(issue.code)) {
      // Count by ISSUE OBJECT, matching "other" below — the aggregate coverage
      // twin's own `uncoveredCount` is a DIFFERENT number (how many files it
      // names), not how many issue objects the header counted.
      a.outside += 1;
    } else if (issue.code === 'unverified') {
      if (issue.pairKind === 'deterministic') a.unverifiedDet++;
      else if (issue.pairKind === 'llm') a.unverifiedLlm++;
      else a.other++; // unverified without a pairKind should not occur, but never drop it
    } else if (issue.code === 'aspect-violation-enforced' || issue.code === 'aspect-violation-advisory') {
      a.refused++;
    } else {
      // Non-pair errors/warnings (coverage / log / relation / structural /
      // unmapped / uncovered-advisory): bucket as "other" so totals reconcile.
      // Count by ISSUE OBJECT, not file count — the header Errors(N)/Warnings(N)
      // counts each aggregate coverage issue (e.g. one unmapped-files issue with
      // uncoveredCount=7) as ONE, so the per-node "other" bucket must too, or the
      // summary would over-count and not reconcile with the header.
      a.other += 1;
    }
  }

  const lines: string[] = [];
  for (const node of [...byNode.keys()].sort((x, y) => x.localeCompare(y, 'en'))) {
    const a = byNode.get(node)!;
    const unverified = a.unverifiedDet + a.unverifiedLlm;
    const parts: string[] = [];
    parts.push(`${unverified} unverified (${a.unverifiedDet} deterministic-free, ${a.unverifiedLlm} LLM)`);
    parts.push(`${a.refused} refused`);
    if (a.outside > 0) parts.push(`${a.outside} outside changes`);
    if (a.other > 0) parts.push(`${a.other} other`);
    lines.push(`  ${node}  ${parts.join(', ')}`);
  }
  return lines.join('\n');
}
