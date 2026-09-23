/**
 * source/cli/src/core/fill-report.ts — everything the fill stage (spec §7) says
 * out loud: the pre-dispatch header, the garbage collector's prune summary, the
 * grouped infrastructure diagnostics each phase collects, the deterministic
 * gate's skip notices, and the closing summary.
 *
 * Two sinks, deliberately separate. Plain PROGRESS text goes to `write`;
 * structured DIAGNOSTICS ({ what, why, next }) go to `emitIssue` and are never
 * formatted here — the CLI command layer owns presentation, this engine module
 * only produces the data.
 */

import type { IssueMessage } from '../model/validation.js';
import type { PruneSummary } from './fill-gc.js';
import type { CheckResult } from './check-contract.js';
import type { UnverifiedCause } from './check-codes.js';
import { computeSuggestedNext } from './check-suggested-next.js';
import { toPosixPath } from '../utils/posix.js';

/** One pair's infrastructure diagnostic, collected by a phase for grouped emission. */
export interface InfraDiagnosticItem {
  aspectId: string;
  unitKey: string;
  messageData: IssueMessage;
}

/**
 * The remedy every "these paid pairs were left alone" notice ends in. One
 * phrasing, two causes — a run that skips paid work for a second reason should
 * extend this rather than inventing a parallel sentence, so the two read as the
 * same kind of statement about the same kind of omission.
 */
const reviewThemWith = (count: number, command: string): string =>
  `run \`${command}\` to review ${count === 1 ? 'it' : 'them'}`;

/**
 * Print the pre-dispatch header (EXACT wording): how many pairs this run will
 * fill, over how many subjects, and what the reviewer-call budget is.
 *
 * Every number here describes what this run will ACTUALLY fill, not everything
 * it found unverified. The two differ whenever paid work is deliberately left
 * alone (deterministic-only mode, or a pair outside the current change), and
 * quoting the larger set would name a bill the run never intends to spend.
 * Whatever is left out is then said out loud below, so the smaller number never
 * reads as "there was nothing else".
 *
 * `nodeCount` counts only DEFINED owners — a nodeless (file-level) pair would
 * otherwise inflate it by one phantom component. `fileCount` counts distinct
 * type-covered files separately. The combined "components and files" wording
 * appears ONLY when a nodeless pair exists this run; with none, the line is
 * byte-identical to the plain node-only header, and no phantom nodes are
 * rendered either way.
 */
export function writeDispatchHeader(
  counts: {
    fillPairs: number;
    nodeCount: number;
    fileCount: number;
    detPairs: number;
    reviewerCallBudget: number;
    skippedLlmPairs: number;
    skippedOutsideLlmPairs: number;
    /** False when yg-config.yaml has no reviewer: section — the skipped judgment
     *  pairs then need a reviewer first, not another --approve. */
    reviewerConfigured?: boolean;
  },
  write: (s: string) => void,
): void {
  const acrossLabel = counts.fileCount > 0
    ? `${counts.nodeCount} components and ${counts.fileCount} files`
    : `${counts.nodeCount} nodes`;
  write(
    `Filling ${counts.fillPairs} unverified pairs across ${acrossLabel} — ` +
      `${counts.detPairs} deterministic (no cost), ${counts.reviewerCallBudget} reviewer calls (consensus included)\n`,
  );
  // Deterministic-only mode fills the free deterministic pairs but leaves every
  // unverified LLM pair untouched. Say so up front — otherwise the header reads
  // as if all N unverified pairs are being handled this run.
  if (counts.skippedLlmPairs > 0) {
    write(
      `  Deterministic-only mode — ${counts.skippedLlmPairs} LLM pair${counts.skippedLlmPairs === 1 ? '' : 's'} will NOT be reviewed this run; ` +
        (counts.reviewerConfigured === false
          ? `no reviewer is configured to review ${counts.skippedLlmPairs === 1 ? 'it' : 'them'} (yg init --provider <name> [--model <m>] — the user's decision).\n`
          : `${reviewThemWith(counts.skippedLlmPairs, 'yg check --approve')}.\n`),
    );
  }
  // The same statement for the other reason paid work is left alone: the change
  // is not accountable for it. The remedy differs — these pairs need the run
  // that answers for the whole project, not merely another --approve.
  if (counts.skippedOutsideLlmPairs > 0) {
    write(
      `  ${counts.skippedOutsideLlmPairs} LLM pair(s) outside this change — ` +
        `${reviewThemWith(counts.skippedOutsideLlmPairs, 'yg check --full --approve')}.\n`,
    );
  }
}

/**
 * Print the garbage collector's own prune summary — this exact wording is a
 * contract another CLI-driven end-to-end test asserts against, so a later
 * change here is a coordinated edit across both, never a local cosmetic one.
 * Printed by BOTH `--approve` (after the real prune) and `--dry-run` (a preview,
 * computed over a disposable clone of the lock — see the dry-run call site).
 * Prints NOTHING when nothing was pruned. An entry whose reviewer kind could
 * not be determined (see PruneSummary's own doc) adds a third ", U unknown"
 * clause rather than silently folding into billed or free; omitted entirely
 * when there are none, so the common case's wording is unchanged.
 */
export function writePruneSummary(summary: PruneSummary, write: (s: string) => void): void {
  if (summary.entries.length === 0) return;
  const unknownClause = summary.unknownCount > 0 ? `, ${summary.unknownCount} unknown` : '';
  write(
    `Pruned ${summary.entries.length} stale verdict(s) — ${summary.billedCount} billed, ${summary.freeCount} free${unknownClause}:\n`,
  );
  for (const e of summary.entries) {
    write(`  [${e.kind}] ${e.aspectId} on ${toPosixPath(e.unitKey)} — ${e.reason}\n`);
  }
}

/**
 * Emit infrastructure diagnostics grouped by aspectId — one message per aspect
 * instead of one per pair.  When only one unit is affected the original per-pair
 * messageData is emitted unchanged (preserving the existing message text and
 * any actionable detail). When multiple units share the same aspect the grouped
 * form lists up to `cap` unit keys and appends " … and N more" for the rest.
 *
 * `kind` controls the summary tokens injected into the grouped `what:`:
 *   'det'                → aspect-check-runtime-error token
 *   'companion'          → aspect-companion-runtime-error token
 *   'malformed-suppress' → malformed-suppress-marker token (NOT a check fault)
 *   'pool-infra'         → generic unverified summary
 */
export function emitGroupedDiagnostics(
  items: InfraDiagnosticItem[],
  kind: 'det' | 'companion' | 'malformed-suppress' | 'pool-infra',
  emitIssue: (msg: IssueMessage) => void,
): void {
  if (items.length === 0) return;

  // Group by composite key (aspectId + why + next) so pairs with identical
  // why+next collapse into ONE message, while pairs with distinct reasons under
  // the same aspect form SEPARATE messages — each carries its own correct why/next
  // and its own unit list (lossless grouping).
  const byAspect = new Map<string, { aspectId: string; unitKeys: string[]; first: IssueMessage }>();
  for (const item of items) {
    const posix = toPosixPath(item.unitKey);
    const md = item.messageData;
    const groupKey = `${item.aspectId} ${md.why} ${md.next}`;
    const existing = byAspect.get(groupKey);
    if (existing) {
      existing.unitKeys.push(posix);
    } else {
      byAspect.set(groupKey, { aspectId: item.aspectId, unitKeys: [posix], first: md });
    }
  }

  const cap = 5;
  for (const { aspectId, unitKeys, first } of byAspect.values()) {
    if (unitKeys.length === 1) {
      // Single unit — emit the original message unchanged (preserves exact text
      // and any actionable detail, keeps existing test assertions green).
      emitIssue(first);
    } else {
      // Multiple units with the same aspect + identical why/next — emit one grouped message.
      const listed = unitKeys.slice(0, cap).join(', ');
      const overflow = unitKeys.length > cap ? ` … and ${unitKeys.length - cap} more` : '';
      let what: string;
      if (kind === 'det') {
        what = `Deterministic check '${aspectId}' failed to run on ${unitKeys.length} units — left unverified (aspect-check-runtime-error): ${listed}${overflow}`;
      } else if (kind === 'companion') {
        what = `Companion resolution for '${aspectId}' failed to run on ${unitKeys.length} units — left unverified (aspect-companion-runtime-error): ${listed}${overflow}`;
      } else if (kind === 'malformed-suppress') {
        what = `A malformed yg-suppress marker left aspect '${aspectId}' unverified on ${unitKeys.length} units (malformed-suppress-marker): ${listed}${overflow}`;
      } else {
        what = `Reviewer could not verify aspect '${aspectId}' on ${unitKeys.length} units — left unverified: ${listed}${overflow}`;
      }
      emitIssue({ what, why: first.why, next: first.next });
    }
  }
}

/**
 * Report the units whose LLM fills the deterministic gate skipped this run.
 *
 * Each key is a gate key (see detGateKey): either a real component path or a
 * `file:<path>` unit key, never both — the message names whichever it actually
 * is, so the file case never claims a component that does not exist.
 */
export function emitDetGateSkips(
  gateKeys: Iterable<string>,
  emitIssue: (msg: IssueMessage) => void,
  retry = 'yg check --approve',
): void {
  for (const key of gateKeys) {
    const isFile = key.startsWith('file:');
    const posixSubject = toPosixPath(isFile ? key.slice('file:'.length) : key);
    const subject = isFile ? `file '${posixSubject}'` : `node '${posixSubject}'`;
    emitIssue({
      what: `LLM fills for ${subject} skipped — an enforced deterministic check already refused it.`,
      why: 'A free deterministic check rejects this unit, so paying the reviewer to read the same code would be wasted. Fix the deterministic violations first.',
      next: `Fix the deterministic violations on '${posixSubject}', then re-run: ${retry}`,
    });
  }
}

/** The per-disposition tallies a finished fill reports on. */
export interface FillTotals {
  reviewerCallsMade: number;
  infraFailures: number;
  runtimeErrors: number;
  companionRuntimeErrors: number;
  malformedSuppressErrors: number;
  /** Unverified LLM pairs left untouched by --only-deterministic (0 otherwise). */
  skippedLlmPairs: number;
  /** Unverified LLM pairs left untouched because the change is not accountable
   *  for them (0 without a change scope, and 0 under --only-deterministic —
   *  see FillPairSets.skippedOutsideLlmPairs). */
  skippedOutsideLlmPairs: number;
  /** Provider/tier identities behind the infra dispositions, for the summary's parenthetical. */
  infraReport: Array<{ provider?: string; tier?: string }>;
  /** Deterministic verdicts this run wrote, split by outcome (0 when absent). */
  detApproved?: number;
  detRefused?: number;
  /** Units whose paid review the deterministic gate skipped this run (0 when absent). */
  skippedByDetGate?: number;
  /** False when no reviewer is configured (see writeDispatchHeader). */
  reviewerConfigured?: boolean;
  /** The command the run was invoked as, for every "then re-run" line. */
  retry?: string;
}

/**
 * Report what the finished fill did: the "0 reviewer calls" line when no
 * reviewer was called and nothing failed — saying what WAS done, and claiming
 * "all expected pairs hold valid verdicts" only when this run neither filled
 * nor skipped anything — then one diagnostic per non-zero no-write
 * disposition class.
 */
export function reportFillTotals(
  totals: FillTotals,
  write: (s: string) => void,
  emitIssue: (msg: IssueMessage) => void,
): void {
  const retry = totals.retry ?? 'yg check --approve';
  const detApproved = totals.detApproved ?? 0;
  const detRefused = totals.detRefused ?? 0;
  const detFilled = detApproved + detRefused;
  const detClause = detFilled > 0
    ? `${detFilled} deterministic pair${detFilled === 1 ? '' : 's'} filled (${
      [detApproved > 0 ? `${detApproved} approved` : '', detRefused > 0 ? `${detRefused} refused` : '']
        .filter((part) => part !== '').join(', ')
    })`
    : '';
  if (
    totals.reviewerCallsMade === 0 &&
    totals.infraFailures === 0 &&
    totals.runtimeErrors === 0 &&
    totals.companionRuntimeErrors === 0 &&
    totals.malformedSuppressErrors === 0
  ) {
    // What the deterministic phase did, appended as its own sentence so each
    // line below still opens with the fact that matters most.
    const detTail = detClause ? ` ${detClause.charAt(0).toUpperCase()}${detClause.slice(1)}.` : '';
    if (totals.skippedLlmPairs > 0) {
      // --only-deterministic made no reviewer calls BY DESIGN, but LLM pairs were
      // left unverified — do NOT claim every pair holds a valid verdict.
      write(
        `0 reviewer calls made — deterministic-only mode; ${totals.skippedLlmPairs} LLM pair${totals.skippedLlmPairs === 1 ? '' : 's'} left unverified. ` +
          (totals.reviewerConfigured === false
            ? `No reviewer is configured to review ${totals.skippedLlmPairs === 1 ? 'it' : 'them'}: yg init --provider <name> [--model <m>] (the user's decision).`
            : `Run \`yg check --approve\` to review ${totals.skippedLlmPairs === 1 ? 'it' : 'them'}.`) +
          `${detTail}\n`,
      );
    } else if (totals.skippedOutsideLlmPairs > 0) {
      // Same rule, other cause: pairs outside this change were never dispatched,
      // so "all expected pairs hold valid verdicts" would be false — the ones
      // this change is not accountable for are still waiting for a reviewer.
      write(
        `0 reviewer calls made — ${totals.skippedOutsideLlmPairs} LLM pair(s) outside this change left unverified. ` +
          `Run \`yg check --full --approve\` to review ${totals.skippedOutsideLlmPairs === 1 ? 'it' : 'them'}.${detTail}\n`,
      );
    } else if ((totals.skippedByDetGate ?? 0) > 0) {
      // Paid review skipped because a deterministic check refuses the unit:
      // those pairs are still waiting, so "all valid" would be false here too.
      const n = totals.skippedByDetGate ?? 0;
      write(`0 reviewer calls made — LLM review skipped on ${n} unit${n === 1 ? '' : 's'} a deterministic check refuses.${detTail}\n`);
    } else if (detFilled > 0) {
      write(`0 reviewer calls made — ${detClause}.\n`);
    } else {
      write('0 reviewer calls made — all expected pairs hold valid verdicts\n');
    }
  }
  if (totals.infraFailures > 0) {
    const providers = [...new Set(totals.infraReport.map((r) => r.provider).filter(Boolean))].join(', ');
    const tiers = [...new Set(totals.infraReport.map((r) => r.tier).filter(Boolean))].join(', ');
    const ids = [providers, tiers].filter((s) => s.length > 0).join(' / ');
    emitIssue({
      what: `${totals.infraFailures} pairs failed on provider/config errors — re-running will not help until the connection/config is fixed${ids ? ` (${ids})` : ''}.`,
      why: 'These pairs hit an infrastructure disposition (provider unreachable, tier unresolved, reference unreadable, an unparseable response, or a prompt-too-large gate). No verdict was written; the pairs stay unverified and the run ends red.',
      next: `Fix the reviewer connection/configuration, then re-run: ${retry}. To unblock CI without a reviewer, set the affected aspect(s) to status: draft.`,
    });
  }
  if (totals.runtimeErrors > 0) {
    emitIssue({
      what: `${totals.runtimeErrors} deterministic check(s) failed to run at fill time — left unverified (aspect-check-runtime-error).`,
      why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
      next: `Fix the failing check.mjs, then re-run: ${retry}.`,
    });
  }
  if (totals.malformedSuppressErrors > 0) {
    emitIssue({
      what: `${totals.malformedSuppressErrors} pair(s) left unverified by a malformed yg-suppress marker (malformed-suppress-marker).`,
      why: 'A yg-suppress marker in a mapped source file is missing its required reason. This is a fault in the marker itself, not in the aspect being checked; no verdict was written.',
      next: `Add a reason to the marker (or remove it), then re-run: ${retry}.`,
    });
  }
  if (totals.companionRuntimeErrors > 0) {
    emitIssue({
      what: `${totals.companionRuntimeErrors} companion resolution(s) failed to run at fill time — left unverified (aspect-companion-runtime-error).`,
      why: 'A companion.mjs crashed, returned an invalid result, or its observations changed mid-run. No verdict was written.',
      next: `Fix the failing companion.mjs, then re-run: ${retry}.`,
    });
  }
}

/** One pair this run could not fill, with the cause its diagnostic names. */
export interface FillCauseItem extends InfraDiagnosticItem {
  cause: UnverifiedCause;
}

/**
 * Name, on the post-fill report, the cause of every pair this run could not
 * fill. The report is rebuilt from the lock, and the lock records verdicts,
 * never failures — so without this a pair the reviewer never answered for, or
 * whose check.mjs crashed, reads as merely "not yet reviewed", its Fix and the
 * run's `Next:` point back at the very command that just failed, and the
 * `yg-check/1` document (whose consumers never see stderr) holds no trace of
 * the failure at all. Each matching `unverified` finding takes the cause and
 * the diagnostic this run already emitted for it — the same what/why/next —
 * and `suggestedNext` is recomputed, so an infrastructure cause outranks the
 * pairs one more `--approve` would fill.
 *
 * Only this run's report carries it: a later plain `yg check` reads the lock
 * alone and has no record of a failure it did not witness.
 */
export function annotateFillCauses(result: CheckResult, items: FillCauseItem[]): void {
  if (items.length === 0) return;
  const byPair = new Map<string, FillCauseItem>();
  for (const item of items) byPair.set(`${item.aspectId} ${toPosixPath(item.unitKey)}`, item);
  let changed = false;
  for (const issue of result.issues) {
    if (issue.code !== 'unverified' || issue.aspectId === undefined || issue.unitKey === undefined) continue;
    // A nodeless pair the report already traced to its runtime reason keeps that
    // message — it names the structural fix, where the raw diagnostic does not.
    if (issue.unverifiedCause === 'check-failed-to-run') continue;
    const item = byPair.get(`${issue.aspectId} ${toPosixPath(issue.unitKey)}`);
    if (item === undefined) continue;
    issue.unverifiedCause = item.cause;
    issue.messageData = item.messageData;
    changed = true;
  }
  if (changed) result.suggestedNext = computeSuggestedNext(result.issues);
}
