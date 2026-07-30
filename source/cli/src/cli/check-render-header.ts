// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckResult } from '../core/check.js';
import type { TypeVisibilityReport } from '../core/type-visibility.js';
import { describeTypeVisibilityReason, describeChainTermination } from '../core/type-visibility.js';

// ── Emoji gate ─────────────────────────────────────────────

/**
 * Emoji decoration is gated on color support.  When chalk has no color
 * (NO_COLOR env var, non-color terminal, chalk.level === 0) the output is
 * byte-identical to the pre-emoji text — no leading character, no extra space.
 * Emoji is decoration only; verdict and severity are always readable as plain
 * text without it.
 *
 * Exported so tests can read the current gate value; the optional `useEmoji`
 * parameter on `formatOutput` allows tests to override it without mocking.
 */
export const useEmoji: boolean = chalk.level > 0;

// ── Header ─────────────────────────────────────────────────

export function renderHeader(result: CheckResult, errorCount: number, warningCount: number, autoFilled = false, emoji = useEmoji): string {
  let verdict: string;
  if (errorCount > 0) {
    // auto-filled marker is a PASS qualifier only — never shown on FAIL.
    verdict = chalk.red('yg check: FAIL');
  } else if (autoFilled && warningCount > 0) {
    verdict = `${chalk.green('yg check: PASS')} (auto-filled, ${warningCount} warning${warningCount === 1 ? '' : 's'})`;
  } else if (autoFilled) {
    verdict = `${chalk.green('yg check: PASS')} (auto-filled)`;
  } else if (warningCount > 0) {
    verdict = `${chalk.green('yg check: PASS')} (${warningCount} warning${warningCount === 1 ? '' : 's'})`;
  } else {
    verdict = chalk.green('yg check: PASS');
  }

  const emojiPrefix = emoji ? (errorCount > 0 ? '❌ ' : '✅ ') : '';

  const metrics: string[] = [`${result.nodeCount} nodes`];

  if (result.totalFiles > 0) {
    if (result.typeLevel) {
      // Three honest terms, not a flat percentage. "node-owned" is
      // nodeOwnedFiles (an actual node mapping), NEVER the legacy
      // coveredFiles (which also folds in excluded-root files) — an
      // excluded file gets its own term instead. Flag off is byte-identical
      // below, using coveredFiles exactly as before.
      const nodeOwned = result.nodeOwnedFiles ?? 0;
      const typeCovered = result.typeCoveredCount ?? 0;
      const excluded = result.excludedFiles ?? 0;
      metrics.push(`${nodeOwned + typeCovered + excluded}/${result.totalFiles} files (${nodeOwned} node-owned, ${typeCovered} type-covered, ${excluded} excluded)`);
    } else if (result.coveredFiles < result.totalFiles) {
      metrics.push(`${result.coveredFiles}/${result.totalFiles} files (${Math.round((result.coveredFiles / result.totalFiles) * 100)}%)`);
    } else {
      metrics.push(`${result.coveredFiles}/${result.totalFiles} files`);
    }
  }

  metrics.push(`${result.aspectCount} aspects`);
  metrics.push(`${result.flowCount} flows`);

  const verifiedTotal = result.verifiedDet + result.verifiedLlm;
  if (verifiedTotal > 0) {
    metrics.push(`${verifiedTotal} verified (${result.verifiedDet} deterministic, ${result.verifiedLlm} LLM)`);
  }

  if (result.draftSkipped > 0) {
    metrics.push(`${result.draftSkipped} draft`);
  }

  return `${emojiPrefix}${verdict}  ${metrics.join(' · ')}`;
}

// ── Type-visibility block ───────────────────────────────────
//
// Honesty surface for the type-level tier (core/type-visibility.ts): per
// matched type, which rules enforce, which are attached but do not (with
// counts), a half-expanded bundle, where the inherited chain stops, plus the
// repo-wide zero-applicable-rules line. A statement of fact, not a warning —
// printed in every view, same posture as the zero-classifying-types notice.

/** Matches the rest of the check summary's own list-truncation cap. */
const FILE_LIST_CAP = 12;

function renderReasonCounts(dropped: TypeVisibilityReport['byType'][number]['dropped']): string {
  return dropped.map((d) => `${d.aspectId} (${describeTypeVisibilityReason(d.reason)}, ${d.count})`).join(', ');
}

export function renderTypeVisibilityBlock(result: CheckResult): string {
  const report = result.typeVisibility;
  if (!report) return '';
  const lines: string[] = ['Type coverage:'];
  for (const block of report.byType) {
    const shown = block.files.slice(0, FILE_LIST_CAP);
    const overflow = block.files.length > FILE_LIST_CAP ? ` ... and ${block.files.length - FILE_LIST_CAP} more` : '';
    lines.push(`  '${block.typeId}' — ${block.files.length} file${block.files.length === 1 ? '' : 's'} covered: ${shown.join(', ')}${overflow}`);
    const enforcedList = block.enforcedCounts.map((e) => `${e.aspectId} (${e.count})`).join(', ');
    lines.push(`    Enforced: ${enforcedList.length > 0 ? enforcedList : '(none)'}`);
    if (block.dropped.length > 0) {
      lines.push(`    Attached but not enforced: ${renderReasonCounts(block.dropped)}`);
    }
    for (const b of block.halfExpandedBundles) {
      lines.push(`    ${b.bundleId}: file-level part applies; whole-unit part needs a component`);
    }
    lines.push(`    ${describeChainTermination(block.chainTermination)}`);
  }
  const zc = report.zeroEnforcement;
  if (zc.count > 0) {
    const plural = zc.count === 1 ? { v: 'has', it: 'it' } : { v: 'have', it: 'them' };
    lines.push('');
    lines.push(`${zc.count} file${zc.count === 1 ? '' : 's'} matched by a type ${plural.v} no rules that apply to ${plural.it} — they satisfy coverage with no enforcement:`);
    for (const f of zc.samples) lines.push(`  - ${f}`);
    if (zc.count > zc.samples.length) lines.push(`  ... and ${zc.count - zc.samples.length} more`);
  }
  return lines.join('\n');
}
