/**
 * source/cli/src/core/fill-report.ts — the facts behind what the fill stage
 * (spec §7) says out loud: the grouped infrastructure diagnostics each phase
 * collects, the deterministic gate's skip notices, and the closing summary.
 *
 * Two sinks, deliberately separate, and neither carries a sentence written here.
 * What the run did goes out as FillEvent data (model/fill-event.ts) — the pre-
 * dispatch header, the prune summary and the closing line are worded by
 * formatters/fill-text.ts, which the command layer applies. Structured
 * DIAGNOSTICS ({ what, why, next }) go to `emitIssue`, rendered by the command
 * layer too. This engine module only produces the data.
 */

import type { IssueMessage } from '../model/validation.js';
import type { FillEvent, FillEventSink, FillUsageTotals, FillProgressCounts, FillDispatchCounts } from '../model/fill-event.js';
import type { CheckResult } from './check-contract.js';
import type { UnverifiedCause } from '../utils/check-codes.js';
import { toPosixPath } from '../utils/posix.js';
import { count } from '../utils/count.js';

/**
 * What reviews the reviewer-rule pairs of a project with no reviewer: configuring
 * one is the user's decision (it sends code to that provider), so it is asked
 * for, with `--model` (required by every provider but claude-code) and the
 * draft alternative in view.
 */
const CONFIGURE_REVIEWER_NEXT = 'Ask the user to approve configuring a reviewer — yg init --provider <name> [--model <m>] — or set the reviewer rules to status: draft.';

/**
 * The pre-dispatch header (EXACT): counts of what will actually be filled, plus
 * what was deliberately left alone and why. Printed by a preview, or after the
 * log gate for a real run, so a gated run never announces a fill. With
 * `withNoReviewerNote`, the missing-reviewer note follows it.
 */
export function emitDispatchHeader(emit: FillEventSink, counts: Required<FillDispatchCounts>, withNoReviewerNote = true): void {
  emit({ type: 'dispatch', counts });
  // Judgment pairs in the fill set with no reviewer to call: only a preview or
  // an all-advisory project gets here (the structural gate stops the rest).
  if (withNoReviewerNote) emitNoReviewerNote(emit, counts.fillPairs - counts.detPairs, counts.reviewerConfigured, counts.preview);
}

/** The note under the header when reviewer pairs are counted but no reviewer is configured. */
export function emitNoReviewerNote(emit: FillEventSink, llmPairCount: number, reviewerConfigured: boolean, dryRun: boolean): void {
  if (!reviewerConfigured && llmPairCount > 0) {
    // Structured what / why / next; the renderer lays it out under the header.
    const noReviewer = {
      what: `No reviewer is configured — the ${count(llmPairCount, 'reviewer pair')} counted here cannot be reviewed.`,
      why: dryRun
        ? 'Reviewer rules are decided only by the configured reviewer; a fill would record the script rules and leave these pairs unverified.'
        : 'Reviewer rules are decided only by the configured reviewer; this run fills the script rules and leaves these pairs unverified.',
      next: CONFIGURE_REVIEWER_NEXT,
    };
    emit({ type: 'no-reviewer', message: noReviewer });
  }
}

/**
 * The event a signal-stopped run reports: how many of `total` pairs have a
 * verdict saved from this run, and whether the final lock write carrying them
 * succeeded.
 */
export function interruptedEvent(saved: number, total: number, flushed: boolean, retry: string): Extract<FillEvent, { type: 'interrupted' }> {
  const pairs = count(total, 'pair');
  return {
    type: 'interrupted',
    saved,
    total,
    flushed,
    message: flushed
      ? {
        what: `Interrupted — ${saved} of ${pairs} ${saved === 1 ? 'has' : 'have'} a verdict saved from this run.`,
        why: 'A signal stopped the run. Every verdict finished before it is in the lock; the reviewer calls still running were stopped, and the pairs without a verdict stay unverified.',
        next: `Re-run: ${retry} — it resumes, reviewing only the pairs without a verdict.`,
      }
      : {
        what: `Interrupted — the final lock write FAILED; up to ${saved} of ${pairs} may have lost the verdict this run gave them.`,
        why: 'A signal stopped the run, and writing the verdicts still held in memory to the lock failed. The reviewer calls still running were stopped.',
        next: `Re-run: ${retry} — every pair without a verdict in the lock is reviewed again.`,
      },
  };
}

/** One pair's infrastructure diagnostic, collected by a phase for grouped emission. */
// InfraDiagnosticItem lives in fill-shared.ts (see there); re-exported for this module's callers.
import type { InfraDiagnosticItem } from './fill-shared.js';
export type { InfraDiagnosticItem };

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
        what = `Script rule '${aspectId}' failed to run on ${unitKeys.length} units — left unverified (aspect-check-runtime-error): ${listed}${overflow}`;
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
      what: `Reviewer pairs for ${subject} skipped — an enforced script rule already refuses it.`,
      why: 'A free script rule rejects this unit, so paying the reviewer to read the same code would be wasted until the violations are fixed.',
      next: `Fix the script-rule violations on '${posixSubject}', then re-run ${retry}`,
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
  /** False when no reviewer is configured (the dispatch header says so too). */
  reviewerConfigured?: boolean;
  /** The command the run was invoked as, for every "then re-run" line. */
  retry?: string;
  /** Refusals the lock held for unchanged inputs before this run (they still stand). */
  cachedRefusals?: number;
  /** Wall time of the run so far, for the closing line. */
  elapsedMs?: number;
  /** Reviewer usage the provider reported, for the closing line. */
  usage?: FillUsageTotals;
  /** How every pair the run finished ended, for the closing line. */
  outcomes?: FillProgressCounts;
}

/**
 * Report what the finished fill did: one `totals` event (the closing line —
 * worded by formatters/fill-text.ts, which says what WAS done and claims "all
 * expected pairs hold valid verdicts" only when this run neither filled nor
 * skipped anything), then one diagnostic per non-zero no-write disposition
 * class.
 */
export function reportFillTotals(
  totals: FillTotals,
  emit: FillEventSink,
  emitIssue: (msg: IssueMessage) => void,
): void {
  const retry = totals.retry ?? 'yg check --approve';
  emit({
    type: 'totals',
    totals: {
      reviewerCallsMade: totals.reviewerCallsMade,
      infraFailures: totals.infraFailures,
      runtimeErrors: totals.runtimeErrors,
      companionRuntimeErrors: totals.companionRuntimeErrors,
      malformedSuppressErrors: totals.malformedSuppressErrors,
      skippedLlmPairs: totals.skippedLlmPairs,
      skippedOutsideLlmPairs: totals.skippedOutsideLlmPairs,
      detApproved: totals.detApproved ?? 0,
      detRefused: totals.detRefused ?? 0,
      skippedByDetGate: totals.skippedByDetGate ?? 0,
      ...(totals.reviewerConfigured !== undefined ? { reviewerConfigured: totals.reviewerConfigured } : {}),
      ...(totals.cachedRefusals !== undefined ? { cachedRefusals: totals.cachedRefusals } : {}),
      ...(totals.elapsedMs !== undefined ? { elapsedMs: totals.elapsedMs } : {}),
      ...(totals.usage !== undefined ? { usage: totals.usage } : {}),
      ...(totals.outcomes !== undefined ? { outcomes: totals.outcomes } : {}),
    },
  });
  if (totals.infraFailures > 0) {
    const providers = [...new Set(totals.infraReport.map((r) => r.provider).filter(Boolean))].join(', ');
    const tiers = [...new Set(totals.infraReport.map((r) => r.tier).filter(Boolean))].join(', ');
    const ids = [providers, tiers].filter((s) => s.length > 0).join(' / ');
    emitIssue({
      what: `${totals.infraFailures} ${totals.infraFailures === 1 ? 'pair' : 'pairs'} failed on provider/config errors — re-running will not help until the connection/config is fixed${ids ? ` (${ids})` : ''}.`,
      why: 'These pairs hit an infrastructure disposition (provider unreachable, tier unresolved, reference unreadable, an unparseable response, or a prompt-too-large gate). No verdict was written; the pairs stay unverified and the run ends red.',
      next: `Fix the reviewer connection or configuration, then re-run ${retry}. To unblock CI without a reviewer, set the affected rules to status: draft.`,
    });
  }
  if (totals.runtimeErrors > 0) {
    emitIssue({
      what: `${totals.runtimeErrors} script ${totals.runtimeErrors === 1 ? 'check' : 'checks'} failed to run at fill time — left unverified (aspect-check-runtime-error).`,
      why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
      next: `Fix the failing check.mjs, then re-run ${retry}.`,
    });
  }
  if (totals.malformedSuppressErrors > 0) {
    emitIssue({
      what: `${totals.malformedSuppressErrors} ${totals.malformedSuppressErrors === 1 ? 'pair' : 'pairs'} left unverified by a malformed yg-suppress marker (malformed-suppress-marker).`,
      why: 'A yg-suppress marker in a mapped source file is missing its required reason. This is a fault in the marker itself, not in the aspect being checked; no verdict was written.',
      next: `Add a reason to the marker (or remove it), then re-run ${retry}.`,
    });
  }
  if (totals.companionRuntimeErrors > 0) {
    emitIssue({
      what: `${totals.companionRuntimeErrors} companion ${totals.companionRuntimeErrors === 1 ? 'resolution' : 'resolutions'} failed to run at fill time — left unverified (aspect-companion-runtime-error).`,
      why: 'A companion.mjs crashed, returned an invalid result, or its observations changed mid-run. No verdict was written.',
      next: `Fix the failing companion.mjs, then re-run ${retry}.`,
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
 * so the report's step, worked out from the findings when it is rendered,
 * names the infrastructure cause before the pairs one more `--approve` would
 * fill.
 *
 * Only this run's report carries it: a later plain `yg check` reads the lock
 * alone and has no record of a failure it did not witness. `retry` is the
 * command this run was invoked as; a pair whose check.mjs failed carries it as
 * the step after the fix.
 */
export function annotateFillCauses(result: CheckResult, items: FillCauseItem[], retry?: string): void {
  if (items.length === 0) return;
  const byPair = new Map<string, FillCauseItem>();
  for (const item of items) byPair.set(`${item.aspectId} ${toPosixPath(item.unitKey)}`, item);
  for (const issue of result.issues) {
    if (issue.code !== 'unverified' || issue.aspectId === undefined || issue.unitKey === undefined) continue;
    // A nodeless pair the report already traced to its runtime reason keeps that
    // message — it names the structural fix, where the raw diagnostic does not.
    if (issue.unverifiedCause === 'check-failed-to-run') continue;
    const item = byPair.get(`${issue.aspectId} ${toPosixPath(issue.unitKey)}`);
    if (item === undefined) continue;
    issue.unverifiedCause = item.cause;
    // A script that failed to run is fixed in the script, then re-run in the
    // mode that failed on it — never a costlier one.
    issue.messageData = item.cause === 'check-failed-to-run' && retry !== undefined ? { ...item.messageData, retry } : item.messageData;
  }
}
