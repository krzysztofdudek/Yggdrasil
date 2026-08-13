// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckIssue } from '../core/check.js';
import { groupIssues, type IssueGroup, getIssueLabel, FULL_WHAT_CODES, COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel } from './group-issues.js';
import { useEmoji } from './check-render-header.js';

/** Code sets for grouping errors by category. STRUCTURAL_CODES and
 *  COMPLETENESS_CODES are shared with the check engine via core/check-codes.ts
 *  so the rendered grouping and the summary tally cannot drift apart. */
// `unmapped-files` / `uncovered-advisory` render through renderUnmappedBlock
// (count + file list) — see COVERAGE_GROUP_EXCLUDED_CODES in group-issues.ts.
// `mapping-path-missing` is NOT a coverage code: it carries a nodePath and
// structured messageData, so it falls through to the normal validation-error
// renderer (code + node path + what/why/next) — renderUnmappedBlock would
// otherwise drop both the code and the offending node path.

// ── Details view: ungrouped, one block per issue ──────────

/**
 * Render every issue as an individual block (no (code,aspectId) collapsing).
 * Coverage issues (`unmapped-files` / `uncovered-advisory`) render via
 * `renderUnmappedBlock`; all others via `renderIssueBlock`. Produces a flat
 * list of blocks separated by blank lines, matching the spacing used in
 * the --top view.
 */
export function renderDetailsSection(issues: CheckIssue[], mode: 'error' | 'warning'): string {
  const lines: string[] = [];
  for (const issue of issues) {
    lines.push('');
    // Dispatch on the shared coverage set, not on literal codes: a coverage
    // finding's file list lives on lines 2+ of its `what`, which the generic
    // block renderer truncates away, so a code missing from this branch loses
    // the whole content of the finding in THIS view while rendering fine in
    // the others.
    if (COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code)) {
      renderUnmappedBlock(issue, lines, coverageBlockLabel(issue.code));
    } else {
      renderIssueBlock(issue, lines, mode);
    }
  }
  return lines.join('\n');
}

// ── Error section ──────────────────────────────────────────

/** Maximum number of issue groups rendered before the overflow hint. */
const GROUP_CAP = 12;

/**
 * Render the Errors section using grouped blocks. Coverage issues
 * (`unmapped-files`) are separated out and rendered after the groups via
 * `renderUnmappedBlock`. All other errors are grouped with `groupIssues` and
 * rendered with `renderGroup`.
 *
 * Section sub-header:
 *   - M > 1 → `Errors (N) in M groups:` (N = total issues including coverage)
 *   - M === 1 (or zero non-coverage errors) → `Errors (N):`
 *
 * Group cap: at most GROUP_CAP (12) groups rendered; if more, an overflow hint
 * line is appended after the 12th.
 */
export function renderErrorSection(errors: CheckIssue[], opts: { isTTY: boolean }, emoji = useEmoji): string {
  const unmapped = errors.filter(i => COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const rest = errors.filter(i => !COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const groups = groupIssues(rest);
  const M = groups.length;
  const N = errors.length;

  const errPrefix = emoji ? '❌ ' : '';
  const subheader = M > 1
    ? chalk.red(`${errPrefix}Errors (${N}) in ${M} groups:`)
    : chalk.red(`${errPrefix}Errors (${N}):`);
  const lines: string[] = [subheader];

  const shown = groups.slice(0, GROUP_CAP);
  for (const g of shown) {
    lines.push('');
    renderGroup(g, lines, opts);
  }
  if (groups.length > GROUP_CAP) {
    lines.push(`  ... in ${groups.length} groups — showing ${GROUP_CAP}; run yg check --top <n> or --aspect <id>`);
  }

  // Unmapped files — compact block with file list (unchanged)
  for (const issue of unmapped) {
    lines.push('');
    renderUnmappedBlock(issue, lines);
  }

  return lines.join('\n');
}

// ── Warning section ────────────────────────────────────────

/**
 * Render the Warnings section using grouped blocks. Coverage issues
 * (`uncovered-advisory`) are separated out and rendered after the groups via
 * `renderUnmappedBlock`. All other warnings are grouped with `groupIssues` and
 * rendered with `renderGroup`.
 *
 * Section sub-header:
 *   - M > 1 → `Warnings (N) in M groups:` (N = total warnings including coverage)
 *   - M === 1 (or zero non-coverage warnings) → `Warnings (N):`
 */
export function renderWarningSection(warnings: CheckIssue[], opts: { isTTY: boolean }, emoji = useEmoji): string {
  const coverage = warnings.filter(i => COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const rest = warnings.filter(i => !COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const groups = groupIssues(rest);
  const M = groups.length;
  const N = warnings.length;

  const warnPrefix = emoji ? '⚠️ ' : '';
  const subheader = M > 1
    ? chalk.yellow(`${warnPrefix}Warnings (${N}) in ${M} groups:`)
    : chalk.yellow(`${warnPrefix}Warnings (${N}):`);
  const lines: string[] = [subheader];

  const shown = groups.slice(0, GROUP_CAP);
  for (const g of shown) {
    lines.push('');
    renderGroup(g, lines, opts);
  }
  if (groups.length > GROUP_CAP) {
    lines.push(`  ... in ${groups.length} groups — showing ${GROUP_CAP}; run yg check --top <n> or --aspect <id>`);
  }

  // Coverage warnings — compact block with file list. The label comes from the
  // code, not from the section: this block now also carries the INHERITED half
  // of a split coverage finding, which is an unmapped-files finding that does
  // not block, not the advisory visibility tier, and calling it "uncovered"
  // would merge two different facts under one word.
  for (const issue of coverage) {
    lines.push('');
    renderUnmappedBlock(issue, lines, coverageBlockLabel(issue.code));
  }

  return lines.join('\n');
}

// ── Per-issue block ────────────────────────────────────────

/**
/** Indent applied to continuation lines so they align under the block body. */
const BLOCK_INDENT = '            ';

/**
 * Render a single issue (non-cascade, non-unmapped) as a labelled block:
 *   <label>  <node-path>  <what summary>
 *            <…full what detail for refusal codes…>
 *            Why: <why>
 *            Fix: <next>
 * plus an (advisory — not blocking) note for advisory warnings.
 *
 * For refusal codes (FULL_WHAT_CODES) the complete multi-line `what` is shown:
 * the first line as the block header, every subsequent line indented under it —
 * this is where the reviewer reason / violation list lives. All other codes show
 * only line 1 (terse one-line format preserved for unverified / prompt-too-large
 * / structural issues).
 *
 * Accesses issue.messageData.{what,why,next} directly — the structured renderer
 * pattern permitted by the what-why-next aspect for CLI renderers that need
 * labelled output instead of the flat buildIssueMessage concatenation.
 */
function renderIssueBlock(issue: CheckIssue, lines: string[], mode: 'error' | 'warning'): void {
  const md = issue.messageData;
  const whatLines = md.what.split('\n');
  const label = getIssueLabel(issue);
  // A repo-level issue (no node) omits the node column entirely instead of
  // leaving a blank one, which read as a stray double space before the summary.
  const nodeSeg = issue.nodePath ? `  ${issue.nodePath}` : '';

  lines.push(`  ${label}${nodeSeg}  ${whatLines[0]}`);
  // Refusal codes: render the remaining `what` lines (reviewer reason /
  // violation list) indented under the header so the agent sees the full
  // refusal detail in plain `yg check`, not only via `yg aspect-test`.
  if (FULL_WHAT_CODES.has(issue.code)) {
    for (const extra of whatLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
  if (md.why) {
    lines.push(`${BLOCK_INDENT}Why: ${md.why}`);
  }
  if (md.next) {
    // Advisory warnings never block: advisory aspect violations AND advisory
    // unverified pairs (an unverified pair renders as a warning only when its
    // effective status is advisory) both carry the not-blocking hint.
    const isAdvisory =
      mode === 'warning' &&
      (issue.code === 'aspect-violation-advisory' || issue.code === 'unverified');
    const fixSuffix = isAdvisory ? '  (advisory — not blocking)' : '';
    // `next` may itself be multi-line (cached-refusal "three exits"); keep the
    // full instruction, suffixing only the first line with the advisory hint.
    const nextLines = md.next.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}${fixSuffix}`);
    for (const extra of nextLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
}

/**
 * Render unmapped-files error (or uncovered-advisory warning) as a compact block with file list.
 * Derives all rendered content from issue.messageData (what/why/next) as required
 * by the what-why-next aspect. The terse format uses the count from messageData.what
 * and lists files from issue.uncoveredFiles (the structured data parallel to what).
 */
export function renderUnmappedBlock(issue: CheckIssue, lines: string[], label = 'unmapped'): void {
  const md = issue.messageData;
  const files = issue.uncoveredFiles ?? [];
  // Use the authoritative structured count; fall back to file list length only
  // if uncoveredCount was never set (should not happen in practice).
  const count = issue.uncoveredCount ?? files.length;
  const countLabel = String(count);
  lines.push(`  ${label} (${countLabel})`);
  // Show file list derived from messageData.what body lines (same data as uncoveredFiles).
  const shown = files.slice(0, 10);
  for (const f of shown) {
    lines.push(`            ${f}`);
  }
  if (files.length > 10) {
    lines.push(`            ... +${files.length - 10}`);
  }
  if (md.why) {
    lines.push(`            Why: ${md.why}`);
  }
  if (md.next) {
    lines.push(`            Fix: ${md.next.split('\n')[0]}`);
  }
}

// ── Grouped block render ───────────────────────────────────

const CAP_NODES = 12;

/** Jargon glosses: machine token first, human gloss in parentheses (parseable by tooling). */
const LABEL_GLOSS: Record<string, string> = { unverified: 'unverified (not yet reviewed)' };

function glossLabel(label: string): string {
  // Own-property guard: a reserved key inherited from Object.prototype
  // ('constructor', 'toString', '__proto__', …) is present on LABEL_GLOSS via the
  // prototype chain, so a bare `LABEL_GLOSS[label] ?? label` would surface the
  // inherited value instead of the label itself. Treat a non-own key as absent —
  // the same fall-through to `label` an unknown label already takes.
  return Object.hasOwn(LABEL_GLOSS, label) ? LABEL_GLOSS[label] : label;
}

/**
 * Render a group whose members name no graph node — a repository-level finding
 * (the committed agent-rules digest is stale; the lock could not be read):
 *
 *   <glossLabel(label)>
 *            <each member's what, first line>
 *            <sharedWhy>
 *            Fix: <sharedNext>
 *
 * The node-shaped framing is dropped rather than filled with placeholders: a
 * count of pairs and nodes, and a `- ` bullet with nothing after it, describe a
 * component the graph does not contain. Every member's `what` is surfaced (it
 * is the whole content of such a finding), and the shared why/fix render once,
 * exactly as in the node case.
 */
function renderRepoLevelGroup(group: IssueGroup, lines: string[]): void {
  lines.push(`  ${glossLabel(group.label)}`);
  // Per-member why/fix fires ONLY for `perMemberReason` codes (FULL_WHAT_CODES:
  // today, only `type-relation-forbidden` ever reaches this repo-level branch —
  // it names no node, one instance per (fromType, toType) pair, guaranteed to
  // exist only when `coverage.type_level` is on). Every OTHER code that can be
  // repo-level and divergent (`type-strict-orphan` mixing two `enforce: strict`
  // types, say) predates this release and is unaffected by the flag — printing
  // per-member detail for it changed flag-OFF output on real repos wholesale: a
  // single boilerplate sentence with no per-member content beyond a file name
  // repeated once per orphaned file, hundreds of times over on a large tree.
  // Falling through to "no shared line either" (the two guards immediately
  // below, unchanged) reproduces exactly what the pre-existing divergent case
  // already rendered: the per-file `what` lines, nothing else. That gap is not
  // new here and not this release's to close.
  for (const m of group.members) {
    for (const l of m.messageData.what.split('\n')) lines.push(`${BLOCK_INDENT}${l.replace(/\s+$/, '')}`);
    if (group.perMemberReason && group.divergentWhy && m.messageData.why) {
      lines.push(`${BLOCK_INDENT}Why: ${m.messageData.why.split('\n')[0]}`);
    }
    if (group.perMemberReason && group.divergentNext && m.messageData.next) {
      const nextLines = m.messageData.next.split('\n');
      lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
      for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
  if (group.sharedWhy && !group.divergentWhy) lines.push(`${BLOCK_INDENT}Why: ${group.sharedWhy}`);
  if (group.sharedNext && !group.divergentNext) {
    const nextLines = group.sharedNext.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
}

/**
 * Render a single IssueGroup as a unified block:
 *   <glossLabel(label)>  <P> pairs  <M> nodes[  aspect '<id>']
 *   <sharedWhy>                         (only when `why` is shared across members)
 *   Fix: <sharedNext>                   (only when `next` is shared across members)
 *   - <node> (one per member; perMemberReason: includes first detail line from messageData.what)
 *       Why: <member why>              (only when group.divergentWhy)
 *       Fix: <member next>             (only when group.divergentNext)
 *   ... and K more (yg check --aspect <id>)  [TTY-only, when members > CAP_NODES]
 *
 * Divergence handling (Fix 4): when the members carry node-specific `next`
 * (and/or `why`) — `log-entry-missing`, `relation-undeclared-dependency`,
 * architecture errors — a SINGLE shared `Fix:`/`Why:` would name only the
 * alphabetically-first node and mislead the agent. In that case the shared line
 * is suppressed and each member's own command/rationale is rendered beneath its
 * bullet. Shared-fix groups (LLM refusals, unverified, …) keep the collapsed
 * single block.
 */
export function renderGroup(group: IssueGroup, lines: string[], opts: { isTTY: boolean }): void {
  const aspectSeg = group.aspectId ? `  aspect '${group.aspectId}'` : '';
  // A repo-level group names no node AND no type-covered file (the committed
  // agent-rules digest, an unreadable lock). Pair/node counts would both be
  // fabrications there — the finding is about repository files in general, not
  // about any component or a specific type-covered file — so the header
  // carries just the label, and the members render as plain detail lines with
  // no bullet to leave empty. A group that is ALL file-level (nodeCount === 0
  // but fileCount > 0) is NOT repo-level — it has real per-file bullets to
  // render, just no component among them.
  if (group.nodeCount === 0 && group.fileCount === 0) {
    renderRepoLevelGroup(group, lines);
    return;
  }
  // Byte-identical to the plain node-only rendering when fileCount === 0 (this
  // repo's own flag stays off, so that is always true here): "N pairs M
  // nodes". Only a group that genuinely mixes or is all files gets the
  // combined/files-only wording.
  const countSeg = group.fileCount > 0
    ? (group.nodeCount > 0 ? `${group.nodeCount} nodes, ${group.fileCount} files` : `${group.fileCount} files`)
    : `${group.nodeCount} nodes`;
  lines.push(`  ${glossLabel(group.label)}  ${group.pairCount} pairs  ${countSeg}${aspectSeg}`);
  // Shared why/fix render once ABOVE the member list — but only when they are
  // genuinely shared. A divergent why/next belongs per-member (below), so the
  // shared line is suppressed here to avoid naming only the first node.
  if (group.sharedWhy && !group.divergentWhy) lines.push(`${BLOCK_INDENT}${group.sharedWhy}`);
  if (group.sharedNext && !group.divergentNext) {
    const nextLines = group.sharedNext.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
  // Per-member why/fix continuation, emitted under each bullet when divergent.
  // Indented one level (two spaces) deeper than the bullet so it reads as a
  // child of that node, matching the perMemberReason `what`-tail indentation.
  const MEMBER_DETAIL_INDENT = `${BLOCK_INDENT}  `;
  const emitDivergentDetail = (m: CheckIssue): void => {
    if (group.divergentWhy && m.messageData.why) {
      lines.push(`${MEMBER_DETAIL_INDENT}Why: ${m.messageData.why.split('\n')[0]}`);
    }
    if (group.divergentNext && m.messageData.next) {
      const nextLines = m.messageData.next.split('\n');
      lines.push(`${MEMBER_DETAIL_INDENT}Fix: ${nextLines[0]}`);
      for (const extra of nextLines.slice(1)) lines.push(`${MEMBER_DETAIL_INDENT}${extra}`);
    }
  };
  /**
   * Render one member's bullet + divergent detail. `subject` is what appears
   * where the node path would — the real nodePath for a component member, or
   * the FILE (never an empty bullet) for a nodeless one.
   */
  const renderMemberBullet = (m: CheckIssue, subject: string): void => {
    if (group.perMemberReason) {
      // Full what tail: every line AFTER line 0 (line 0 is the generic
      // "Aspect X refused on UNIT" header already conveyed by the group header).
      // For LLM refusals line 1 is "Reviewer reason: ..."; for deterministic
      // refusals line 1 is "Violations:" and lines 2+ are the file:line entries.
      // Truncating to line 1 silently drops the actionable violation lines.
      const whatTail = m.messageData.what.split('\n').slice(1).map((l) => l.replace(/\s+$/, ''));
      if (whatTail.length === 0) {
        lines.push(`${BLOCK_INDENT}- ${subject}`);
      } else {
        lines.push(`${BLOCK_INDENT}- ${subject}  ${whatTail[0].trim()}`);
        for (const extra of whatTail.slice(1)) {
          lines.push(`${BLOCK_INDENT}  ${extra}`);   // continuation, indented one level under the bullet
        }
      }
      // Divergent per-member why/fix (e.g. relation-undeclared-dependency, whose
      // `what` is the violation list AND whose `next` names the node's stanza).
      emitDivergentDetail(m);
    } else {
      // For code-only groups (e.g. `unverified`) group.aspectId is undefined
      // because the group spans multiple aspects. Annotate each member line
      // with the member's own aspectId so the agent can see which aspect is
      // unverified on each subject without repeating the shared why+fix.
      const memberAspectSeg =
        group.aspectId === undefined && m.aspectId !== undefined
          ? `  aspect '${m.aspectId}'`
          : '';
      // For non-aspect structural/graph issues (e.g. when-predicate-invalid,
      // log-entry-missing) the member has no aspectId to annotate — instead
      // surface the first line of `what`, which carries the specific diagnostic
      // detail (e.g. "Invalid regex in content when:" or "No fresh log entry for
      // node '...'"). Without this, all members in the group look identical and
      // the agent cannot distinguish which node/file/predicate is broken.
      const whatSeg =
        !memberAspectSeg && m.messageData.what
          ? `  ${m.messageData.what.split('\n')[0]}`
          : '';
      lines.push(`${BLOCK_INDENT}- ${subject}${memberAspectSeg || whatSeg}`);
      // Divergent per-member why/fix (e.g. log-entry-missing → `yg log add --node X`,
      // relation-target-forbidden → allow-list vs default-deny). Without this the
      // group would render only the first member's command/rationale.
      emitDivergentDetail(m);
    }
  };
  /** Render one block of members (its own bullets, its own truncation cap). */
  const renderMemberBlock = (blockMembers: CheckIssue[], subjectFor: (m: CheckIssue) => string): void => {
    const truncate = opts.isTTY && blockMembers.length > CAP_NODES;
    const shown = truncate ? blockMembers.slice(0, CAP_NODES) : blockMembers;
    for (const m of shown) renderMemberBullet(m, subjectFor(m));
    if (truncate) {
      const drill = group.aspectId ? ` (yg check --aspect ${group.aspectId})` : '';
      lines.push(`${BLOCK_INDENT}... and ${blockMembers.length - CAP_NODES} more${drill}`);
    }
  };

  if (group.fileCount === 0) {
    // Byte-identical to the plain node-only rendering: one block, one cap,
    // over every member (a stray member with neither nodePath nor a file:
    // unitKey — never produced by any known issue path — still renders via
    // the empty-subject fallback exactly as it always has, rather than
    // silently vanishing).
    renderMemberBlock(group.members, (m) => m.nodePath ?? '');
  } else {
    // Two blocks — components first, then files — each with its OWN cap, so a
    // repo with hundreds of type-covered files can never fill the component
    // cap with files and hide every component member.
    const nodeMembers = group.members.filter((m) => m.nodePath !== undefined);
    const fileMembers = group.members.filter((m) => m.nodePath === undefined && m.unitKey?.startsWith('file:'));
    const otherMembers = group.members.filter(
      (m) => m.nodePath === undefined && !m.unitKey?.startsWith('file:'),
    );
    renderMemberBlock([...nodeMembers, ...otherMembers], (m) => m.nodePath ?? '');
    if (fileMembers.length > 0) {
      renderMemberBlock(fileMembers, (m) => m.unitKey!.slice('file:'.length));
    }
  }
}
