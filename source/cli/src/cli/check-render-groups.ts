// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (color/emoji); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import chalk from 'chalk';
import type { CheckIssue } from '../core/check.js';
import { SCOPED_CODES, baseCodeOfOutsideTwin } from '../core/check-codes.js';
import { groupIssues, type IssueGroup, getIssueLabel, COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel, OUTSIDE_LABEL_SUFFIX, PAIR_CODES } from './group-issues.js';
import { useEmoji } from './check-render-header.js';
import { count, MEMBER_CAP } from './output.js';
import { toPosixPath } from '../utils/posix.js';
import { escapeControls } from '../utils/terminal-safe.js';

/** Code sets for grouping errors by category. STRUCTURAL_CODES and
 *  COMPLETENESS_CODES are shared with the check engine via core/check-codes.ts
 *  so the rendered grouping and the summary tally cannot drift apart. */
// `unmapped-files` / `uncovered-advisory` render through renderUnmappedBlock
// (count + file list) — see COVERAGE_GROUP_EXCLUDED_CODES in group-issues.ts.
// `mapping-path-missing` is NOT a coverage code: it carries a nodePath and
// structured messageData, so it falls through to the normal validation-error
// renderer (code + node path + what/why/next) — renderUnmappedBlock would
// otherwise drop both the code and the offending node path.

/**
 * Whether `code` is a `-outside` twin — every Fix: line below is suppressed
 * for one, in every shape it can render as (single block, unmapped-files
 * block, grouped shared line, grouped per-member divergent line).
 *
 * `messageData` is untouched by the classifier on purpose (check-progressive.ts's
 * `toOutsideTwin`: "the what/why/next a person reads describes the finding, not
 * its scope") — so `next` still reads exactly like the finding it mirrors, e.g.
 * `unverified`'s literal `yg check --approve`. That is the RIGHT remedy for the
 * finding it mirrors and the WRONG one to print here: this finding is a warning
 * specifically because the change did not reach it, `--approve` reviews the
 * WHOLE project rather than this one pair (docs/cli-reference.md), and the run's
 * own bottom line already names the one honest next step for everything outside
 * the change (`yg check --full` — computeSuggestedNext's standingOutsideLine).
 * Repeating the recording command per finding contradicts that line. Why: stays
 * — the rationale is still true of the finding regardless of scope.
 */
function isOutsideFinding(code: string): boolean {
  return baseCodeOfOutsideTwin(code) !== undefined;
}

// ── Details view: ungrouped, one block per issue ──────────

/**
 * How much of a group a view shows. `capMembers` cuts each member list at
 * MEMBER_CAP rows and ends it with a runnable drill line; it is the VIEW's
 * decision (the drill-in and per-issue views show everything), never the
 * terminal's — a pipe gets the same bounded report a terminal does.
 */
export interface GroupRenderOptions {
  capMembers: boolean;
}

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
      renderUnmappedBlock(issue, lines, coverageBlockLabel(issue.code), { capMembers: false });
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
export function renderErrorSection(errors: CheckIssue[], opts: GroupRenderOptions, emoji = useEmoji): string {
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
    renderUnmappedBlock(issue, lines, 'unmapped', opts);
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
export function renderWarningSection(warnings: CheckIssue[], opts: GroupRenderOptions, emoji = useEmoji): string {
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
    renderUnmappedBlock(issue, lines, coverageBlockLabel(issue.code), opts);
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
 * The complete multi-line `what` is shown for every code: the first line as the
 * block header, every subsequent line indented under it — the reviewer reason
 * or violation list of a refusal, the file list of a mapping finding, a parser's
 * own message. A line of `what` is never dropped in this view.
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
  // Every remaining `what` line (reviewer reason, violation list, file list,
  // parser message), indented under the header — the per-issue view is the one
  // that shows a finding whole.
  for (const extra of whatLines.slice(1)) {
    if (extra.trim() === '') continue;
    lines.push(`${BLOCK_INDENT}${extra}`);
  }
  if (md.why) {
    lines.push(`${BLOCK_INDENT}Why: ${md.why}`);
  }
  if (md.next && !isOutsideFinding(issue.code)) {
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
export function renderUnmappedBlock(
  issue: CheckIssue,
  lines: string[],
  label = 'unmapped',
  opts: GroupRenderOptions = { capMembers: true },
): void {
  const md = issue.messageData;
  const files = issue.uncoveredFiles ?? [];
  // Use the authoritative structured count; fall back to file list length only
  // if uncoveredCount was never set (should not happen in practice).
  const fileCount = issue.uncoveredCount ?? files.length;
  lines.push(`  ${label} (${fileCount})`);
  // The file list (the same data as messageData.what's body lines). A capped
  // view shows the first FILE_CAP and names the view that shows every one.
  const shown = opts.capMembers ? files.slice(0, FILE_CAP) : files;
  for (const f of shown) {
    // A file name is repository text: a control sequence in it is shown, never obeyed.
    lines.push(`            ${escapeControls(f)}`);
  }
  if (files.length > shown.length) {
    lines.push(`            ... +${files.length - shown.length} (yg check --details)`);
  }
  if (md.why) {
    lines.push(`            Why: ${md.why}`);
  }
  if (md.next && !isOutsideFinding(issue.code)) {
    // Every line of the remedy: a second line (a follow-up step) is part of it.
    const nextLines = md.next.split('\n');
    lines.push(`            Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`            ${extra.trim()}`);
  }
}

// ── Grouped block render ───────────────────────────────────

/** Files a coverage block lists before it elides the rest (the per-issue view lists all). */
const FILE_CAP = 10;

/**
 * Jargon glosses: machine token first, human gloss in parentheses (parseable by
 * tooling). Keyed by CODE, not by the rendered label — for every entry here
 * today the code and its untwinned label happen to be identical bare words
 * (`getIssueLabel('unverified') === 'unverified'`), which is what lets
 * {@link LABEL_GLOSS} below key off this table directly without a second
 * code→label lookup.
 */
const BASE_LABEL_GLOSS: Record<string, string> = {
  unverified: 'unverified (not yet reviewed)',
  // The other labels an unverified pair can carry — one per cause
  // (getIssueLabel). Each says in a few words why the pair has no verdict, so
  // the group's Fix line reads as the answer to that, not to "not yet reviewed".
  stale: 'unverified (stale — inputs changed since the verdict)',
  'deterministic-not-run': 'unverified (deterministic check not run on this checkout — free)',
  'reviewer-missing': 'unverified (no reviewer configured)',
  'reviewer-unreachable': 'unverified (reviewer unreachable this run)',
  'reviewer-failed': 'unverified (reviewer returned no verdict this run)',
  'check-failed-to-run': 'unverified (check.mjs failed to run)',
  'suppress-marker-invalid': 'unverified (yg-suppress marker has no reason)',
};

/**
 * {@link BASE_LABEL_GLOSS}, plus the twin gloss of every entry whose code has
 * an outside twin — DERIVED from `SCOPED_CODES`, never a hand-written second
 * copy, for the same reason `FULL_WHAT_CODES` and `CODE_ONLY_GROUP_CODES` are
 * (group-issues.ts's `withOutsideTwins`): a twin missing from this table would
 * fall through {@link glossLabel} unglossed, leaving `unverified (outside
 * changes)` on screen with no explanation of the jargon its own mirror
 * explains one line away. The twin's KEY is its rendered label — the base
 * label plus {@link OUTSIDE_LABEL_SUFFIX}, exactly what `getIssueLabel`
 * produces for it — and its VALUE is the base gloss with the same suffix
 * appended, so the one gloss sentence still ends by saying whose business the
 * finding is, same as every other twin label does.
 */
const LABEL_GLOSS: Record<string, string> = Object.fromEntries(
  Object.entries(BASE_LABEL_GLOSS).flatMap(([label, gloss]): Array<[string, string]> =>
    // Every label here is an `unverified` pair's label, and `unverified` is a
    // scoped code, so each one has an outside twin to gloss as well.
    SCOPED_CODES.has('unverified')
      ? [[label, gloss], [`${label}${OUTSIDE_LABEL_SUFFIX}`, `${gloss}${OUTSIDE_LABEL_SUFFIX}`]]
      : [[label, gloss]],
  ),
);

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
  const isOutside = isOutsideFinding(group.code);
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
    if (group.perMemberReason && group.divergentNext && m.messageData.next && !isOutside) {
      const nextLines = m.messageData.next.split('\n');
      lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
      for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
  if (group.sharedWhy && !group.divergentWhy) lines.push(`${BLOCK_INDENT}Why: ${group.sharedWhy}`);
  if (group.sharedNext && !group.divergentNext && !isOutside) {
    const nextLines = group.sharedNext.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
}

/**
 * The shared text of a per-member field whose members differ ONLY by their own
 * node path — `yg log add --node <node> …` for every node of a log gate, say.
 * Returns the text with each member's path replaced by `<node>` when that makes
 * every member's text identical, else undefined (a genuinely divergent field,
 * which keeps its per-member lines). One templated line instead of N copies
 * that differ by one token.
 */
function memberTemplate(members: CheckIssue[], field: (m: CheckIssue) => string | undefined): string | undefined {
  let template: string | undefined;
  for (const m of members) {
    const text = field(m);
    if (text === undefined || text === '' || m.nodePath === undefined) return undefined;
    const node = toPosixPath(m.nodePath);
    if (!text.includes(node)) return undefined;
    const t = text.split(node).join('<node>');
    if (template === undefined) template = t;
    else if (t !== template) return undefined;
  }
  return template;
}

/**
 * What the fill a group's Fix names will cost, when that Fix is a recording
 * run over unverified pairs: script pairs are free, reviewer pairs are paid.
 * Empty for every other group.
 */
function costSuffix(group: IssueGroup): string {
  if (group.code !== 'unverified' || !group.sharedNext.startsWith('yg check --approve')) return '';
  const script = group.members.filter((m) => m.pairKind === 'deterministic').length;
  const reviewer = group.members.filter((m) => m.pairKind === 'llm').length;
  if (script > 0 && reviewer > 0) return `  (${count(script, 'script pair')} free, ${count(reviewer, 'reviewer pair')} paid)`;
  if (script > 0) return `  (${count(script, 'script pair')}, free)`;
  if (reviewer > 0) return `  (${count(reviewer, 'reviewer pair')}, paid)`;
  return '';
}

/**
 * The command that shows every member of a group whose list was cut: the
 * group's own rule, or the one rule all its members share, drilled into with
 * `--aspect` (a view that never cuts); failing both, the per-issue view.
 */
function drillFor(group: IssueGroup): string {
  if (group.aspectId !== undefined) return `yg check --aspect ${group.aspectId}`;
  const aspects = new Set(group.members.map((m) => m.aspectId));
  const [only] = [...aspects];
  if (aspects.size === 1 && only !== undefined) return `yg check --aspect ${only}`;
  return 'yg check --details';
}

/** One rendered member row: its lines, how many members it stands for, and the member whose detail follows it. */
interface MemberRow {
  lines: string[];
  members: number;
  first: CheckIssue;
}

/**
 * Render a single IssueGroup as a unified block:
 *   <glossLabel(label)>  <P> pairs  <M> nodes[  aspect '<id>']
 *   <sharedWhy>                         (shared, or templated over the node path)
 *   Fix: <sharedNext>[  (cost)]         (shared, or templated: "(for each node below)")
 *   - <node>  <what>  (one row per member; same (node, rule) file pairs collapse
 *       <continuation lines>             into one row naming how many files)
 *       Why: <member why>              (only when the why genuinely diverges)
 *       Fix: <member next>             (only when the fix genuinely diverges)
 *   ... and K more (<drill>)            (when the view caps and rows > MEMBER_CAP)
 *
 * Divergence handling: when the members carry node-specific `next` (and/or
 * `why`) — `log-entry-missing`, `relation-undeclared-dependency`, architecture
 * errors — a SINGLE shared line would name only the first node. If the members
 * differ only by their own node path, one templated line with `<node>` stands
 * for all of them; otherwise each member's own line is rendered beneath its row.
 *
 * The member list is capped by the VIEW (opts.capMembers), in every sink —
 * never by whether the output is a terminal — and a cut list always ends with
 * the command that shows the rest.
 */
export function renderGroup(group: IssueGroup, lines: string[], opts: GroupRenderOptions): void {
  const aspectSeg = group.aspectId ? `  aspect '${group.aspectId}'` : '';
  // A repo-level group names no node AND no type-covered file (the committed
  // agent-rules digest, an unreadable lock). Pair/node counts would both be
  // fabrications there, so the header carries just the label, and the members
  // render as plain detail lines with no bullet to leave empty. A group that is
  // ALL file-level (nodeCount === 0 but fileCount > 0) is NOT repo-level.
  if (group.nodeCount === 0 && group.fileCount === 0) {
    renderRepoLevelGroup(group, lines);
    return;
  }
  const countSeg = group.fileCount > 0
    ? (group.nodeCount > 0 ? `${count(group.nodeCount, 'node')}, ${count(group.fileCount, 'file')}` : count(group.fileCount, 'file'))
    : count(group.nodeCount, 'node');
  // "pairs" only for verdict states; any other finding is counted as issues.
  const countNoun = PAIR_CODES.has(group.code) ? 'pair' : 'issue';
  lines.push(`  ${glossLabel(group.label)}  ${count(group.pairCount, countNoun)}  ${countSeg}${aspectSeg}`);
  // A `-outside` twin group's Fix line — shared or per-member, below — is
  // suppressed entirely: see isOutsideFinding's doc comment.
  const isOutside = isOutsideFinding(group.code);
  const whyTemplate = group.divergentWhy ? memberTemplate(group.members, (m) => m.messageData.why) : undefined;
  const nextTemplate = group.divergentNext ? memberTemplate(group.members, (m) => m.messageData.next) : undefined;
  const perMemberWhy = group.divergentWhy && whyTemplate === undefined;
  const perMemberNext = group.divergentNext && nextTemplate === undefined;
  const sharedWhy = group.divergentWhy ? whyTemplate : group.sharedWhy;
  const sharedNext = group.divergentNext ? nextTemplate : group.sharedNext;
  if (sharedWhy) lines.push(`${BLOCK_INDENT}${sharedWhy}`);
  if (sharedNext && !isOutside) {
    const nextLines = sharedNext.split('\n');
    const suffix = nextTemplate !== undefined ? '  (for each node below)' : costSuffix(group);
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}${suffix}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
  // Per-member why/fix continuation, emitted under each row when divergent.
  // Indented one level (two spaces) deeper than the bullet so it reads as a
  // child of that node, matching the continuation indentation.
  const MEMBER_DETAIL_INDENT = `${BLOCK_INDENT}  `;
  const divergentDetail = (m: CheckIssue): string[] => {
    const out: string[] = [];
    if (perMemberWhy && m.messageData.why) out.push(`${MEMBER_DETAIL_INDENT}Why: ${m.messageData.why.split('\n')[0]}`);
    if (perMemberNext && m.messageData.next && !isOutside) {
      const nextLines = m.messageData.next.split('\n');
      out.push(`${MEMBER_DETAIL_INDENT}Fix: ${nextLines[0]}`);
      for (const extra of nextLines.slice(1)) out.push(`${MEMBER_DETAIL_INDENT}${extra}`);
    }
    return out;
  };

  /**
   * The rows for one block of members. `subjectFor` is what appears where the
   * node path would — the real nodePath for a component member, or the FILE
   * (never an empty bullet) for a nodeless one.
   */
  const buildRows = (blockMembers: CheckIssue[], subjectFor: (m: CheckIssue) => string): MemberRow[] => {
    const rows: MemberRow[] = [];
    if (group.perMemberReason) {
      for (const m of blockMembers) {
        // Every line AFTER line 0 (line 0 is the generic "Aspect X refused on
        // UNIT" header the group header already conveys): the reviewer's reason,
        // or the violation list under its "Violations:" heading.
        const whatTail = m.messageData.what.split('\n').slice(1).map((l) => l.replace(/\s+$/, ''));
        const rowLines = whatTail.length === 0
          ? [`${BLOCK_INDENT}- ${subjectFor(m)}`]
          : [`${BLOCK_INDENT}- ${subjectFor(m)}  ${whatTail[0].trim()}`, ...whatTail.slice(1).map((extra) => `${BLOCK_INDENT}  ${extra}`)];
        rows.push({ lines: rowLines, members: 1, first: m });
      }
      return rows;
    }
    // Members that name the same subject and the same rule — one pair per FILE
    // of a per-file rule — collapse into one row that says how many files; a
    // single such pair names its file. Everything else is a row of its own.
    const byKey = new Map<string, CheckIssue[]>();
    for (const m of blockMembers) {
      const namesRule = group.aspectId === undefined && m.aspectId !== undefined;
      const key = namesRule ? `${subjectFor(m)}\u0000${m.aspectId}` : `${subjectFor(m)}\u0000\u0000${m.messageData.what}`;
      const list = byKey.get(key) ?? [];
      list.push(m);
      byKey.set(key, list);
    }
    for (const members of byKey.values()) {
      const m = members[0];
      const subject = subjectFor(m);
      // For code-only groups (e.g. `unverified`) group.aspectId is undefined
      // because the group spans multiple aspects: each row names its own rule.
      const memberAspectSeg = group.aspectId === undefined && m.aspectId !== undefined ? `  aspect '${m.aspectId}'` : '';
      const fileUnits = members.filter((x) => x.nodePath !== undefined && x.unitKey?.startsWith('file:'));
      const unitSeg = members.length > 1
        ? `  ${count(members.length, fileUnits.length === members.length ? 'file' : 'pair')}`
        : fileUnits.length === 1 ? `  ${toPosixPath(fileUnits[0].unitKey!.slice('file:'.length))}` : '';
      if (memberAspectSeg !== '') {
        rows.push({ lines: [`${BLOCK_INDENT}- ${subject}${memberAspectSeg}${unitSeg}`], members: members.length, first: m });
        continue;
      }
      // A finding with no rule: its own `what` says which node/file/predicate
      // is broken — every line of it, the first beside the bullet and the rest
      // (a file list, a parser message) beneath it.
      const whatLines = (m.messageData.what ?? '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
      const head = whatLines.length > 0 ? `  ${whatLines[0]}` : '';
      const repeat = members.length > 1 ? `  (${count(members.length, 'issue')})` : '';
      rows.push({
        lines: [`${BLOCK_INDENT}- ${subject}${head}${repeat}`, ...whatLines.slice(1).map((l) => `${BLOCK_INDENT}  ${l}`)],
        members: members.length,
        first: m,
      });
    }
    return rows;
  };

  /** Render one block of members (its own rows, its own cap). */
  const renderMemberBlock = (blockMembers: CheckIssue[], subjectFor: (m: CheckIssue) => string): void => {
    const rows = buildRows(blockMembers, subjectFor);
    const truncate = opts.capMembers && rows.length > MEMBER_CAP;
    const shown = truncate ? rows.slice(0, MEMBER_CAP) : rows;
    for (const row of shown) {
      lines.push(...row.lines);
      lines.push(...divergentDetail(row.first));
    }
    if (truncate) {
      const hidden = rows.slice(MEMBER_CAP).reduce((sum, r) => sum + r.members, 0);
      lines.push(`${BLOCK_INDENT}... and ${hidden} more (${drillFor(group)})`);
    }
  };

  if (group.fileCount === 0) {
    // One block, one cap, over every member (a stray member with neither
    // nodePath nor a file: unitKey — never produced by any known issue path —
    // still renders via the empty-subject fallback rather than vanishing).
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
      renderMemberBlock(fileMembers, (m) => toPosixPath(m.unitKey!.slice('file:'.length)));
    }
  }
}
