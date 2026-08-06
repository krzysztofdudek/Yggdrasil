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
import { toPosixPath } from '../utils/posix.js';

/** One pair's infrastructure diagnostic, collected by a phase for grouped emission. */
export interface InfraDiagnosticItem {
  aspectId: string;
  unitKey: string;
  messageData: IssueMessage;
}

/**
 * Print the pre-dispatch header (EXACT wording): how many pairs this run will
 * fill, over how many subjects, and what the reviewer-call budget is.
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
    unverifiedPairs: number;
    nodeCount: number;
    fileCount: number;
    detPairs: number;
    reviewerCallBudget: number;
    skippedLlmPairs: number;
  },
  write: (s: string) => void,
): void {
  const acrossLabel = counts.fileCount > 0
    ? `${counts.nodeCount} components and ${counts.fileCount} files`
    : `${counts.nodeCount} nodes`;
  write(
    `Filling ${counts.unverifiedPairs} unverified pairs across ${acrossLabel} — ` +
      `${counts.detPairs} deterministic (no cost), ${counts.reviewerCallBudget} reviewer calls (consensus included)\n`,
  );
  // Deterministic-only mode fills the free deterministic pairs but leaves every
  // unverified LLM pair untouched. Say so up front — otherwise the header reads
  // as if all N unverified pairs are being handled this run.
  if (counts.skippedLlmPairs > 0) {
    write(
      `  Deterministic-only mode — ${counts.skippedLlmPairs} LLM pair${counts.skippedLlmPairs === 1 ? '' : 's'} will NOT be reviewed this run; ` +
        `run \`yg check --approve\` to review ${counts.skippedLlmPairs === 1 ? 'it' : 'them'}.\n`,
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
export function emitDetGateSkips(gateKeys: Iterable<string>, emitIssue: (msg: IssueMessage) => void): void {
  for (const key of gateKeys) {
    const isFile = key.startsWith('file:');
    const posixSubject = toPosixPath(isFile ? key.slice('file:'.length) : key);
    const subject = isFile ? `file '${posixSubject}'` : `node '${posixSubject}'`;
    emitIssue({
      what: `LLM fills for ${subject} skipped — an enforced deterministic check already refused it.`,
      why: 'A free deterministic check rejects this unit, so paying the reviewer to read the same code would be wasted. Fix the deterministic violations first.',
      next: `Fix the deterministic violations on '${posixSubject}', then re-run: yg check --approve`,
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
  /** Provider/tier identities behind the infra dispositions, for the summary's parenthetical. */
  infraReport: Array<{ provider?: string; tier?: string }>;
}

/**
 * Report what the finished fill did: the "0 reviewer calls" line when nothing
 * needed doing, then one diagnostic per non-zero no-write disposition class.
 */
export function reportFillTotals(
  totals: FillTotals,
  write: (s: string) => void,
  emitIssue: (msg: IssueMessage) => void,
): void {
  if (
    totals.reviewerCallsMade === 0 &&
    totals.infraFailures === 0 &&
    totals.runtimeErrors === 0 &&
    totals.companionRuntimeErrors === 0 &&
    totals.malformedSuppressErrors === 0
  ) {
    if (totals.skippedLlmPairs > 0) {
      // --only-deterministic made no reviewer calls BY DESIGN, but LLM pairs were
      // left unverified — do NOT claim every pair holds a valid verdict.
      write(
        `0 reviewer calls made — deterministic-only mode; ${totals.skippedLlmPairs} LLM pair${totals.skippedLlmPairs === 1 ? '' : 's'} left unverified. ` +
          `Run \`yg check --approve\` to review ${totals.skippedLlmPairs === 1 ? 'it' : 'them'}.\n`,
      );
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
      next: 'Fix the reviewer connection/configuration, then re-run: yg check --approve. To unblock CI without a reviewer, set the affected aspect(s) to status: draft.',
    });
  }
  if (totals.runtimeErrors > 0) {
    emitIssue({
      what: `${totals.runtimeErrors} deterministic check(s) failed to run at fill time — left unverified (aspect-check-runtime-error).`,
      why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
      next: 'Fix the failing check.mjs, then re-run: yg check --approve.',
    });
  }
  if (totals.malformedSuppressErrors > 0) {
    emitIssue({
      what: `${totals.malformedSuppressErrors} pair(s) left unverified by a malformed yg-suppress marker (malformed-suppress-marker).`,
      why: 'A yg-suppress marker in a mapped source file is missing its required reason. This is a fault in the marker itself, not in the aspect being checked; no verdict was written.',
      next: 'Add a reason to the marker (or remove it), then re-run: yg check --approve.',
    });
  }
  if (totals.companionRuntimeErrors > 0) {
    emitIssue({
      what: `${totals.companionRuntimeErrors} companion resolution(s) failed to run at fill time — left unverified (aspect-companion-runtime-error).`,
      why: 'A companion.mjs crashed, returned an invalid result, or its observations changed mid-run. No verdict was written.',
      next: 'Fix the failing companion.mjs, then re-run: yg check --approve.',
    });
  }
}
