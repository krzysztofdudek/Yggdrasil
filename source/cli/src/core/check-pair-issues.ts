/**
 * source/cli/src/core/check-pair-issues.ts — the translation from ONE verified
 * pair's state into the issues a check reports for it (spec §6/§10).
 *
 * The lock verification decides what a pair's state IS; this module decides what
 * the agent is TOLD about it. Keeping the two apart means the severity/precedence
 * rules below — an advisory rule warns where an enforced one blocks, a size-gate
 * failure replaces the unverified it would otherwise duplicate, and a pair that
 * holds a valid verdict yet still assembles an oversized prompt reports both —
 * live in one readable switch instead of being spread through the verifier.
 *
 * Pure and synchronous: it reads the pair and the runtime rows it is handed, and
 * touches nothing else.
 */

import type { VerifiedPair } from './verify-lock.js';
import {
  unverifiedMessage,
  llmRefusedMessage,
  detRefusedMessage,
  promptTooLargeMessage,
} from '../formatters/lock-issue-messages.js';
import { unverifiedIssueMessage, type TypeVisibilityReport } from './type-visibility.js';
import type { CheckIssue } from './check-contract.js';

/** Fallback text when a refused verdict carries no stored reason. Single source of truth. */
const NO_REASON_FALLBACK = 'no violation details recorded';

/**
 * Turn a VerifiedPair into zero, one, or two CheckIssues (spec §6/§10):
 *   - verified            → no issue.
 *   - refused (enforced)  → aspect-violation-enforced (error).
 *   - refused (advisory)  → aspect-violation-advisory (warning).
 *   - unverified          → unverified (error if enforced, warning if advisory).
 *   - prompt-too-large    → prompt-too-large (error); REPLACES unverified (gate
 *                           precedence) — no duplicate unverified is emitted.
 *   - valid + oversized   → the verdict issue PLUS a prompt-too-large error
 *                           (the verdict still renders; the gate also surfaces).
 *
 * Severity follows the pair's EFFECTIVE status, recomputed live in pair.status.
 */
export function emitPairIssue(vp: VerifiedPair, rtRows: TypeVisibilityReport['rows']): CheckIssue[] {
  const { pair, state } = vp;
  const issues: CheckIssue[] = [];
  const enforced = pair.status === 'enforced';

  switch (state.kind) {
    case 'verified':
      break;
    case 'refused': {
      const reason = state.reason ?? NO_REASON_FALLBACK;
      const md =
        pair.kind === 'llm'
          ? llmRefusedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey, reason, judge: vp.judge?.name })
          : detRefusedMessage({ aspectId: pair.aspectId, unitKey: pair.unitKey, reason });
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: enforced ? 'aspect-violation-enforced' : 'aspect-violation-advisory',
        rule: enforced ? 'aspect-violation-enforced' : 'aspect-violation-advisory',
        messageData: md,
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        pairKind: pair.kind,
        unitKey: pair.unitKey,
      });
      break;
    }
    case 'unverified':
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: 'unverified',
        rule: 'unverified',
        messageData: unverifiedIssueMessage(rtRows, pair, unverifiedMessage),
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        pairKind: pair.kind,
        unitKey: pair.unitKey,
      });
      break;
    case 'prompt-too-large':
      issues.push({
        severity: 'error',
        code: 'prompt-too-large',
        rule: 'prompt-too-large',
        messageData: promptTooLargeMessage({
          aspectId: pair.aspectId,
          unitKey: pair.unitKey,
          tierName: state.tierName,
          chars: state.chars,
          limit: state.limit,
        }),
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        unitKey: pair.unitKey,
      });
      break;
    case 'companion-error':
      // The companion resolver (run live to size the §4 gate) failed — the pair
      // cannot be assembled. Surface the hook's own what/why/next so the agent
      // diagnoses immediately. Enforced → error (blocks); advisory → warning.
      issues.push({
        severity: enforced ? 'error' : 'warning',
        code: 'aspect-companion-runtime-error',
        rule: 'aspect-companion-runtime-error',
        messageData: state.messageData,
        nodePath: pair.nodePath,
        aspectId: pair.aspectId,
        unitKey: pair.unitKey,
      });
      break;
  }

  // Valid-but-oversized: the verdict issue (if any) was already pushed above;
  // additionally surface the gate error so size remedies reach the agent.
  if (vp.oversized) {
    issues.push({
      severity: 'error',
      code: 'prompt-too-large',
      rule: 'prompt-too-large',
      messageData: promptTooLargeMessage({
        aspectId: pair.aspectId,
        unitKey: pair.unitKey,
        tierName: vp.oversized.tierName,
        chars: vp.oversized.chars,
        limit: vp.oversized.limit,
      }),
      nodePath: pair.nodePath,
      aspectId: pair.aspectId,
      unitKey: pair.unitKey,
    });
  }

  return issues;
}
