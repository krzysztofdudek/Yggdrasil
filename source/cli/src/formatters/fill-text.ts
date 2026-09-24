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

import type { FillEvent, FillDispatchCounts, FillOutcomeTotals, DryRunPair } from '../model/fill-event.js';
import { toPosixPath } from '../utils/posix.js';

/** `n` and its noun, agreeing (the formatter's own copy of the CLI's count, which it cannot import). */
const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** ANSI: return to column 0 and erase the whole line. */
const CLEAR_LINE = '\r\u001b[2K';


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

/** A pair in the one notation every surface uses: `<aspect> @ <unit>`. */
function pairName(aspectId: string, unitKey: string): string {
  return `${aspectId} @ ${toPosixPath(unitKey).replace(/^(node|file):/, '')}`;
}

/** Every line the fill writes starts with this word, so its lines never read as the report's. */
const FILL = 'fill  ';

/**
 * The pre-dispatch line: how many pairs this run fills, how many are script
 * pairs (free), and the reviewer-call budget — then, when reviewer pairs are
 * left alone, a line saying how many and why. A preview says what it is first.
 */
function renderDispatch(counts: FillDispatchCounts): string {
  // A fill with nothing to do says nothing (a preview still says what it is).
  if (counts.fillPairs === 0 && counts.skippedLlmPairs === 0 && counts.skippedOutsideLlmPairs === 0 && counts.preview !== true) return '';
  const preface = counts.preview === true ? `${FILL}dry run — a cost preview; nothing is filled or written\n` : '';
  let out =
    preface +
    `${FILL}${count(counts.fillPairs, 'pair')} · ${counts.detPairs} script (free) · ${count(counts.reviewerCallBudget, 'reviewer call')}${counts.reviewerCallBudget > 0 ? ' (consensus included)' : ''}\n`;
  if (counts.skippedLlmPairs > 0) {
    out +=
      `${FILL}${count(counts.skippedLlmPairs, 'reviewer pair')} left alone — ` +
      (counts.reviewerConfigured === false ? 'no reviewer is configured to judge them\n' : 'script rules only this run\n');
  }
  if (counts.skippedOutsideLlmPairs > 0) {
    out += `${FILL}${count(counts.skippedOutsideLlmPairs, 'reviewer pair')} outside this change left alone\n`;
  }
  return out;
}

function billedLine(p: DryRunPair): string {
  return `  ${pairName(p.aspectId, p.unit)} — ${count(p.reviewerCalls ?? 0, 'reviewer call')}\n`;
}

/**
 * A cost preview: the pairs that cost something (reviewer pairs), one line
 * each, then one line counting the free script pairs, then the upper-bound
 * caveat. Listing every free pair made a preview of a large backlog thousands
 * of lines long to say "this costs nothing".
 */
function renderDryRun(e: Extract<FillEvent, { type: 'dry-run' }>): string {
  let out = '';
  let free = 0;
  for (const node of e.nodes) {
    const billed = node.pairs.filter((p) => p.lane === 'llm');
    free += node.pairs.length - billed.length;
    for (const p of billed) out += billedLine(p);
  }
  const billedFiles = e.files.filter((p) => p.lane === 'llm');
  free += e.files.length - billedFiles.length;
  for (const p of billedFiles) out += billedLine(p);
  if (free > 0) out += `  ${count(free, 'script pair')} — free, not listed\n`;
  out +=
    `note: ${count(e.reviewerCallBudget, 'reviewer call')} is an upper bound — a unit a script rule refuses has its reviewer ` +
    `pairs skipped, and a fresh refusal or an unreachable reviewer can leave a pair unfilled. Nothing was written; run yg check --approve to fill.\n`;
  return out;
}

/**
 * The garbage collector's prune summary. Nothing when nothing was pruned; an
 * entry whose reviewer kind could not be determined is counted as unknown
 * rather than silently folded into billed or free.
 */
function renderPrune(e: Extract<FillEvent, { type: 'prune' }>): string {
  if (e.entries.length === 0) return '';
  const parts = [`${e.billedCount} reviewer`, `${e.freeCount} script`, e.unknownCount > 0 ? `${e.unknownCount} unknown` : ''].filter((p) => p !== '');
  let out = `${FILL}pruned ${count(e.entries.length, 'stale verdict')} (${parts.join(' · ')})\n`;
  for (const entry of e.entries) out += `  ${pairName(entry.aspectId, entry.unitKey)} — ${entry.reason}\n`;
  return out;
}

/**
 * The single in-place status line. Cleared before it is rewritten (a shorter
 * line would otherwise leave the tail of the previous one) and truncated to the
 * terminal width with one column spare (a wrapped line scrolls instead of
 * updating in place). Counts first, pair name last, so a narrow terminal cuts
 * the part that changes constantly.
 */
function renderStatus(e: Extract<FillEvent, { type: 'status' }>): string {
  const { completed, total, refused } = e.counts;
  const head = `${FILL}${completed}/${total}${refused > 0 ? ` · ${refused} refused` : ''} · ${e.elapsedSeconds}s`;
  const current = e.currentPair === '' ? '' : `  ${toPosixPath(e.currentPair).replace(/ on (node|file):/, ' @ ')}`;
  return `${CLEAR_LINE}${truncateToWidth(`${head}${current}`, e.columns - 1)}\r`;
}

/** A duration as a person reads it: `42s`, `3m46s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** What the reviewer calls consumed, as far as the provider reported it. */
function usageWords(t: FillOutcomeTotals): string {
  const u = t.usage;
  if (u === undefined) return '';
  const tokens = `${u.inputTokens.toLocaleString('en-US')} input / ${u.outputTokens.toLocaleString('en-US')} output tokens`;
  const cost = u.costUsd !== undefined ? `, ~$${u.costUsd.toFixed(2)} at list price` : '';
  const scope = u.reportedCalls < t.reviewerCallsMade ? ` (reported by ${u.reportedCalls} of ${t.reviewerCallsMade} calls)` : '';
  return ` · ${tokens}${cost}${scope}`;
}

/**
 * The closing line: what the finished fill did — how long it took, how many
 * pairs it approved, refused and could not judge, how many reviewer calls it
 * made and what they consumed — and what it left alone. It never says the
 * result is valid or healthy: the report below it says what stands. A fill
 * that had nothing to do prints nothing.
 */
function renderTotals(t: FillOutcomeTotals): string {
  const o = t.outcomes;
  const approved = o?.approved ?? t.detApproved;
  const refused = o?.refused ?? t.detRefused;
  // Every pair left without a verdict: the tracker's own count, or — when a
  // pair never reached it (a reviewer that could not be reached is refused
  // before dispatch) — the run's own failure totals, whichever is larger.
  const failed = Math.max(o?.infra ?? 0, t.infraFailures + t.runtimeErrors + t.companionRuntimeErrors + t.malformedSuppressErrors);
  const done = o?.completed ?? approved + refused + failed;
  const skipped = [
    t.skippedLlmPairs > 0 ? `${count(t.skippedLlmPairs, 'reviewer pair')} left alone` : '',
    t.skippedOutsideLlmPairs > 0 ? `${count(t.skippedOutsideLlmPairs, 'reviewer pair')} outside this change left alone` : '',
    t.skippedByDetGate > 0 ? `reviewer skipped on ${count(t.skippedByDetGate, 'unit')} a script rule refuses` : '',
  ].filter((p) => p !== '');
  // What reviews the pairs left alone, as the fill's own labelled step.
  const step = t.skippedLlmPairs > 0
    ? (t.reviewerConfigured === false ? 'next: yg init --provider <name> [--model <m>]  (configures a reviewer — ask the user first)\n' : 'next: yg check --approve  (reviews the pairs left alone)\n')
    : t.skippedOutsideLlmPairs > 0 ? 'next: yg check --full --approve  (reviews the pairs outside this change)\n' : '';
  if (done === 0 && skipped.length === 0) return '';
  const took = t.elapsedMs !== undefined ? ` in ${formatElapsed(t.elapsedMs)}` : '';
  const line = `${FILL}done${took} — ${approved} approved · ${refused} refused · ${failed} failed · ${count(t.reviewerCallsMade, 'reviewer call')}${usageWords(t)}`;
  return `${line}${skipped.length > 0 ? ` · ${skipped.join(' · ')}` : ''}\n${step}`;
}

/** A what/why/next message in the one grammar, headed by `word`. */
function messageLines(word: string, msg: { what: string; why: string; next: string }): string {
  const why = msg.why !== '' ? `  why:  ${msg.why}\n` : '';
  const next = msg.next !== '' ? `next: ${msg.next.split('\n').join('\n      ')}\n` : '';
  return `${word}: ${msg.what}\n${why}${next}`;
}

/** The text one fill event reads as. */
export function renderFillEvent(e: FillEvent): string {
  switch (e.type) {
    case 'dispatch':
      return renderDispatch(e.counts);
    case 'no-reviewer':
      return messageLines('note', e.message);
    case 'dry-run':
      return renderDryRun(e);
    case 'prune':
      return renderPrune(e);
    case 'rule-status':
      return `${FILL}rule '${e.aspectId}' now stands at ${e.to} (was ${e.from}) — written into its own log\n`;
    case 'pair-outcome':
      // Plain output is a start line and an end line; a pair gets a line of
      // its own only when it did not simply pass — it could not be judged, or
      // a consensus split on it. A refusal is in the report.
      if (e.verdict === 'refused' && e.votes === undefined) return '';
      if (e.verdict === 'approved' && e.votes === undefined) return '';
      // The votes that decided it: satisfied votes for an approval, the
      // others for a refusal.
      return `${FILL}${e.verdict === 'infra' ? 'not judged' : e.verdict}${
        e.votes !== undefined ? ` by ${e.verdict === 'approved' ? e.votes.satisfied : e.votes.total - e.votes.satisfied} of ${e.votes.total} votes` : ''
      }  ${pairName(e.aspectId, e.unitKey)}\n`;
    case 'milestone':
      return '';
    case 'still-working':
      return `${FILL}still working — ${e.completed}/${e.total}, waiting on ${toPosixPath(e.currentPair).replace(/ on (node|file):/, ' @ ')}\n`;
    case 'status':
      return renderStatus(e);
    case 'clear-line':
      return CLEAR_LINE;
    case 'totals':
      return renderTotals(e.totals);
    case 'interrupted':
      return `${CLEAR_LINE}${messageLines('warning', e.message)}`;
  }
}

/** A sink that renders every event into a plain text writer. */
export function textFillSink(write: (s: string) => void): (e: FillEvent) => void {
  return (e) => {
    const text = renderFillEvent(e);
    if (text !== '') write(text);
  };
}
