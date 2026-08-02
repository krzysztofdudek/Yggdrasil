// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckResult } from '../core/check.js';
import type { TypeVisibilityReport } from '../core/type-visibility.js';
import { describeTypeVisibilityReason, describeChainTermination } from '../core/type-visibility.js';
import { describeCascadeCycle } from '../core/type-effective.js';

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
// counts), a half-expanded bundle, where the inherited chain stops, which of
// the type's own files could not have their rules worked out at all (an
// aspect implies cycle — named the same way `yg owner --file` / `yg context
// --file` already name it, never a bare "nothing applies"), plus the
// repo-wide zero-applicable-rules line. A statement of fact, not a warning —
// printed in every view, same posture as the zero-classifying-types notice.

/** Matches the rest of the check summary's own list-truncation cap. */
const FILE_LIST_CAP = 12;

/** Cap on how many aspect ids one reason group lists before summarizing the rest — a type where many aspects share ONE reason must not render an unbounded line. */
const DROPPED_LIST_CAP = 12;

/**
 * One line per DISTINCT reason among `dropped`, the reason phrase stated
 * ONCE, followed by every aspect id it applies to (capped, with a count of
 * the rest). Reason text repeats for every (aspectId, reason) pair; capping
 * that flat list only trimmed a fixture type observed producing ~1300
 * characters down to ~1072 — still every entry paying for the same long
 * phrase again. Grouping by reason instead pays for the phrase once per
 * distinct reason (at most nine, the full width of `TypeVisibilityReason`)
 * regardless of how many aspects share it.
 */
function renderReasonGroups(dropped: TypeVisibilityReport['byType'][number]['dropped']): string[] {
  const reasons = [...new Set(dropped.map((d) => d.reason))].sort();
  return reasons.map((reason) => {
    const entries = dropped.filter((d) => d.reason === reason);
    const shown = entries.slice(0, DROPPED_LIST_CAP);
    const rendered = shown.map((e) => `${e.aspectId} (${e.count})`).join(', ');
    const overflow = entries.length > DROPPED_LIST_CAP ? ` ... and ${entries.length - DROPPED_LIST_CAP} more` : '';
    const phrase = describeTypeVisibilityReason(reason);
    const capitalized = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    return `${capitalized}: ${rendered}${overflow}`;
  });
}

/**
 * One line per uncomputable group: the files sharing ONE cascade cycle,
 * followed by the SAME `why` sentence `yg owner --file` / `yg context --file`
 * already print for the identical fact (`describeCascadeCycle` — never
 * restated here, so the three surfaces cannot disagree). Shares its file-list
 * cap with `renderReasonGroups` (`DROPPED_LIST_CAP`) — a type whose cycle
 * spans many files must not render an unbounded line either.
 */
function renderUncomputableGroups(groups: TypeVisibilityReport['uncomputable']['groups']): string[] {
  return groups.map((group) => {
    const shown = group.files.slice(0, DROPPED_LIST_CAP);
    const overflow = group.files.length > DROPPED_LIST_CAP ? ` ... and ${group.files.length - DROPPED_LIST_CAP} more` : '';
    return `${shown.join(', ')}${overflow} — ${describeCascadeCycle({ aspectId: group.aspectId })}`;
  });
}

/**
 * Grammar for the zero-enforcement sentence, singular vs. plural — every word
 * that agrees with `count` lives here so a singular file never reads "they
 * satisfy" (an earlier defect: the verb-and-pronoun clause was hardcoded to
 * the plural form regardless of `count`).
 */
function zeroEnforcementGrammar(count: number): { has: string; it: string; subject: string; satisfy: string } {
  return count === 1
    ? { has: 'has', it: 'it', subject: 'it', satisfy: 'satisfies' }
    : { has: 'have', it: 'them', subject: 'they', satisfy: 'satisfy' };
}

/**
 * How many of an (aspectId, file-count) pair's own files have NO confirmed
 * verdict — a real `ok`/`refused` outcome ever recorded — versus still
 * sitting `unverified`. `enforced/enforcedCounts` name effective STATUS (the
 * architecture says this aspect blocks on these files); a file can carry that
 * status while its pair has never once produced a real verdict, which is
 * exactly the shape a rule that structurally cannot run on a type-covered
 * file takes (it infra-errors on every fill, forever, and just sits
 * unverified). Cross-referencing `result.issues`' OWN `unverified` entries —
 * the same ones plain `yg check`'s Errors section already lists — costs
 * nothing new to compute and can never itself drift from what the rest of
 * this same report already says.
 */
function unverifiedFileCount(result: CheckResult, aspectId: string, files: string[]): number {
  const unverifiedKeys = new Set(
    result.issues
      .filter((i) => i.code === 'unverified' && i.aspectId === aspectId && i.unitKey?.startsWith('file:'))
      .map((i) => i.unitKey!.slice('file:'.length)),
  );
  return files.filter((f) => unverifiedKeys.has(f)).length;
}

/**
 * `(aspectId, count)` list → the rendered `aspectId (count)` segments this
 * block always showed, now with `, K unverified` appended whenever K > 0 of
 * that aspect's own files (from `block.files`) have no confirmed verdict —
 * see `unverifiedFileCount`. K === 0 (every file behind this aspect has a
 * real recorded outcome) renders byte-identical to the pre-caveat text.
 */
function renderCountList(
  result: CheckResult,
  entries: Array<{ aspectId: string; count: number }>,
  files: string[],
): string {
  return entries
    .map((e) => {
      const unverified = unverifiedFileCount(result, e.aspectId, files);
      const caveat = unverified > 0 ? `, ${unverified} unverified` : '';
      return `${e.aspectId} (${e.count}${caveat})`;
    })
    .join(', ');
}

/**
 * `countsOnly`: the counts-only triage views (--summary, --top) print this
 * block ahead of their own narrowed body (same posture as the zero-
 * classifying-types notice), so it must stay to COUNTS there — never the
 * per-aspect reason breakdown, half-expanded-bundle names, chain-termination
 * text, or zero-enforcement file samples a full `yg check` shows. Those views
 * exist specifically to keep the wall short; this block must not undo that.
 */
export function renderTypeVisibilityBlock(result: CheckResult, opts?: { countsOnly?: boolean }): string {
  const report = result.typeVisibility;
  if (!report) return '';
  const countsOnly = opts?.countsOnly ?? false;
  const lines: string[] = ['Type coverage:'];
  for (const block of report.byType) {
    // A FILE count, never a rule count: resolution never ran for these files,
    // so how many of the type's declared rules would have ended up unresolved
    // is unknowable — only how many files hit the cycle is. `g.aspectId`
    // groups by the aspect at which each file's cascade cycled, but summing
    // `g.files.length` across groups counts FILES, not distinct rules.
    const uncomputableTotal = block.uncomputable.reduce((n, g) => n + g.files.length, 0);
    if (countsOnly) {
      const droppedTotal = block.dropped.reduce((n, d) => n + d.count, 0);
      const uncomputableSuffix = uncomputableTotal > 0
        ? `, ${uncomputableTotal} file${uncomputableTotal === 1 ? '' : 's'} could not have ${uncomputableTotal === 1 ? 'its' : 'their'} rules worked out (aspect implies cycle)`
        : '';
      lines.push(
        `  '${block.typeId}' — ${block.files.length} file${block.files.length === 1 ? '' : 's'} covered — ` +
        `${block.enforcedCounts.length} rule${block.enforcedCounts.length === 1 ? '' : 's'} enforced, ` +
        `${block.advisoryCounts.length} advisory, ${droppedTotal} attached-but-not-enforced instance${droppedTotal === 1 ? '' : 's'}${uncomputableSuffix}`,
      );
      continue;
    }
    const shown = block.files.slice(0, FILE_LIST_CAP);
    const overflow = block.files.length > FILE_LIST_CAP ? ` ... and ${block.files.length - FILE_LIST_CAP} more` : '';
    lines.push(`  '${block.typeId}' — ${block.files.length} file${block.files.length === 1 ? '' : 's'} covered: ${shown.join(', ')}${overflow}`);
    if (block.uncomputable.length > 0) {
      lines.push('    Rules could not be worked out:');
      for (const line of renderUncomputableGroups(block.uncomputable)) lines.push(`      ${line}`);
    }
    const enforcedList = renderCountList(result, block.enforcedCounts, block.files);
    lines.push(`    Enforced: ${enforcedList.length > 0 ? enforcedList : '(none)'}`);
    if (block.advisoryCounts.length > 0) {
      const advisoryList = renderCountList(result, block.advisoryCounts, block.files);
      lines.push(`    Advisory (runs, never blocks): ${advisoryList}`);
    }
    if (block.dropped.length > 0) {
      lines.push('    Attached but not enforced:');
      for (const reasonLine of renderReasonGroups(block.dropped)) lines.push(`      ${reasonLine}`);
    }
    for (const b of block.halfExpandedBundles) {
      lines.push(`    ${b.bundleId}: file-level part applies; whole-unit part needs a component`);
    }
    lines.push(`    ${describeChainTermination(block.chainTermination)}`);
  }
  const uc = report.uncomputable;
  if (uc.count > 0) {
    lines.push('');
    const suffix = countsOnly ? '.' : ':';
    lines.push(`${uc.count} file${uc.count === 1 ? '' : 's'} matched by a type could not have ${uc.count === 1 ? 'its' : 'their'} rules worked out${suffix}`);
    if (!countsOnly) {
      for (const line of renderUncomputableGroups(uc.groups)) lines.push(`  ${line}`);
    }
  }
  const zc = report.zeroEnforcement;
  if (zc.count > 0) {
    const g = zeroEnforcementGrammar(zc.count);
    lines.push('');
    const suffix = countsOnly ? '.' : ':';
    lines.push(`${zc.count} file${zc.count === 1 ? '' : 's'} matched by a type ${g.has} no rules that apply to ${g.it} — ${g.subject} ${g.satisfy} coverage with no enforcement${suffix}`);
    if (!countsOnly) {
      for (const f of zc.samples) lines.push(`  - ${f}`);
      if (zc.count > zc.samples.length) lines.push(`  ... and ${zc.count - zc.samples.length} more`);
    }
  }
  return lines.join('\n');
}
