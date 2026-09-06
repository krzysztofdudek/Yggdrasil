// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckResult } from '../core/check.js';
import type { TypeVisibilityReason, TypeVisibilityReport } from '../core/type-visibility.js';
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

/**
 * The header's account of a run that measured a change against a reference
 * branch: how much of the project's enforced debt this run declined to block
 * on, and how big the change it measured was.
 *
 * Absent — not zeroed — for every run that measured nothing: no reference
 * configured, the whole project explicitly asked for, or a state that could not
 * be measured (which gets its own notice instead). That absence is what keeps a
 * project that never opted in byte-identical to what this command always
 * printed.
 *
 * The two shapes are genuinely different statements, not one sentence with a
 * zero in it. "Nothing in scope" is the answer for a checkout that carries no
 * change at all — a reference branch in CI, a clean working copy — where a
 * count of changed inputs would only invite the reading "0 files, therefore
 * this run proved nothing". It did prove something: that everything it found
 * was already there.
 *
 * That sentence is claimed only when the report can back it up, which is why it
 * reads `errorCount` as well. A count of zero changed inputs is not quite proof
 * that nothing was in scope: a change consisting ONLY of engine output — a
 * commit that deletes entries from the committed verdict record, say — is
 * counted as zero changed inputs (those files are dropped unread) while the
 * obligations whose verdicts it destroyed ARE in scope and DO block. Printing
 * "nothing in scope" beside those errors would contradict the very list under
 * it, so a run with anything blocking gets the plain shape instead, zero and
 * all.
 *
 * Exported because the `--aspect` drill-in view (check-render-views.ts) OVERWRITES
 * the header line this normally feeds with its own aspect-scoped verdict, which
 * silently dropped the change-scope segment; that view calls this directly,
 * with the SAME `errorCount` (the true total, not the aspect-filtered one) the
 * plain header would have used, so it reprints the identical sentence rather
 * than computing a second, aspect-scoped number nothing else in the report
 * shows.
 */
export function renderChangeScope(result: CheckResult, errorCount: number): string | undefined {
  const reference = result.progressiveReference;
  if (reference === undefined) return undefined;
  const outside = result.outsideCount ?? 0;
  const changed = result.changedInputCount ?? 0;
  const obligations = `${outside} obligation${outside === 1 ? '' : 's'} outside your changes vs ${reference}`;
  return changed === 0 && errorCount === 0
    ? `nothing in scope; ${obligations}`
    : `${obligations} (${changed} changed input${changed === 1 ? '' : 's'})`;
}

/**
 * The one line the content check owes a person, or nothing when it has nothing
 * to say. A standing statement of fact, printed ahead of every view beside the
 * other such lines — never an issue, never counted, never blocking.
 *
 * It exists because both of the states it reports are otherwise INVISIBLE. A
 * finding the content check kept is reported exactly like any other blocking
 * finding, so a repository where every file legitimately differs from its stored
 * form — a committed `.gitattributes` with `text eol=`/`filter=`, or large-file
 * storage, on any platform and in CI as readily as on a laptop — has every
 * inherited finding kept on every run while the header goes on claiming a
 * measurement was made. That is a mode which has effectively switched itself off,
 * and it must say so in its own output rather than only in its documentation. The
 * second state is the same failure with a different cause: ids this build cannot
 * reproduce, where the check could not be made at all.
 *
 * The closing clause names the cost that state actually carries, which is not
 * the extra gating: nothing is left inherited, so a recording run pays to review
 * the whole project. That is ordinary behaviour for a run with nothing outside
 * it — it predates any of this — but it is what a person on such a checkout
 * feels, and it is worth saying beside the reason.
 *
 * Says nothing at all in the ordinary case (zero kept, ids readable), so a run
 * that never met either state prints exactly what it always printed.
 */
export function renderByteGuardNotice(result: CheckResult): string | undefined {
  const reference = result.progressiveReference;
  if (reference === undefined) return undefined;
  if (result.byteGuardUnavailable === true) {
    return `Content check skipped: '${reference}' records file identifiers this version cannot reproduce, so findings were judged on git's report of what changed and nothing else.`;
  }
  const kept = result.byteGuardKept ?? 0;
  if (kept === 0) return undefined;
  return `Content check: ${kept} finding${kept === 1 ? '' : 's'} kept in scope — the file${kept === 1 ? '' : 's'} behind ${kept === 1 ? 'it' : 'them'} differ${kept === 1 ? 's' : ''} from '${reference}' although git reports no change there. If that happens to everything on every run, something is rewriting files between storage and your working copy (a committed .gitattributes 'text eol='/'filter=', or large-file storage) — nothing is then inherited, so 'yg check --approve' pays to review the whole project.`;
}

/**
 * The one line a run owes anyone reading a report that is mostly not about
 * their change.
 *
 * A repository that has just switched on a mined graph starts with a fixed
 * population of refusals standing on code nobody in the current change wrote —
 * advisory ones, which warn forever, and, under a measured run, enforced ones
 * held outside the change. Every run reports them faithfully, and until now
 * nothing said what they ARE, so each reader either worked it out or read the
 * report as a verdict on their own work. This states it once and says nothing
 * at all when nothing is standing there.
 *
 * Only ever printed for a run that MEASURED something: with no reference branch
 * there is no "code this change did not touch" to speak of, and naming one
 * would be an invention.
 */
export function renderBaselineNoiseNotice(result: CheckResult): string | undefined {
  const noise = result.baselineNoise;
  if (noise === undefined) return undefined;
  const { advisory, enforcedOutside } = noise;
  const total = advisory + enforcedOutside;
  if (total === 0) return undefined;
  const parts: string[] = [];
  if (advisory > 0) parts.push(`${advisory} advisory refusal${advisory === 1 ? '' : 's'}`);
  if (enforcedOutside > 0) {
    parts.push(`${enforcedOutside} enforced finding${enforcedOutside === 1 ? '' : 's'} held outside it`);
  }
  return `${parts.join(' and ')} ${total === 1 ? 'stands' : 'stand'} on code this change did not touch — that is the baseline this repository already had, not a result of your change.`;
}

/**
 * The one line that makes an invisible setting visible: with nothing named
 * under `coverage.required`, a file no component owns can never fail a check,
 * however many runs list it.
 *
 * It is the shipped default — a fresh project and a mined proposal both start
 * there — and its consequence is invisible precisely because the uncovered
 * files ARE reported: only their severity differs, and severity is the one
 * thing a reader cannot see from the list. Said once, as a standing fact about
 * the configuration rather than as a finding, and it stops appearing the moment
 * either half stops being true — a required root is named, or nothing is left
 * uncovered.
 */
export function renderCoverageRequiresNothingNotice(result: CheckResult): string | undefined {
  if (result.coverageRequiresNothing !== true) return undefined;
  const uncovered = result.issues
    .filter((i) => i.code === 'uncovered-advisory')
    .reduce((n, i) => n + (i.uncoveredCount ?? 0), 0);
  if (uncovered === 0) return undefined;
  return `Nothing is required to be covered, so the ${uncovered} uncovered file${uncovered === 1 ? '' : 's'} this run lists can never fail a check — only ever be listed. Name a path under coverage.required in .yggdrasil/yg-config.yaml to make files under it block until a component owns them.`;
}

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

  const changeScope = renderChangeScope(result, errorCount);
  if (changeScope !== undefined) metrics.push(changeScope);

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
 * Reasons only a fill's own attempt to run the check can decide (a structure-
 * runner disposition translated by `classifyRunnerDisposition`) — never a
 * static drop, so a row carrying one of these ALWAYS names a file also
 * counted under `enforced`/`advisory` (a real pair exists; see
 * core/type-visibility.ts's own doc). Rendering such a row under "Attached
 * but not enforced" would claim the opposite of "Enforced" for the identical
 * file; `unverifiedCaveat` below states the same fact instead, inline on the
 * line it actually qualifies, so `renderReasonGroups` skips these reasons.
 */
const RUNTIME_ONLY_REASONS = new Set<TypeVisibilityReason>([
  'read-beyond-architecture',
  'node-context-required',
  'companion-context-failed',
]);

/** `dropped`, minus any reason a fill can only discover by running the check — see `RUNTIME_ONLY_REASONS`. */
function staticDropped(dropped: TypeVisibilityReport['byType'][number]['dropped']): TypeVisibilityReport['byType'][number]['dropped'] {
  return dropped.filter((d) => !RUNTIME_ONLY_REASONS.has(d.reason));
}

/**
 * Every one of `files` this run's `result.issues` marks `unverified` for
 * `aspectId` — the same cross-reference the caveat below has always used,
 * pulled into its own function so both the named-reason path and the
 * generic fallback start from the identical file set.
 */
function unverifiedFiles(result: CheckResult, aspectId: string, files: string[]): string[] {
  const unverifiedKeys = new Set(
    result.issues
      .filter((i) => i.code === 'unverified' && i.aspectId === aspectId && i.unitKey?.startsWith('file:'))
      .map((i) => i.unitKey!.slice('file:'.length)),
  );
  return files.filter((f) => unverifiedKeys.has(f));
}

/**
 * The caveat text appended to an `aspectId (N...)` entry for its unverified
 * files. `enforced/enforcedCounts` name effective STATUS (the architecture
 * says this aspect blocks on these files); a file can carry that status
 * while its pair has never once produced a real verdict — exactly the shape
 * a rule that structurally cannot run on a type-covered file takes.
 *
 * A file this run's fill actually attempted and watched fail with a
 * disposition this module can name (`result.typeVisibility.rows`, populated
 * only by `yg check --approve`'s in-process handoff — see core/fill.ts) gets
 * the SPECIFIC reason, in the exact words `describeTypeVisibilityReason`
 * already prints for a static drop — one vocabulary, not two. Every other
 * unverified file — a plain read that never filled, an LLM infra failure, a
 * det disposition this module does not represent — keeps the original,
 * honest "K unverified" wording: the fallback a run with no sharper answer
 * must still degrade to.
 */
function unverifiedCaveat(result: CheckResult, aspectId: string, files: string[]): string {
  const unverified = unverifiedFiles(result, aspectId, files);
  if (unverified.length === 0) return '';

  const reasonByFile = new Map<string, TypeVisibilityReason>();
  for (const row of result.typeVisibility?.rows ?? []) {
    if (row.aspectId === aspectId) reasonByFile.set(row.file, row.reason);
  }

  const countByReason = new Map<TypeVisibilityReason, number>();
  let plainCount = 0;
  for (const f of unverified) {
    const reason = reasonByFile.get(f);
    if (reason) countByReason.set(reason, (countByReason.get(reason) ?? 0) + 1);
    else plainCount++;
  }

  const clauses = [...countByReason.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, count]) => `${count} cannot run — ${describeTypeVisibilityReason(reason)}`);
  if (plainCount > 0) clauses.push(`${plainCount} unverified`);
  return `, ${clauses.join('; ')}`;
}

/**
 * Total unverified instances across an `enforcedCounts`/`advisoryCounts`
 * list — the counts-only render's caveat. Costs nothing extra to
 * compute: `result.issues` already carries the FULL lock-verification result
 * regardless of which view is rendering it, so this is the same lock-derived
 * "no confirmed verdict" fact the full view's `unverifiedCaveat` shows, at
 * aggregate granularity. What stays genuinely unavailable here is the
 * fill-only SPECIFIC reason (`cannot run — …`): that fact only ever exists on
 * a `yg check --approve` run, and `--summary`/`--top` refuse to combine with
 * `--approve` (source/cli/src/cli/check.ts's own guided error) — so a
 * counts-only render can never name it, by construction, not by omission here.
 */
function unverifiedInstanceTotal(result: CheckResult, entries: Array<{ aspectId: string; count: number }>, files: string[]): number {
  return entries.reduce((n, e) => n + unverifiedFiles(result, e.aspectId, files).length, 0);
}

/**
 * `(aspectId, count)` list → the rendered `aspectId (count)` segments this
 * block always showed, now with `unverifiedCaveat`'s clause appended whenever
 * that aspect has unverified files among `block.files`. No caveat (an aspect
 * whose every file has a real recorded outcome) renders byte-identical to
 * the pre-caveat text.
 */
function renderCountList(
  result: CheckResult,
  entries: Array<{ aspectId: string; count: number }>,
  files: string[],
): string {
  return entries
    .map((e) => `${e.aspectId} (${e.count}${unverifiedCaveat(result, e.aspectId, files)})`)
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
    // Runtime-only reasons render inline on Enforced/Advisory instead (see
    // RUNTIME_ONLY_REASONS) — excluded here so this total, and the "Attached
    // but not enforced" list below, never double-count a file that is ALSO
    // named "Enforced".
    const droppedForDisplay = staticDropped(block.dropped);
    if (countsOnly) {
      const droppedTotal = droppedForDisplay.reduce((n, d) => n + d.count, 0);
      const uncomputableSuffix = uncomputableTotal > 0
        ? `, ${uncomputableTotal} file${uncomputableTotal === 1 ? '' : 's'} could not have ${uncomputableTotal === 1 ? 'its' : 'their'} rules worked out (aspect implies cycle)`
        : '';
      const enforcedUnverified = unverifiedInstanceTotal(result, block.enforcedCounts, block.files);
      const advisoryUnverified = unverifiedInstanceTotal(result, block.advisoryCounts, block.files);
      // "instances", never "rules": the parenthetical counts (rule, file) pairs, and a
      // rule live on several files contributes one instance per file — the noun must
      // match `droppedTotal`'s own "instance(s)" a few words later, not the immediately
      // preceding "N rule(s) enforced" it qualifies.
      lines.push(
        `  '${block.typeId}' — ${block.files.length} file${block.files.length === 1 ? '' : 's'} covered — ` +
        `${block.enforcedCounts.length} rule${block.enforcedCounts.length === 1 ? '' : 's'} enforced${enforcedUnverified > 0 ? ` (${enforcedUnverified} unverified instance${enforcedUnverified === 1 ? '' : 's'})` : ''}, ` +
        `${block.advisoryCounts.length} advisory${advisoryUnverified > 0 ? ` (${advisoryUnverified} unverified instance${advisoryUnverified === 1 ? '' : 's'})` : ''}, ${droppedTotal} attached-but-not-enforced instance${droppedTotal === 1 ? '' : 's'}${uncomputableSuffix}`,
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
    if (droppedForDisplay.length > 0) {
      lines.push('    Attached but not enforced:');
      for (const reasonLine of renderReasonGroups(droppedForDisplay)) lines.push(`      ${reasonLine}`);
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
