/**
 * The words the fill stage (`yg check --approve`) says while it runs.
 *
 * The engine reports each thing it has to say as a FillEvent (model/fill-event.ts)
 * and never formats a sentence; this module turns one event into the text a
 * person reads on stderr. One place for every one of these sentences, so the
 * header, the progress lines and the closing line are worded by the same hand,
 * and a test can check the engine's facts without matching its prose.
 *
 * Pure: an event in, a string out (possibly empty, possibly several lines,
 * each ending in a newline unless it is the in-place status line).
 */

import type { FillEvent, FillDispatchCounts, FillOutcomeTotals, DryRunPair, FillProgressCounts } from '../model/fill-event.js';
import { toPosixPath } from '../utils/posix.js';

/** ANSI: return to column 0 and erase the whole line. */
const CLEAR_LINE = '\r\u001b[2K';

/**
 * The remedy every "these paid pairs were left alone" notice ends in. One
 * phrasing, two causes — a run that skips paid work for a second reason should
 * extend this rather than inventing a parallel sentence.
 */
const reviewThemWith = (count: number, command: string): string =>
  `run \`${command}\` to review ${count === 1 ? 'it' : 'them'}`;

/**
 * Cut `text` to at most `width` columns, marking the cut with a single ellipsis
 * so it reads as shortened rather than as a path that mysteriously ends early.
 * Plain text only — the status line carries no colour codes, so counting
 * characters is counting columns.
 */
function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/**
 * The pre-dispatch header: how many pairs this run will fill, over how many
 * subjects, and the reviewer-call budget — then, when paid work is left alone,
 * a line saying how much and why. The combined "components and files" wording
 * appears only when a nodeless pair exists this run.
 */
function renderDispatch(counts: FillDispatchCounts): string {
  const acrossLabel = counts.fileCount > 0
    ? `${counts.nodeCount} components and ${counts.fileCount} files`
    : `${counts.nodeCount} nodes`;
  let out =
    `Filling ${counts.fillPairs} unverified pairs across ${acrossLabel} — ` +
    `${counts.detPairs} deterministic (no cost), ${counts.reviewerCallBudget} reviewer calls (consensus included)\n`;
  if (counts.skippedLlmPairs > 0) {
    out +=
      `  Deterministic-only mode — ${counts.skippedLlmPairs} LLM pair${counts.skippedLlmPairs === 1 ? '' : 's'} will NOT be reviewed this run; ` +
      (counts.reviewerConfigured === false
        ? `no reviewer is configured to review ${counts.skippedLlmPairs === 1 ? 'it' : 'them'} (yg init --provider <name> [--model <m>] — the user's decision).\n`
        : `${reviewThemWith(counts.skippedLlmPairs, 'yg check --approve')}.\n`);
  }
  if (counts.skippedOutsideLlmPairs > 0) {
    out +=
      `  ${counts.skippedOutsideLlmPairs} LLM pair(s) outside this change — ` +
      `${reviewThemWith(counts.skippedOutsideLlmPairs, 'yg check --full --approve')}.\n`;
  }
  return out;
}

function dryRunLine(p: DryRunPair): string {
  return p.lane === 'det'
    ? `    [det] ${p.aspectId} on ${toPosixPath(p.unit)} — free\n`
    : `    [llm] ${p.aspectId} on ${toPosixPath(p.unit)} — ${p.reviewerCalls ?? 0} reviewer call(s)\n`;
}

/** A cost preview's per-subject breakdown, then the upper-bound caveat. */
function renderDryRun(e: Extract<FillEvent, { type: 'dry-run' }>): string {
  let out = '';
  for (const node of e.nodes) {
    out += `  ${toPosixPath(node.nodePath)}\n`;
    for (const p of node.pairs) out += dryRunLine(p);
  }
  if (e.files.length > 0) {
    out += `  Files enforced by their type\n`;
    for (const p of e.files) out += dryRunLine(p);
  }
  out +=
    `${e.reviewerCallBudget} reviewer call(s) is an UPPER BOUND — a node with an enforced ` +
    `deterministic refusal has its LLM fills skipped this run, and a fresh refusal or ` +
    `infra disposition can leave a pair unfilled. Nothing was written; run yg check --approve to fill.\n`;
  return out;
}

/**
 * The garbage collector's prune summary. Nothing when nothing was pruned; an
 * entry whose reviewer kind could not be determined adds an ", U unknown"
 * clause rather than silently folding into billed or free.
 */
function renderPrune(e: Extract<FillEvent, { type: 'prune' }>): string {
  if (e.entries.length === 0) return '';
  const unknownClause = e.unknownCount > 0 ? `, ${e.unknownCount} unknown` : '';
  let out = `Pruned ${e.entries.length} stale verdict(s) — ${e.billedCount} billed, ${e.freeCount} free${unknownClause}:\n`;
  for (const entry of e.entries) out += `  [${entry.kind}] ${entry.aspectId} on ${toPosixPath(entry.unitKey)} — ${entry.reason}\n`;
  return out;
}

function renderMilestone(c: FillProgressCounts): string {
  const parts = [`${c.approved} ok`];
  if (c.refused > 0) parts.push(`${c.refused} refused`);
  if (c.infra > 0) parts.push(`${c.infra} infra`);
  return `... ${c.completed}/${c.total} filled (${parts.join(', ')})\n`;
}

/**
 * The single in-place status line. Cleared before it is rewritten (a shorter
 * line would otherwise leave the tail of the previous one) and truncated to the
 * terminal width with one column spare (a wrapped line scrolls instead of
 * updating in place). Counts first, pair name last, so a narrow terminal cuts
 * the part that changes constantly.
 */
function renderStatus(e: Extract<FillEvent, { type: 'status' }>): string {
  const { completed, total, approved, refused } = e.counts;
  const head = `filling ${completed}/${total} · ok ${approved} · refused ${refused} · ${e.elapsedSeconds}s`;
  const full = e.currentPair === '' ? head : `${head} · ${toPosixPath(e.currentPair)}`;
  return `${CLEAR_LINE}${truncateToWidth(full, e.columns - 1)}\r`;
}

/**
 * The closing line: what the finished fill did — printed only when no reviewer
 * was called and nothing failed (a failure is reported as its own diagnostic).
 * It claims "all expected pairs hold valid verdicts" only when the run neither
 * filled nor skipped anything.
 */
function renderTotals(t: FillOutcomeTotals): string {
  const detFilled = t.detApproved + t.detRefused;
  const detClause = detFilled > 0
    ? `${detFilled} deterministic pair${detFilled === 1 ? '' : 's'} filled (${
      [t.detApproved > 0 ? `${t.detApproved} approved` : '', t.detRefused > 0 ? `${t.detRefused} refused` : '']
        .filter((part) => part !== '').join(', ')
    })`
    : '';
  if (
    t.reviewerCallsMade !== 0 ||
    t.infraFailures !== 0 ||
    t.runtimeErrors !== 0 ||
    t.companionRuntimeErrors !== 0 ||
    t.malformedSuppressErrors !== 0
  ) {
    return '';
  }
  const detTail = detClause ? ` ${detClause.charAt(0).toUpperCase()}${detClause.slice(1)}.` : '';
  if (t.skippedLlmPairs > 0) {
    return (
      `0 reviewer calls made — deterministic-only mode; ${t.skippedLlmPairs} LLM pair${t.skippedLlmPairs === 1 ? '' : 's'} left unverified. ` +
      (t.reviewerConfigured === false
        ? `No reviewer is configured to review ${t.skippedLlmPairs === 1 ? 'it' : 'them'}: yg init --provider <name> [--model <m>] (the user's decision).`
        : `Run \`yg check --approve\` to review ${t.skippedLlmPairs === 1 ? 'it' : 'them'}.`) +
      `${detTail}\n`
    );
  }
  if (t.skippedOutsideLlmPairs > 0) {
    return (
      `0 reviewer calls made — ${t.skippedOutsideLlmPairs} LLM pair(s) outside this change left unverified. ` +
      `Run \`yg check --full --approve\` to review ${t.skippedOutsideLlmPairs === 1 ? 'it' : 'them'}.${detTail}\n`
    );
  }
  if (t.skippedByDetGate > 0) {
    const n = t.skippedByDetGate;
    return `0 reviewer calls made — LLM review skipped on ${n} unit${n === 1 ? '' : 's'} a deterministic check refuses.${detTail}\n`;
  }
  if (detFilled > 0) return `0 reviewer calls made — ${detClause}.\n`;
  return '0 reviewer calls made — all expected pairs hold valid verdicts\n';
}

/** The text one fill event reads as. */
export function renderFillEvent(e: FillEvent): string {
  switch (e.type) {
    case 'dispatch':
      return renderDispatch(e.counts);
    case 'no-reviewer':
      return `  ${e.message.what}\n  ${e.message.why}\n  ${e.message.next}\n`;
    case 'dry-run':
      return renderDryRun(e);
    case 'prune':
      return renderPrune(e);
    case 'rule-status':
      return `  Rule '${e.aspectId}' now stands at ${e.to} (was ${e.from}) — written into its own log.\n`;
    case 'pair-outcome':
      return `  [${e.lane}] ${e.aspectId} on ${toPosixPath(e.unitKey)} — ${e.verdict}\n`;
    case 'milestone':
      return renderMilestone(e.counts);
    case 'still-working':
      return `... still working (${e.completed}/${e.total}, waiting on ${toPosixPath(e.currentPair)})\n`;
    case 'status':
      return renderStatus(e);
    case 'clear-line':
      return CLEAR_LINE;
    case 'totals':
      return renderTotals(e.totals);
  }
}

/** A sink that renders every event into a plain text writer. */
export function textFillSink(write: (s: string) => void): (e: FillEvent) => void {
  return (e) => {
    const text = renderFillEvent(e);
    if (text !== '') write(text);
  };
}
