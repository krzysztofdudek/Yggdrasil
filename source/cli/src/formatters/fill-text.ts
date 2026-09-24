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

/** `n` and its noun, agreeing (the formatter's own copy of the CLI's count, which it cannot import). */
const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

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
  // The header sentence keeps its exact shape — "Filling N unverified pairs
  // across M nodes — D deterministic (no cost), R reviewer calls" — because a
  // reader parses the budget out of it (the portal's cost preview). A preview
  // says what it is on the line before instead, so it no longer reads as a
  // run that fills.
  const preface = counts.preview === true ? 'Dry run — a cost preview: nothing below is filled or written.\n' : '';
  const acrossLabel = counts.fileCount > 0
    ? `${counts.nodeCount} components and ${counts.fileCount} files`
    : `${counts.nodeCount} nodes`;
  let out =
    preface +
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
      `  ${count(counts.skippedOutsideLlmPairs, 'LLM pair')} outside this change — ` +
      `${reviewThemWith(counts.skippedOutsideLlmPairs, 'yg check --full --approve')}.\n`;
  }
  return out;
}

function billedLine(p: DryRunPair): string {
  return `    [llm] ${p.aspectId} on ${toPosixPath(p.unit)} — ${count(p.reviewerCalls ?? 0, 'reviewer call')}\n`;
}

/**
 * A cost preview: the pairs that cost something (reviewer pairs), per subject,
 * then one line counting the free script pairs, then the upper-bound caveat.
 * Listing every free pair made a preview of a large backlog thousands of lines
 * long to say "this costs nothing".
 */
function renderDryRun(e: Extract<FillEvent, { type: 'dry-run' }>): string {
  let out = '';
  let free = 0;
  for (const node of e.nodes) {
    const billed = node.pairs.filter((p) => p.lane === 'llm');
    free += node.pairs.length - billed.length;
    if (billed.length === 0) continue;
    out += `  ${toPosixPath(node.nodePath)}\n`;
    for (const p of billed) out += billedLine(p);
  }
  const billedFiles = e.files.filter((p) => p.lane === 'llm');
  free += e.files.length - billedFiles.length;
  if (billedFiles.length > 0) {
    out += `  Files enforced by their type\n`;
    for (const p of billedFiles) out += billedLine(p);
  }
  if (free > 0) out += `  ${count(free, 'deterministic pair')} — free, not listed\n`;
  out +=
    `This budget of ${count(e.reviewerCallBudget, 'reviewer call')} is an UPPER BOUND — a node with an enforced ` +
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
  let out = `Pruned ${count(e.entries.length, 'stale verdict')} — ${e.billedCount} billed, ${e.freeCount} free${unknownClause}:\n`;
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
/** A duration as a person reads it: `42s`, `3m46s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The closing line of a run that made reviewer calls: how many, how long the
 * run took, and what the calls consumed as far as the provider reported it.
 * The figures are the provider's own; a cost is its list price, which is not
 * what a subscription is billed per call, and the line says which calls it
 * covers when not all of them reported.
 */
function renderPaidTotals(t: FillOutcomeTotals): string {
  const parts = [`${count(t.reviewerCallsMade, 'reviewer call')} made`];
  if (t.elapsedMs !== undefined) parts[0] += ` in ${formatElapsed(t.elapsedMs)}`;
  const u = t.usage;
  if (u !== undefined) {
    const tokens = `${u.inputTokens.toLocaleString('en-US')} input / ${u.outputTokens.toLocaleString('en-US')} output tokens`;
    const cost = u.costUsd !== undefined ? `, ~$${u.costUsd.toFixed(2)} at list price` : '';
    const scope = u.reportedCalls < t.reviewerCallsMade ? ` (reported by ${u.reportedCalls} of ${t.reviewerCallsMade} calls)` : '';
    parts.push(`${tokens}${cost}${scope}`);
  }
  return `${parts.join(' · ')}\n`;
}

function renderTotals(t: FillOutcomeTotals): string {
  const detFilled = t.detApproved + t.detRefused;
  const detClause = detFilled > 0
    ? `${detFilled} deterministic pair${detFilled === 1 ? '' : 's'} filled (${
      [t.detApproved > 0 ? `${t.detApproved} approved` : '', t.detRefused > 0 ? `${t.detRefused} refused` : '']
        .filter((part) => part !== '').join(', ')
    })`
    : '';
  if (t.reviewerCallsMade !== 0) return renderPaidTotals(t);
  if (
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
      `0 reviewer calls made — ${count(t.skippedOutsideLlmPairs, 'LLM pair')} outside this change left unverified. ` +
      `Run \`yg check --full --approve\` to review ${t.skippedOutsideLlmPairs === 1 ? 'it' : 'them'}.${detTail}\n`
    );
  }
  if (t.skippedByDetGate > 0) {
    const n = t.skippedByDetGate;
    return `0 reviewer calls made — LLM review skipped on ${n} unit${n === 1 ? '' : 's'} a deterministic check refuses.${detTail}\n`;
  }
  if (detFilled > 0) return `0 reviewer calls made — ${detClause}.\n`;
  // Nothing was filled. Say every pair holds a valid verdict only when that is
  // so: a refusal recorded earlier for unchanged code still stands, and a
  // closing line claiming "all valid" above a FAIL report contradicted it.
  const standing = t.cachedRefusals ?? 0;
  if (standing > 0) return `0 reviewer calls made — nothing to fill; ${count(standing, 'recorded refusal')} still ${standing === 1 ? 'stands' : 'stand'}.\n`;
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
      return `  [${e.lane}] ${e.aspectId} on ${toPosixPath(e.unitKey)} — ${e.verdict}${
        e.votes !== undefined ? ` (consensus ${e.votes.satisfied}/${e.votes.total} satisfied)` : ''
      }\n`;
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
    case 'interrupted':
      // Laid out like any what/why/next, from the message the engine built.
      return `${CLEAR_LINE}${e.message.what}\n  ${e.message.why}\n  ${e.message.next}\n`;
  }
}

/** A sink that renders every event into a plain text writer. */
export function textFillSink(write: (s: string) => void): (e: FillEvent) => void {
  return (e) => {
    const text = renderFillEvent(e);
    if (text !== '') write(text);
  };
}
