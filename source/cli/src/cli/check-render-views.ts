// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { ZERO_CLASSIFYING_TYPES_NOTICE, FEATURE_INDEX_NOT_IGNORED_NOTICE, OUTSIDE_CODES } from '../core/check-codes.js';
import { groupIssues, issuePriorityRank, getIssueLabel, COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel, type IssueGroup } from './group-issues.js';
import { renderHeader, useEmoji, renderTypeVisibilityBlock, renderChangeScope, renderByteGuardNotice, renderBaselineNoiseNotice, renderCoverageRequiresNothingNotice, renderExternalJudgesNotice } from './check-render-header.js';
import { renderErrorSection, renderWarningSection, renderDetailsSection, renderUnmappedBlock, renderGroup, type GroupRenderOptions } from './check-render-groups.js';
import { GRAPH_INVALID_CODES } from './output-diagnostic.js';
import { count, MEMBER_CAP, verdict, next as nextLine, fixPointer } from './output.js';
import type { CheckJsonDocument, CheckJsonGroup, CheckJsonIssue } from '../formatters/check-json.js';
import { toPosixPath } from '../utils/posix.js';

// ── Output formatting ──────────────────────────────────────

/**
 * Read-only render mode for `yg check`. Selected by --top / --summary; the
 * --approve path always uses `full`. EVERY view renders the same header with the
 * TRUE error/warning counts and keeps the single `Next:` line — only the body
 * (which issue blocks, if any, are rendered) changes. The exit code is computed
 * outside this function from the full issue set, so no view can read as green.
 *
 * Orthogonal to all of it: the type-coverage listing, governed by its own
 * `--coverage` flag (`CheckRenderOptions` below), never by the view.
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
 * The second, INDEPENDENT axis of the report: how much of the type tier's own
 * coverage the run enumerates. `coverage` is `--coverage` — off by default, on
 * in every mode the flag is passed to, including the writer path (`--approve`),
 * which is the surface the flag exists for.
 *
 * Why it is its own axis and not another `CheckView`: the view flags narrow the
 * ISSUE set (which blocks render, and how they group). The coverage listing is
 * not an issue — it is a statement of fact about what the type tier covers and
 * what it enforces — so asking for it can never narrow, re-group, or hide a
 * finding, never moves a count, and never touches the exit code. That is also
 * why it is legal alongside `--approve`/`--only-deterministic` while the view
 * flags are refused there (see check.ts): widening a statement of fact on a
 * writer run cannot make the run read as a smaller problem.
 */
export interface CheckRenderOptions {
  /** `--coverage`: render the per-type coverage listing. Default false — the plain report is the verdict and what it found. */
  coverage?: boolean;
}

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
  // A deterministic pair with no local result names the free
  // `--approve --only-deterministic`, which the suggested `--approve` fills too.
  const N = errors.filter(i => i.code === 'unverified' && i.messageData.next.startsWith('yg check --approve')).length;
  const K = errors.length - N;
  if (K === 0) return '';
  return `  (fills ${N} unverified; ${K} error${K === 1 ? '' : 's'} remain — need code/graph fixes)`;
}

export function formatOutput(result: CheckResult, view: CheckView = { kind: 'full' }, autoFilled = false, emoji = useEmoji, render: CheckRenderOptions = {}): string {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  // Member lists are capped by the VIEW, in every sink: a pipe (an agent, CI)
  // gets the same bounded report a terminal does, each cut list ending in the
  // command that shows the rest. Only the drill-in and per-issue views show
  // every member.
  const opts: GroupRenderOptions = { capMembers: true };

  // Header ALWAYS uses the full counts — in every view. Only the body changes.
  const header = renderHeader(result, errors.length, warnings.length, autoFilled, emoji);
  const sections: string[] = [header];

  // The graph did not load as written: say so before anything else, in every
  // view, because everything below was computed without the part that failed.
  const partial = renderPartialResultBanner(result);
  if (partial !== undefined) {
    sections.push('');
    sections.push(chalk.yellow(partial));
  }

  // Standing config fact, not an issue — printed ahead of every view. Withheld
  // while yg-architecture.yaml failed to load: its types were not read at all,
  // so "no type declares when:" would be a claim about a file nobody looked at.
  const architectureUnloaded = result.issues.some((i) => i.code === 'architecture-invalid');
  if (result.typeLevel && (result.classifyingTypeCount ?? 0) === 0 && !architectureUnloaded) {
    sections.push('');
    sections.push(chalk.dim(ZERO_CLASSIFYING_TYPES_NOTICE));
  }

  // The content check's own statement of fact, same posture as the notice above
  // and printed in every view (the --aspect drill-in replaces only sections[0],
  // so this survives it). Absent entirely on a run that met neither of the two
  // states it reports, which is every ordinary run.
  if (result.featureIndexNotIgnored) {
    sections.push('');
    sections.push(chalk.dim(FEATURE_INDEX_NOT_IGNORED_NOTICE));
  }

  const byteGuardNotice = renderByteGuardNotice(result);
  if (byteGuardNotice !== undefined) {
    sections.push('');
    sections.push(chalk.dim(byteGuardNotice));
  }

  // Two more standing statements of fact, same posture as the notices above and
  // printed in every view: what this report holds that the change did not
  // cause, and the coverage setting whose consequence the report cannot show.
  // Neither is an issue, neither is counted, neither ever blocks.
  const baselineNotice = renderBaselineNoiseNotice(result);
  if (baselineNotice !== undefined) {
    sections.push('');
    sections.push(chalk.dim(baselineNotice));
  }

  const coverageNotice = renderCoverageRequiresNothingNotice(result);
  if (coverageNotice !== undefined) {
    sections.push('');
    sections.push(chalk.dim(coverageNotice));
  }

  // Who judged, when the judge was not the configured reviewer — the same
  // posture as the notices above: a standing statement of fact, printed in every
  // view, never an issue and never counted.
  const judgesNotice = renderExternalJudgesNotice(result);
  if (judgesNotice !== undefined) {
    sections.push('');
    sections.push(chalk.dim(judgesNotice));
  }

  // Type-visibility: a statement of fact about the type tier's own coverage,
  // not an issue — and, since 6.0.0, printed ONLY when asked for by name
  // (--coverage). It answers "which files does which type claim, and what
  // actually runs on them" — a question asked when the type map is written or
  // changed, not on every run. On a repo with 20 classifying types it was 122
  // of the default report's 138 lines, which buried the verdict and the
  // warnings under paths nobody reads on a green run. Nothing is lost by the
  // move: every count it carries is derived from the same run either way, and
  // the one state in it that is a genuine fault — a type whose rules could not
  // be worked out at all, an aspect `implies` cycle — is ALSO a blocking
  // `aspect-implies-cycle` error that the default report still prints, counts,
  // and fails on. What went behind the flag is enumeration, never a finding.
  //
  // Deliberately NOT conditioned on anything else — in particular not on "the
  // type map changed since last run" (io/type-class-cache.ts already computes
  // an `architecturePredicateHash` that would make that cheap to detect).
  // Output that varies with local state is output two people on one commit do
  // not share, and a fresh CI checkout — the surface this change is most for —
  // has no previous run at all, so it would get the long form every time. A
  // gate says the same thing to everyone; a flag the reader types is how they
  // ask for more.
  //
  // Under --coverage the two triage views (--summary, --top) still hold it to
  // counts: those views exist to keep the wall short, and asking for coverage
  // inside one asks for the per-type figures, not the per-aspect reason
  // breakdown, bundle names, chain-termination text, or file samples.
  if (render.coverage && result.typeVisibility && result.typeVisibility.byType.length > 0) {
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
    const drillOpts: GroupRenderOptions = { capMembers: false }; // the drill-in shows every member
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

// ── Machine document extras ────────────────────────────────

/**
 * Add to a yg-check/1 document what only the command layer knows: each
 * finding's text-report label, the text report's groups (the shared why and
 * fix stated once, members as indexes into `issues`), and the partial-result
 * banner. Additive — every field the document already had is untouched.
 */
export function enrichCheckJson(doc: CheckJsonDocument, result: CheckResult): CheckJsonDocument {
  // The label the text report heads the finding with: a coverage finding's
  // block label, every other finding's group label.
  const labelOf = (issue: CheckIssue): string =>
    COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code) ? coverageBlockLabel(issue.code) : getIssueLabel(issue);
  const index = new Map<CheckIssue, number>();
  result.issues.forEach((issue, i) => {
    index.set(issue, i);
    doc.issues[i].label = labelOf(issue);
  });
  const groups: CheckJsonGroup[] = [];
  for (const severity of ['error', 'warning'] as const) {
    for (const g of groupIssues(result.issues.filter((i) => i.severity === severity))) {
      groups.push({
        code: g.code,
        label: labelOf(g.members[0]),
        aspect: g.aspectId ?? null,
        severity,
        why: g.divergentWhy ? null : g.sharedWhy,
        next: g.divergentNext ? null : g.sharedNext,
        members: g.members.map((m) => index.get(m) ?? -1).filter((i) => i >= 0),
      });
    }
  }
  doc.groups = groups;
  doc.banner = renderPartialResultBanner(result) ?? null;
  return doc;
}

// ── Gate abort ─────────────────────────────────────────────

/** Which gate stopped a recording run, and the findings that stopped it. */
export interface FillAbort {
  stage: 'structural' | 'log-gate';
  issues: CheckIssue[];
  /** The command to re-run once the gate is cleared — the user's own, flags kept. */
  retry?: string;
}

/** The one-line account of an abort the verdict line and the document both carry. */
function abortReason(abort: FillAbort): string {
  const n = abort.stage === 'log-gate'
    ? new Set(abort.issues.map((i) => i.nodePath ?? '')).size
    : abort.issues.length;
  return abort.stage === 'log-gate'
    ? `nothing recorded — ${count(n, 'node')} ${n === 1 ? 'needs' : 'need'} a log entry first`
    : `nothing ran — ${count(n, 'problem')} must be fixed first`;
}

/**
 * The report of a recording run a gate stopped before it recorded anything:
 * a verdict line that says ABORTED (keeping the `yg check:` anchor every other
 * report opens with), the gating findings through the same grouped renderer as
 * any report — capped, templated where they differ only by node — and the
 * first step. It used to be dozens of unlabelled three-line blocks on stderr,
 * with nothing on stdout at all.
 */
export function formatAbort(abort: FillAbort, emoji = useEmoji): string {
  const prefix = emoji ? '❌ ' : '';
  const sections: string[] = [`${prefix}${verdict('yg check', 'ABORTED', abortReason(abort))}`];
  if (abort.issues.length > 0) {
    sections.push('');
    sections.push(renderErrorSection(abort.issues, { capMembers: true }, emoji));
    const first = [...abort.issues].sort((a, b) => issuePriorityRank(a) - issuePriorityRank(b) || (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'))[0];
    if (first.messageData.next) {
      sections.push('');
      const step = fixPointer(first.messageData.next);
      // Name the re-run with the user's own flags (a keyless
      // --only-deterministic run must not be sent to the paid lane), unless the
      // step already does.
      const rerun = abort.retry !== undefined && !step.includes('then re-run:') ? `\n  then re-run: ${abort.retry}` : '';
      sections.push(nextLine(`${step}${rerun}`));
    }
  }
  sections.push('');
  return sections.join('\n');
}

/**
 * The yg-check/1 document of an aborted recording run: the read-only report of
 * the same tree (so every count is true), with `exit.status` `aborted`, the
 * reason, and the gating findings under `aborted`.
 */
export function abortCheckJson(doc: CheckJsonDocument, abort: FillAbort, issueOf: (i: CheckIssue) => CheckJsonIssue): CheckJsonDocument {
  doc.exit = { code: 1, status: 'aborted', reason: `yg check --approve stopped: ${abortReason(abort)}.` };
  doc.aborted = { stage: abort.stage, issues: abort.issues.map(issueOf) };
  return doc;
}

// ── Partial result ─────────────────────────────────────────

/** How many per-node rows the --summary view prints before it counts the rest. */
const SUMMARY_CAP = MEMBER_CAP * 2;

/**
 * The banner a report carries when part of the graph did not load as written:
 * which part, and that the findings below were computed without it. A config
 * that does not parse falls back to defaults (coverage roots, reviewer, limits);
 * an architecture that does not load checks no architecture rule; a component
 * file that does not parse drops that component, so a flow naming it reads it
 * as non-existent and its files read as unmapped. Without the banner the report
 * silently got GREENER as the graph broke. Undefined on every ordinary run.
 */
function renderPartialResultBanner(result: CheckResult): string | undefined {
  const failed = result.issues.filter((i) => i.severity === 'error' && GRAPH_INVALID_CODES.has(i.code));
  if (failed.length === 0) return undefined;
  const parts: string[] = [];
  if (failed.some((i) => i.code === 'config-invalid')) parts.push('yg-config.yaml did not load, so its defaults were used');
  if (failed.some((i) => i.code === 'architecture-invalid')) parts.push('yg-architecture.yaml did not load, so no architecture rule was checked');
  const components = [...new Set(failed.filter((i) => i.code === 'yaml-invalid' && i.nodePath !== undefined).map((i) => toPosixPath(i.nodePath!)))];
  const otherYaml = failed.filter((i) => i.code === 'yaml-invalid' && i.nodePath === undefined).length;
  if (components.length > 0) {
    const sample = components.slice(0, 3).join(', ') + (components.length > 3 ? ', …' : '');
    parts.push(`${count(components.length, 'component file')} did not parse (${sample}), so ${components.length === 1 ? 'that component was' : 'those components were'} left out`);
  }
  if (otherYaml > 0) parts.push(`${count(otherYaml, 'rule file')} did not parse`);
  if (failed.some((i) => i.code === 'lock-invalid')) parts.push('the verdict lock did not load');
  return `Partial result: ${parts.join('; ')}. The findings below were computed without it and may be symptoms of it — fix it first.`;
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
function renderTopBody(errors: CheckIssue[], warnings: CheckIssue[], n: number, opts: GroupRenderOptions): ViewBody {
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
      renderUnmappedBlock(g.members[0], lines, coverageBlockLabel(g.code), opts);
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

  // Bounded like every other view: with more rows than SUMMARY_CAP, the rows
  // that carry the most findings are shown (ties by name) and the rest are
  // counted on one line that names the view listing every finding.
  const total = (a: NodeAgg): number => a.unverifiedDet + a.unverifiedLlm + a.refused + a.outside + a.other;
  let names = [...byNode.keys()].sort((x, y) => x.localeCompare(y, 'en'));
  let hiddenRows = 0;
  let hiddenFindings = 0;
  if (names.length > SUMMARY_CAP) {
    const ranked = [...names].sort((x, y) => total(byNode.get(y)!) - total(byNode.get(x)!) || x.localeCompare(y, 'en'));
    const hidden = ranked.slice(SUMMARY_CAP);
    hiddenRows = hidden.length;
    hiddenFindings = hidden.reduce((sum, n) => sum + total(byNode.get(n)!), 0);
    names = ranked.slice(0, SUMMARY_CAP);
  }
  const lines: string[] = [];
  for (const node of names) {
    const a = byNode.get(node)!;
    const unverified = a.unverifiedDet + a.unverifiedLlm;
    const parts: string[] = [];
    parts.push(`${unverified} unverified (${a.unverifiedDet} deterministic-free, ${a.unverifiedLlm} LLM)`);
    parts.push(`${a.refused} refused`);
    if (a.outside > 0) parts.push(`${a.outside} outside changes`);
    if (a.other > 0) parts.push(`${a.other} other`);
    lines.push(`  ${node}  ${parts.join(', ')}`);
  }
  if (hiddenRows > 0) {
    lines.push(`  ... and ${count(hiddenRows, 'more row')} with ${count(hiddenFindings, 'finding')} (yg check --details)`);
  }
  return lines.join('\n');
}
