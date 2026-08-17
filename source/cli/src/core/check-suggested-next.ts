/**
 * source/cli/src/core/check-suggested-next.ts — the ONE line a finished check
 * points at: given the whole issue set, which single `next` does the agent act
 * on first.
 *
 * Pure and synchronous — it reads the assembled issues and nothing else (no
 * graph, no lock, no disk), so the priority order below is the entire contract
 * of this module. Each branch either surfaces an issue's own `next` verbatim or
 * composes a category line; the tie-breaks are chosen so the rule this line
 * names is the same group `yg check --top` renders first.
 */

import { STRUCTURAL_CODES, COMPLETENESS_CODES, OUTSIDE_CODES } from './check-codes.js';
import { countOutside } from './check-progressive.js';
import { toPosixPath } from '../utils/posix.js';
import type { CheckIssue } from './check-contract.js';

/**
 * The one line a run points at when nothing blocks and at least one finding was
 * put outside the change.
 *
 * It outranks every OTHER warning's own `next`, not just the twins' — which is
 * a stronger rule than it first looks and is deliberate. Skipping only the twins
 * left the highest-ranking survivor speaking for the run, and the two warnings
 * that rank highest here (an advisory aspect violation, then whatever sorts
 * first alphabetically) carry guidance about re-reviewing the WHOLE project:
 * a progressive-green run would end by telling an agent to run a repo-wide
 * review it never asked for, clearing inherited debt the change did not cause
 * and spending reviewer calls to do it. While anything sits outside the change,
 * the honest next step is the audit that shows all of it at once.
 *
 * The noun is the header's, deliberately: both surfaces report the SAME number
 * (`countOutside`, one definition), and the header calls it plain "obligations".
 * This line once called them "enforced obligations", which is wrong twice over —
 * `countOutside` sums uncovered files, missing descriptions and undeclared
 * dependencies alongside enforced pairs, and "enforced" is a specific status word
 * everywhere else in the product, so a reader could reasonably take the two
 * numbers for different things. Same count, same word, same pluralisation.
 */
function standingOutsideLine(outsideWarnings: CheckIssue[]): string {
  const count = countOutside(outsideWarnings);
  return `${count} obligation${count === 1 ? '' : 's'} outside your changes — run 'yg check --full' for the complete audit`;
}

/**
 * Among the error issues carrying a given per-aspect `code`, pick the one whose
 * `aspectId` sorts first by locale — the SAME tie-break groupIssues applies once
 * rank and label are equal. Raw emission order (pair-iteration order) is NOT
 * locale order, so a plain `.find()` here could name a different aspect than the
 * group bare `yg check --top` renders. Returns undefined when no issue matches.
 */
function pickByAspectIdLocale(errors: CheckIssue[], code: string): CheckIssue | undefined {
  const candidates = errors.filter(i => i.code === code);
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) =>
    (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en'))[0];
}

/**
 * Suggest the next command based on the highest-priority error, in the §6 order:
 *   lock-invalid → unverified(enforced) → enforced refusal (three exits / fix
 *   violations, per-issue) → prompt-too-large → log conflict → log
 *   integrity/format → structural → coverage → completeness → any other error
 *   (architecture/strict codes, tracked∩gitignored anomaly — neither has a
 *   dedicated branch; each surfaces its own `next` here).
 *
 * Each lock issue carries its own kind-appropriate `next` in messageData
 * (cached three-exit for an LLM refusal, fix-violations for a deterministic
 * refusal, size remedies for prompt-too-large). With no error remaining: when
 * ANY finding was put outside the change, point at the full audit; otherwise
 * surface the highest-priority warning's `next` — advisory aspect-violation
 * first, else the alphabetically-first warning — so a warnings-only run still
 * points somewhere.
 */
export function computeSuggestedNext(issues: CheckIssue[]): string | null {
  const errors = issues.filter(i => i.severity === 'error');
  const ASPECT_WARNING_CODES = new Set(['aspect-violation-advisory']);
  if (errors.length === 0) {
    const warnings = issues.filter(i => i.severity === 'warning');
    if (warnings.length === 0) return null;
    // Anything outside the change takes the line, ahead of every warning below
    // — including the advisory branch, which otherwise outranks everything and
    // whose `next` points at a repo-wide review. See standingOutsideLine.
    if (warnings.some(i => OUTSIDE_CODES.has(i.code))) return standingOutsideLine(warnings);
    // Advisory aspect violations rank first among warnings (matching groupIssues'
    // label sort, where the 'advisory' label precedes every other warning label).
    // Among several advisory warnings, pick the alphabetically-first aspectId — the
    // SAME tie-break groupIssues applies once rank and label are equal — so the
    // surfaced `Next:` names the group bare `yg check --top` renders first.
    const advisoryWarnings = warnings.filter(i => ASPECT_WARNING_CODES.has(i.code));
    if (advisoryWarnings.length > 0) {
      const first = [...advisoryWarnings].sort((a, b) =>
        (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en'))[0];
      return first.messageData.next ?? null;
    }
    // No advisory violation: fall back to the highest-priority remaining warning
    // (aspect-review-overdue, high-fan-out, orphaned-aspect, …) so a warnings-only
    // run still points somewhere, per the agent-facing contract. Use the SAME
    // (code, nodePath) tie-break as the structural / "any remaining error" branches
    // below so the surfaced line stays consistent with what `--top` renders first.
    // No twin can reach here — the branch above already took the line — so this
    // is the pre-scope behaviour, unchanged.
    const first = [...warnings].sort((a, b) =>
      a.code.localeCompare(b.code, 'en') ||
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'))[0];
    return first.messageData.next ?? null;
  }

  // 1. lock-invalid — fail closed; restore-or-refill (its own next).
  const lockInvalid = errors.find(i => i.code === 'lock-invalid');
  if (lockInvalid) return lockInvalid.messageData.next;

  // 1b. log-entry-missing — a log_required node's source changed with no fresh
  //     entry. Outranks unverified: `--approve` is gated on the entry, so adding
  //     it is the first step before any fill can proceed.
  const logEntryMissing = errors.find(i => i.code === 'log-entry-missing');
  if (logEntryMissing) return logEntryMissing.messageData.next;

  // 2. unverified (enforced) — prefer a fillable pair.
  const unverified = errors.find(i => i.code === 'unverified' && i.messageData.next === 'yg check --approve') ?? errors.find(i => i.code === 'unverified');
  if (unverified) return unverified.messageData.next;

  // 3. enforced refusal (LLM three-exit OR deterministic fix-violations — the
  //    correct text is already in each issue's messageData.next).
  const enforcedRefusal = pickByAspectIdLocale(errors, 'aspect-violation-enforced');
  if (enforcedRefusal) return enforcedRefusal.messageData.next;

  // 4. prompt-too-large — size remedies.
  const promptTooLarge = pickByAspectIdLocale(errors, 'prompt-too-large');
  if (promptTooLarge) return promptTooLarge.messageData.next;

  // 4b. companion-error — companion.mjs could not resolve during the size gate;
  //     its own next carries the fix (stabilize the tree / declare the relation).
  const companionError = pickByAspectIdLocale(errors, 'aspect-companion-runtime-error');
  if (companionError) return companionError.messageData.next;

  // 5. log conflict — git conflict markers in log.md outrank integrity/format
  //    (the file cannot be validated at all; reconcile structurally first).
  const logConflict = errors.find(i => i.code === 'log-conflict');
  if (logConflict) return logConflict.messageData.next;

  // 5b. log integrity / format.
  const logIntegrity = errors.find(i => i.code === 'log-integrity');
  if (logIntegrity) {
    // Normalize the node path for the printed command (posix-paths-output): the structured
    // field stays raw, but any path written into stdout uses forward slashes.
    const node = toPosixPath(logIntegrity.nodePath ?? '<unknown>');
    const count = errors.filter(i => i.code === 'log-integrity').length;
    return `git checkout HEAD -- .yggdrasil/model/${node}/log.md .yggdrasil/yg-lock.logs.json\n  ${count} log integrity violation${count === 1 ? '' : 's'} — restore from git`;
  }
  const logFormat = errors.find(i => i.code === 'log-format');
  if (logFormat) {
    const node = toPosixPath(logFormat.nodePath ?? '<unknown>');
    const count = errors.filter(i => i.code === 'log-format').length;
    return `Edit .yggdrasil/model/${node}/log.md to fix format violations\n  ${count} log format violation${count === 1 ? '' : 's'} — post-baseline edit OR git checkout for pre-baseline`;
  }

  // 5c. ambiguous-node-type (coverage.type_level) — carries its own two-exit
  //     guidance keyed to the FILE (the issue has no nodePath — the file has no
  //     owning node, which is the whole problem). It IS a STRUCTURAL_CODES
  //     member (for the summary tally / --top grouping), but the generic
  //     structural fallback in step 6 below renders `Fix <code> in <nodePath>`,
  //     which for a nodePath-less issue collapses to a useless
  //     `Fix ambiguous-node-type in .yggdrasil` and discards the guidance — so
  //     it is intercepted here first, exactly like the other node/file-specific
  //     `next` codes above it. `.find()` already returns issues in emission
  //     order, which is the alphabetical file order `scanUncoveredFiles` sorts
  //     to, so this is deterministic without an extra tie-break sort.
  const ambiguousNodeType = errors.find(i => i.code === 'ambiguous-node-type');
  if (ambiguousNodeType) return ambiguousNodeType.messageData.next;

  // 6. structural. Pick the alphabetically-first structural CODE (then node),
  //    the SAME within-category tie-break groupIssues uses (label = code) — NOT
  //    validator emission order — so the group bare `yg check --top` renders is
  //    exactly the rule this line names. Emission order let the two surfaces
  //    drift (e.g. `event-unpaired` shown by --top but `yaml-invalid` named here).
  const structuralErrors = errors.filter(i => STRUCTURAL_CODES.has(i.code));
  // Under a change scope the aggregate coverage finding is SPLIT in two, and
  // only the half naming files the change actually touched keeps this code and
  // error severity — the inherited half is a `-outside` warning. So this filter
  // is the blocking partition by construction, and the counts read off it below
  // are the number of files the change itself must answer for, never the whole
  // inherited backlog. Unscoped runs are unaffected: there is only ever one.
  const coverageErrors = errors.filter(i => i.code === 'unmapped-files');
  if (structuralErrors.length > 0) {
    const first = [...structuralErrors].sort((a, b) =>
      a.code.localeCompare(b.code, 'en') ||
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'))[0];
    const then = coverageErrors.length > 0
      ? `\n  Then: ${coverageErrors[0].uncoveredCount ?? 0} files need coverage`
      : '';
    // Nodeless: name the FILE from the unit key, not the graph dir; only a
    // genuinely repo-level issue (neither) falls back to '.yggdrasil'.
    const subject = first.nodePath
      ?? (first.unitKey?.startsWith('file:') ? first.unitKey.slice('file:'.length) : undefined)
      ?? '.yggdrasil';
    return `Fix ${first.code} in ${toPosixPath(subject)}\n  1 of ${structuralErrors.length} structural error${structuralErrors.length === 1 ? '' : 's'}${then}`;
  }

  // 7. coverage.
  if (coverageErrors.length > 0) {
    const count = coverageErrors[0].uncoveredCount ?? 0;
    return `yg context --file <uncovered-path>\n  ${count} file${count === 1 ? '' : 's'} need coverage — bootstrap workflow`;
  }

  // 8. completeness.
  const completenessErrors = errors.filter(i => COMPLETENESS_CODES.has(i.code));
  if (completenessErrors.length > 0) {
    const first = completenessErrors[0];
    return `Fix ${first.code} for ${toPosixPath(first.nodePath ?? '')}\n  1 of ${completenessErrors.length} completeness error${completenessErrors.length === 1 ? '' : 's'} — post-modify workflow`;
  }

  // 9. Any remaining error — architecture/strict codes outside the categories
  //    above (e.g. type-undefined, parent-type-forbidden, mapping-path-missing,
  //    type-strict-*, tracked-file-gitignored). Each carries its own actionable
  //    `next`. Pick the alphabetically-first by code then node — the SAME
  //    tie-break groupIssues uses — so the group bare `yg check --top` renders is
  //    the group this line names even here. Without this the line would be null
  //    while `--top` still rendered that group, breaking the bare-`--top` ==
  //    `Next:` invariant.
  const otherErrors = [...errors].sort((a, b) =>
    a.code.localeCompare(b.code, 'en') ||
    (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
  if (otherErrors.length > 0) return otherErrors[0].messageData.next;

  return null;
}
