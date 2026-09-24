// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (colour and glyphs); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
/**
 * The findings of a check run as blocks — one template for every finding:
 *
 *   error[label] subject
 *     at:   <member>  <unit>  <message>
 *           <member>  …
 *           … +K more  (<drill>)
 *     why:  <why, stated once for the block>
 *     fix:  <what to do>
 *
 * This module turns a list of issues into those blocks (the data: severity,
 * label, tier, subject, members, why, fix, cost, and the one step a reader
 * acts on first) and renders them. The views (check-render-views.ts) decide
 * which blocks a report shows and how many members each lists; the words and
 * the layout of a block are decided here and nowhere else.
 *
 * Every field is labelled, lowercase; a line with no label continues the field
 * above it. The same why is never printed twice in one block: members whose
 * why differs (a node that drifted beside one never verified) are split into
 * blocks of their own, each stating its why once. A fix that differs between
 * members only by the member's own node is stated once, with `<node>` in it.
 */
import type { CheckIssue } from '../core/check.js';
import { baseCodeOfOutsideTwin, type UnverifiedCause } from '../core/check-codes.js';
import { issueViolations } from '../core/check-json.js';
import { groupIssues, getIssueLabel, issuePriorityRank, issueTierRank, COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel, FULL_WHAT_CODES } from './group-issues.js';
import { codeInfo, type Tier } from './output-diagnostic.js';
import { count, MEMBER_CAP, field, heading, decorated } from './output.js';
import { toPosixPath } from '../utils/posix.js';
import { escapeControls } from '../utils/terminal-safe.js';

/**
 * How much of a block a view shows. `capMembers` cuts each member list at
 * MEMBER_CAP lines and ends it with a runnable drill line; it is the VIEW's
 * decision (the drill-in and details views show everything), never the
 * terminal's — a pipe gets the same bounded report a terminal does.
 */
export interface GroupRenderOptions {
  capMembers: boolean;
}

/** What a fill named by a block's fix costs: script pairs are free, reviewer pairs are paid. */
export interface BlockCost {
  free: number;
  reviewerPairs: number;
}

/** One finding block: the data a text view renders and the JSON document mirrors. */
export interface CheckBlock {
  severity: 'error' | 'warning';
  /** The code every member shares. */
  code: string;
  /** The heading word — the code registry's label for `code`. */
  label: string;
  tier: Tier;
  /** The rule the block is about, when all of it is about one. */
  aspectId?: string;
  /** For an unverified block: why its pairs have no verdict. */
  cause?: UnverifiedCause;
  /** The heading sentence. */
  subject: string;
  /** Why it matters — once for the whole block; undefined when there is none to say. */
  why?: string;
  /**
   * What to do: the text as the members carry it, with `<node>` standing for
   * each member's own node when the fixes differ by nothing else
   * (`templated`). Undefined for a finding outside a measured change, whose
   * remedy is the run's own `yg check --full` rather than a per-finding step.
   */
  fix?: string;
  templated: boolean;
  /** Per-member fixes that differ by more than the node: `<member>: <fix>` lines. */
  divergentFix?: string[];
  /** A fill's cost, when the fix is a fill. */
  cost?: BlockCost;
  /** The command that lists every member of this block. */
  drill: string;
  members: CheckIssue[];
  /** How many units the block is about, in its registry noun (files for a coverage block). */
  size: number;
  /** A finding put outside a measured change. */
  outside: boolean;
}

// ── Building blocks ────────────────────────────────────────

/** A member's subject: its node, else the file its pair judges, else nothing (a repo-level finding). */
function unitOf(m: CheckIssue): string {
  if (m.nodePath !== undefined) return toPosixPath(m.nodePath);
  if (m.unitKey?.startsWith('file:')) return toPosixPath(m.unitKey.slice('file:'.length));
  return '';
}

/** The pair a member is about, in the one pair notation every surface uses: `<aspect> @ <unit>`. */
export function pairNotation(m: CheckIssue): string {
  const unit = m.unitKey !== undefined ? toPosixPath(m.unitKey.replace(/^(node|file):/, '')) : unitOf(m);
  return `${m.aspectId ?? '?'} @ ${unit}`;
}

/** `text` with the member's own node path replaced by `<node>`. */
function templateOf(text: string, m: CheckIssue): string {
  const node = m.nodePath !== undefined ? toPosixPath(m.nodePath) : undefined;
  if (node === undefined || node === '') return text;
  // Only where the path stands as a whole path: a short node name ('a') must
  // not rewrite every letter of the sentence around it.
  const escaped = node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\w/.-])${escaped}(?![\\w/-])`, 'g'), '<node>');
}

/** The first line of a text, without a closing full stop (a heading carries none). */
function headline(text: string): string {
  return text.split('\n')[0].trim().replace(/\.$/, '');
}

/** The distinct units a block's members name, and how many are nodes and how many files. */
function unitCounts(members: CheckIssue[]): { nodes: number; files: number } {
  const nodes = new Set(members.filter((m) => m.nodePath !== undefined).map((m) => m.nodePath));
  const files = new Set(members.filter((m) => m.nodePath === undefined && m.unitKey?.startsWith('file:')).map((m) => m.unitKey));
  return { nodes: nodes.size, files: files.size };
}

/** `in 3 nodes`, `in 2 nodes and 1 file`, or `on app/svc-05` for one unit. */
function whereWords(members: CheckIssue[], preposition = 'in'): string {
  const units = [...new Set(members.map(unitOf).filter((u) => u !== ''))];
  if (units.length === 1) return `${preposition} ${units[0]}`;
  const { nodes, files } = unitCounts(members);
  const parts = [nodes > 0 ? count(nodes, 'node') : '', files > 0 ? count(files, 'file') : ''].filter((p) => p !== '');
  return parts.length > 0 ? `${preposition} ${parts.join(' and ')}` : '';
}

const CAUSE_SUBJECT: Record<UnverifiedCause, (pairs: string) => string> = {
  'never-reviewed': (p) => `${p} with no verdict yet`,
  stale: (p) => `${p} whose inputs changed since the verdict`,
  'deterministic-not-run': (p) => `${p} whose script check has not run on this checkout — free to run`,
  'reviewer-missing': (p) => `${p} with no reviewer configured to judge them`,
  'reviewer-unreachable': (p) => `${p} left unjudged — the reviewer was unreachable this run`,
  'reviewer-failed': (p) => `${p} left unjudged — the reviewer returned no verdict this run`,
  'check-failed-to-run': (p) => `${p} whose check.mjs failed to run`,
  'suppress-marker-invalid': (p) => `${p} under a yg-suppress marker that gives no reason`,
};

/** The heading sentence of a block. */
function subjectOf(b: Omit<CheckBlock, 'subject'>, violations: number): string {
  const base = baseCodeOfOutsideTwin(b.code) ?? b.code;
  const outside = b.outside ? ' — outside your changes' : '';
  const members = b.members;
  if (base === 'aspect-violation-enforced' || base === 'aspect-violation-advisory') {
    const where = whereWords(members);
    return violations > 0
      ? `${b.aspectId ?? ''} — ${count(violations, 'violation')} ${where}${outside}`
      : `${b.aspectId ?? ''} — refused ${whereWords(members, 'on')}${outside}`;
  }
  if (base === 'unverified') {
    const pairs = count(members.length, 'pair');
    return `${CAUSE_SUBJECT[b.cause ?? 'never-reviewed'](pairs)}${outside}`;
  }
  if (base === 'unmapped-files') {
    return `${count(b.size, 'file')} ${b.size === 1 ? 'belongs' : 'belong'} to no node${outside}`;
  }
  if (base === 'uncovered-advisory') {
    return `${count(b.size, 'file')} ${b.size === 1 ? 'belongs' : 'belong'} to no node — not under coverage.required, so ${b.size === 1 ? 'it never blocks' : 'they never block'}`;
  }
  if (base === 'log-entry-missing') {
    const n = unitCounts(members).nodes;
    const first = members.every((m) => /first verdicts/.test(m.messageData.what));
    return first
      ? `${count(n, 'node')} ${n === 1 ? 'has' : 'have'} no log entry yet — one is owed before ${n === 1 ? 'its' : 'their'} first verdicts are recorded${outside}`
      : `${count(n, 'node')} changed with no log entry${outside}`;
  }
  if (members.length === 1) return `${headline(members[0].messageData.what)}${outside}`;
  const lines = new Set(members.map((m) => headline(m.messageData.what)));
  if (lines.size === 1) return `${[...lines][0]}${outside}`;
  // All of them say the same thing but for their own node: say it once, with
  // <node> standing for each member listed below.
  const templates = new Set(members.map((m) => headline(templateOf(m.messageData.what, m))));
  if (templates.size === 1) return `${count(unitCounts(members).nodes || members.length, unitCounts(members).nodes > 0 ? 'node' : codeInfo(b.code).noun)}: ${[...templates][0]}${outside}`;
  const where = whereWords(members);
  return `${count(members.length, codeInfo(b.code).noun)}${where !== '' ? ` ${where}` : ''}${outside}`;
}

/** What a fill over these unverified members costs. */
function costOf(members: CheckIssue[]): BlockCost {
  return {
    free: members.filter((m) => m.pairKind === 'deterministic').length,
    reviewerPairs: members.filter((m) => m.pairKind === 'llm').length,
  };
}

/** A block's cost, in words: `24 script pairs · free`, `24 reviewer pairs · paid`, or both. */
export function costWords(cost: BlockCost): string {
  const free = cost.free > 0 ? `${count(cost.free, 'script pair')} · free` : '';
  const paid = cost.reviewerPairs > 0 ? `${count(cost.reviewerPairs, 'reviewer pair')} · paid` : '';
  return [free, paid].filter((p) => p !== '').join(' + ');
}

/** The command that lists every member of a block. */
function drillFor(code: string, aspectId: string | undefined, members: CheckIssue[]): string {
  if (aspectId !== undefined) return `yg check --aspect ${aspectId}`;
  const aspects = new Set(members.map((m) => m.aspectId));
  const [only] = [...aspects];
  if (aspects.size === 1 && only !== undefined && !COVERAGE_GROUP_EXCLUDED_CODES.has(code)) return `yg check --aspect ${only}`;
  return 'yg check --details';
}

/**
 * The fix a block states, from its members' own `next`: one shared text, or
 * one text with `<node>` standing for each member's node, or — when the fixes
 * differ by more than that — one line per member.
 */
function fixOf(members: CheckIssue[]): Pick<CheckBlock, 'fix' | 'templated' | 'divergentFix'> {
  const texts = members.map((m) => m.messageData.next ?? '');
  if (texts.every((t) => t === texts[0])) return { fix: texts[0] !== '' ? texts[0] : undefined, templated: false };
  const templates = new Set(members.map((m) => templateOf(m.messageData.next ?? '', m)));
  if (templates.size === 1) return { fix: [...templates][0], templated: true };
  // Each member's own fix, whole (a heading-introduced list keeps its items),
  // capped like the member list, the rest counted.
  const shown = members.slice(0, MEMBER_CAP);
  const lines = shown.flatMap((m) => {
    const [first, ...rest] = (m.messageData.next ?? '').split('\n');
    return [`${unitOf(m) || '(repository)'}: ${first}`, ...rest.map((l) => `  ${l.trimEnd()}`)];
  });
  if (members.length > shown.length) lines.push(`… +${members.length - shown.length} more  (yg check --details)`);
  return { fix: undefined, templated: false, divergentFix: lines };
}

/** One block from members that share a code, a rule and a why. */
function toBlock(members: CheckIssue[], aspectId: string | undefined): CheckBlock {
  const first = members[0];
  const code = first.code;
  const outside = baseCodeOfOutsideTwin(code) !== undefined;
  const isCoverage = COVERAGE_GROUP_EXCLUDED_CODES.has(code);
  const violations = members.reduce((n, m) => n + (issueViolations(m)?.filter((v) => v.line !== null).length ?? 0), 0);
  // One why for the block: the members' own when they all say the same,
  // else the one they all say but for their own node, with `<node>` in it.
  // A why is a reason, never a stack trace: frames a crash message carries are left to the JSON.
  const whyOf = (m: CheckIssue): string => (m.messageData.why ?? '').split('\n').filter((l) => !/^\s+at\s.*(?:\(|:\d+:\d+)/.test(l)).join('\n');
  const ownWhys = new Set(members.map(whyOf));
  const whys = new Set(members.map((m) => templateOf(whyOf(m), m)));
  const why = ownWhys.size === 1 ? [...ownWhys][0] : whys.size === 1 ? [...whys][0] : undefined;
  const base = baseCodeOfOutsideTwin(code) ?? code;
  const block: Omit<CheckBlock, 'subject'> = {
    severity: first.severity === 'error' ? 'error' : 'warning',
    code,
    label: isCoverage ? coverageBlockLabel(code) : getIssueLabel(first),
    tier: codeInfo(code).tier,
    ...(aspectId !== undefined ? { aspectId } : {}),
    ...(base === 'unverified' ? { cause: first.unverifiedCause ?? 'never-reviewed' } : {}),
    ...(why !== undefined && why !== '' ? { why } : {}),
    ...(outside ? { templated: false } : fixOf(members)),
    ...(base === 'unverified' ? { cost: costOf(members) } : {}),
    drill: drillFor(code, aspectId, members),
    members,
    size: isCoverage ? members.reduce((n, m) => n + (m.uncoveredCount ?? m.uncoveredFiles?.length ?? 0), 0) : members.length,
    outside,
  };
  if (outside) delete block.fix;
  return { ...block, subject: subjectOf(block, violations) };
}

/**
 * Split members that share a code (and a rule) by the why they carry, so each
 * block states one why once. Two members whose why differs only by their own
 * node share one.
 */
function splitByWhy(members: CheckIssue[]): CheckIssue[][] {
  const byWhy = new Map<string, CheckIssue[]>();
  for (const m of members) {
    const key = FULL_WHAT_CODES.has(m.code) ? '' : templateOf(m.messageData.why ?? '', m);
    const list = byWhy.get(key) ?? [];
    list.push(m);
    byWhy.set(key, list);
  }
  return [...byWhy.values()];
}

/** Sort key of a block: errors first, then tier, then the fixed priority, then label and rule. */
function compareBlocks(a: CheckBlock, b: CheckBlock): number {
  if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
  const ta = issueTierRank(a.members[0]);
  const tb = issueTierRank(b.members[0]);
  if (a.severity === 'error' && ta !== tb) return ta - tb;
  const ra = issuePriorityRank(a.members[0]);
  const rb = issuePriorityRank(b.members[0]);
  if (ra !== rb) return ra - rb;
  if (a.label !== b.label) return a.label.localeCompare(b.label, 'en');
  const aa = a.aspectId ?? '';
  const ab = b.aspectId ?? '';
  if (aa !== ab) return aa.localeCompare(ab, 'en');
  return b.members.length - a.members.length;
}

/**
 * Every finding of a run as blocks, most urgent first: errors by tier
 * (graph-invalid, code and graph, gate prerequisites, pending), then warnings.
 * A coverage finding is a block of its own (its members are files); every
 * other finding is grouped by code and rule, then split by why.
 */
export function buildBlocks(issues: CheckIssue[]): CheckBlock[] {
  const blocks: CheckBlock[] = [];
  for (const issue of issues) {
    if (COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code)) blocks.push(toBlock([issue], undefined));
  }
  const rest = issues.filter((i) => !COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  for (const severity of ['error', 'warning'] as const) {
    for (const g of groupIssues(rest.filter((i) => (i.severity === 'error') === (severity === 'error')))) {
      for (const part of splitByWhy(g.members)) blocks.push(toBlock(part, g.aspectId));
    }
  }
  return blocks.sort(compareBlocks);
}

// ── Rendering ──────────────────────────────────────────────

/** One entry of a block's `at:` field: its lines, and how many members it stands for. */
interface AtEntry {
  lines: string[];
  members: number;
  units: Set<string>;
}

/** Pad a unit column so the lines after the first align under the message. */
function padUnit(unit: string, width: number): string {
  return unit.padEnd(width);
}

/** A refusal's entries: one line per violation (script rule) or per refusal (reviewer rule). */
function refusalEntries(members: CheckIssue[]): AtEntry[] {
  const width = Math.max(...members.map((m) => unitOf(m).length));
  const out: AtEntry[] = [];
  for (const m of members) {
    const unit = unitOf(m);
    const violations = issueViolations(m);
    if (violations !== undefined && violations.length > 0) {
      violations.forEach((v, i) => {
        const where = v.line !== null && v.file !== '' ? `${v.file}:${v.line}  ` : v.file !== '' ? `${v.file}  ` : '';
        const [msg, ...more] = v.message.split('\n');
        const lead = i === 0 ? padUnit(unit, width) : ' '.repeat(width);
        out.push({
          lines: [`${lead}  ${where}${escapeControls(msg)}`.replace(/^(\S+)\s{3,}/, '$1  '), ...more.map((l) => `${' '.repeat(width)}    ${escapeControls(l)}`)],
          members: i === 0 ? 1 : 0,
          units: new Set([unit]),
        });
      });
      continue;
    }
    // A reviewer refusal: its reason, after the heading line the block already states.
    const tail = m.messageData.what.split('\n').slice(1).map((l) => l.trim()).filter((l) => l !== '');
    const reason = tail.map((l) => l.replace(/^Reviewer reason:\s*/, '')).join(' ');
    out.push({ lines: [`${padUnit(unit, width)}  ${escapeControls(reason)}`.trimEnd()], members: 1, units: new Set([unit]) });
  }
  return out;
}

/** An unverified block's entries: per pair, or — in a capped view — one line per rule. */
function unverifiedEntries(members: CheckIssue[], capped: boolean): AtEntry[] {
  if (!capped) return members.map((m) => ({ lines: [pairNotation(m)], members: 1, units: new Set([unitOf(m)]) }));
  const byAspect = new Map<string, CheckIssue[]>();
  for (const m of members) {
    const list = byAspect.get(m.aspectId ?? '?') ?? [];
    list.push(m);
    byAspect.set(m.aspectId ?? '?', list);
  }
  const out: AtEntry[] = [];
  for (const [aspect, list] of byAspect) {
    if (list.length === 1) {
      out.push({ lines: [pairNotation(list[0])], members: 1, units: new Set([unitOf(list[0])]) });
      continue;
    }
    const { nodes, files } = unitCounts(list);
    const kinds = new Set(list.map((m) => (m.pairKind === 'llm' ? 'reviewer' : 'script')));
    const parts = [count(list.length, 'pair'), nodes > 0 ? count(nodes, 'node') : '', files > 0 ? count(files, 'file') : '', [...kinds].sort().join(' + ')];
    out.push({ lines: [`${aspect}  ${parts.filter((p) => p !== '').join(' · ')}`], members: list.length, units: new Set(list.map(unitOf)) });
  }
  return out;
}

/** A coverage block's entries: one file per line. */
function coverageEntries(members: CheckIssue[]): AtEntry[] {
  const files = members.flatMap((m) => m.uncoveredFiles ?? []);
  // A file name is repository text: a control sequence in it is shown, never obeyed.
  return files.map((f) => ({ lines: [escapeControls(toPosixPath(f))], members: 1, units: new Set([f]) }));
}

/**
 * Any other block's entries: its member's subject beside the first line of
 * what it says (unless the heading already says it), every further line of
 * that below it. Members that say the same thing about the same subject share
 * one entry.
 */
function genericEntries(b: CheckBlock): AtEntry[] {
  // The heading already says what every member says when there is one member,
  // or when all of them say the same thing but for their own node: then an
  // entry is just its member.
  const single = b.members.length === 1 || new Set(b.members.map((m) => templateOf(m.messageData.what.split('\n')[0], m))).size === 1;
  const byKey = new Map<string, CheckIssue[]>();
  for (const m of b.members) {
    const key = `${unitOf(m)}\u0000${m.messageData.what}`;
    const list = byKey.get(key) ?? [];
    list.push(m);
    byKey.set(key, list);
  }
  const width = Math.max(0, ...b.members.map((m) => unitOf(m).length));
  const out: AtEntry[] = [];
  for (const list of byKey.values()) {
    const m = list[0];
    const unit = unitOf(m);
    const lines = m.messageData.what.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
    const [head = '', ...rest] = lines;
    const headSaid = single || headline(head) === headline(b.subject);
    const repeat = list.length > 1 ? `  (${count(list.length, 'issue')})` : '';
    let entryLines: string[];
    if (unit === '') {
      // A repository-level finding names no member: what it says IS the entry.
      // Said by the heading, it has nothing left to list but its detail.
      entryLines = headSaid ? rest.map((l) => l.trim()) : [`${head}${repeat}`, ...rest.map((l) => `  ${l.trim()}`)];
    } else {
      const first = headSaid ? `${unit}${repeat}` : `${padUnit(unit, width)}  ${head}${repeat}`;
      entryLines = [first, ...rest.map((l) => `  ${l.trim()}`)];
    }
    if (entryLines.length > 0) out.push({ lines: entryLines.map((l) => escapeControls(l)), members: list.length, units: new Set([unit]) });
  }
  return out;
}

function entriesOf(b: CheckBlock, capped: boolean): AtEntry[] {
  const base = baseCodeOfOutsideTwin(b.code) ?? b.code;
  if (COVERAGE_GROUP_EXCLUDED_CODES.has(b.code)) return coverageEntries(b.members);
  if (base === 'aspect-violation-enforced' || base === 'aspect-violation-advisory') return refusalEntries(b.members);
  if (base === 'unverified') return unverifiedEntries(b.members, capped);
  return genericEntries(b);
}

/**
 * The `at:` field's lines, capped at MEMBER_CAP lines in a capped view; a cut
 * list always ends with how much it cut and the command that shows the rest.
 */
function atLines(b: CheckBlock, opts: GroupRenderOptions): string[] {
  const entries = entriesOf(b, opts.capMembers);
  const out: string[] = [];
  let used = 0;
  let cut = -1;
  for (let i = 0; i < entries.length; i++) {
    if (opts.capMembers && used + entries[i].lines.length > MEMBER_CAP && used > 0) {
      cut = i;
      break;
    }
    out.push(...entries[i].lines);
    used += entries[i].lines.length;
  }
  if (cut >= 0) {
    const hidden = entries.slice(cut);
    const base = baseCodeOfOutsideTwin(b.code) ?? b.code;
    const refusal = base === 'aspect-violation-enforced' || base === 'aspect-violation-advisory';
    // A refusal counts what it cut in violations (one line each); anything
    // else in members.
    const more = refusal ? hidden.reduce((n, e) => n + e.lines.length, 0) : hidden.reduce((n, e) => n + e.members, 0);
    out.push(`… +${more} more  (${b.drill})`);
  }
  return out;
}

/** The text of a block's `fix:` field, cost and template note included. */
function fixLines(b: CheckBlock): string[] {
  if (b.fix !== undefined) {
    const [first, ...rest] = b.fix.split('\n');
    const cost = b.cost !== undefined ? costWords(b.cost) : '';
    const suffix = b.templated ? '  for each node above' : cost !== '' && first.startsWith('yg check --approve') ? `  (${cost})` : '';
    // Later lines keep their own indentation: a snippet (a YAML relation to
    // add) is only correct as written.
    return [`${first}${suffix}`, ...rest.map((l) => l.trimEnd())];
  }
  return b.divergentFix ?? [];
}

/** One block, as text. */
export function renderBlock(b: CheckBlock, opts: GroupRenderOptions, colour = decorated): string[] {
  const lines = [heading(b.severity, b.label, b.subject, { colour })];
  lines.push(...field('at', atLines(b, opts), colour));
  if (b.why !== undefined) lines.push(...field('why', b.why, colour));
  lines.push(...field('fix', fixLines(b), colour));
  return lines;
}

/** Blocks, each preceded by a blank line. */
export function renderBlocks(blocks: CheckBlock[], opts: GroupRenderOptions, colour = decorated): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    out.push('');
    out.push(...renderBlock(b, opts, colour));
  }
  return out;
}

/** How many units a block counts, in words: `24 pairs`, `4 files`. */
export function blockSize(b: CheckBlock): string {
  return count(b.size, codeInfo(b.code).noun);
}
