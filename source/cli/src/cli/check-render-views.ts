// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (colour and glyphs); the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
/**
 * The views of a check report, all in one hierarchy:
 *
 *   yg check: FAIL  …                  the verdict line (true whole-run counts, always)
 *   partial: …                         when part of the graph did not load
 *   error[label] subject / at: / why: / fix:   the findings, most urgent first
 *   note: …                            standing facts that are not findings
 *   next: …  /  then: …                the one step to take first, and the one after
 *
 * The view decides which blocks show and how many members each lists; the
 * terminal decides only decoration. `next:` is the first step of the first
 * block — never a restated code, never the block's own fix repeated word for
 * word (with one block and nothing to add, there is no `next:` at all) — and
 * the same step is the JSON document's `suggestedNext` and `next`.
 */
import type { CheckIssue, CheckResult } from '../core/check.js';
import { ZERO_CLASSIFYING_TYPES_NOTICE, FEATURE_INDEX_NOT_IGNORED_NOTICE, OUTSIDE_CODES, isConfigLoadFailure } from '../core/check-codes.js';
import { countOutside } from '../core/check-progressive.js';
import { issueViolations } from '../core/check-json.js';
import { COVERAGE_GROUP_EXCLUDED_CODES, coverageBlockLabel, getIssueLabel } from './group-issues.js';
import { renderHeader, useEmoji, renderTypeVisibilityBlock, renderByteGuardNotice, renderBaselineNoiseNotice, renderExternalJudgesNotice } from './check-render-header.js';
import { buildBlocks, renderBlocks, costWords, type CheckBlock, type BlockCost } from './check-render-groups.js';
import { GRAPH_INVALID_CODES, CONFIGURE_REVIEWER_STEP, codeInfo } from './output-diagnostic.js';
import { count, MEMBER_CAP, verdict, next as nextLine, thenStep as thenLine, note, paint, commandArgv } from './output.js';
import type { CheckJsonDocument, CheckJsonGroup, CheckJsonIssue, CheckJsonNext } from '../formatters/check-json.js';
import { toPosixPath } from '../utils/posix.js';

// ── Views ──────────────────────────────────────────────────

/**
 * Read-only render mode for `yg check`. Selected by --top / --summary /
 * --details / --aspect; the --approve path always uses `full`. EVERY view
 * renders the same verdict line with the TRUE counts and the same `next:` —
 * only which blocks show, and how many members each lists, changes. The exit
 * code is computed outside this function from the full issue set, so no view
 * can read as green.
 *   - full    : every block, each member list capped. Default.
 *   - details : every block, every member.
 *   - top  n  : the first n blocks, each capped (bare --top = 1: the block
 *               `next:` points at).
 *   - summary : one rollup line per severity — each label with its count —
 *               or, `by: nodes`, one row per node.
 *   - aspect  : the blocks of one rule, every member.
 */
export type CheckView =
  | { kind: 'full' }
  | { kind: 'top'; n: number }
  | { kind: 'summary'; by?: 'codes' | 'nodes' }
  | { kind: 'details' }
  | { kind: 'aspect'; id: string };

/**
 * The second, INDEPENDENT axis of the report: how much of the type tier's own
 * coverage the run enumerates (`--coverage`). It widens a statement of fact,
 * never narrows the issue set, moves no count and no exit code, which is why
 * it is legal alongside `--approve` while the view flags are not.
 */
export interface CheckRenderOptions {
  /** `--coverage`: render the per-type coverage listing. Default false. */
  coverage?: boolean;
}

/**
 * Parse a raw --top value into a block count, or null on garbage.
 *   - undefined  → caller treats as absent (full view); tolerated → 0.
 *   - true       → bare `--top` → 1 (the block `next:` points at).
 *   - "<int≥1>"  → that integer.
 *   - "0", NaN, negative, fractional, non-numeric → null (guided error).
 */
export function resolveTopValue(raw: boolean | string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw === true) return 1;
  if (raw === false) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1) return null;
  return n;
}

// ── The Next contract ──────────────────────────────────────

/** The one step a report points at, and the one after it. */
export interface NextStep {
  /** The `next:` line's text, or undefined when there is nothing to add. */
  text?: string;
  /** The `then:` line's text, or undefined. */
  then?: string;
  /** The same step as data, for the JSON document. */
  json: CheckJsonNext | null;
}

/** A step: what to run or do, and what it is about. */
interface Action {
  text: string;
  command?: string;
  target: { node?: string; file?: string };
  /** The step is the user's decision: named as one to ask for, never a command to run blindly. */
  requiresUser?: boolean;
}

/**
 * The command groups whose subcommands take a word of their own — `yg aspects
 * log add`. A step's command keeps a third word only after one of these, so a
 * sentence (`yg check and fix …`) never reads as a command, and a three-word
 * command is never cut to two (`yg aspects log`, which only prints its usage).
 * A test keeps this set equal to the command tree the CLI registers.
 */
export const THREE_WORD_GROUPS: ReadonlySet<string> = new Set(['aspects log']);

/**
 * A runnable `yg …` command at the start of a line, without the prose after
 * it: `yg`, its subcommand words (two, or three after a {@link
 * THREE_WORD_GROUPS} group), then flags (each with at most one value) and
 * quoted or path-like arguments. It ends at the first word that is none of
 * those — `yg context --file src/a.ts lists candidate owners` is
 * `yg context --file src/a.ts` — and never keeps an unbalanced bracket.
 */
function leadingCommand(line: string): string | undefined {
  const text = line.trim();
  if (!/^yg [a-z]/.test(text)) return undefined;
  const tokens = text.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const out: string[] = ['yg'];
  let words = 0;
  let expectValue = false;
  for (const raw of tokens.slice(1)) {
    const t = raw.replace(/[,;)]+$/, '').replace(/\.$/, '');
    const bare = /^[a-z][a-z-]*$/.test(t);
    const subcommand = bare && out.length === 1 + words && (words < 2 || (words === 2 && THREE_WORD_GROUPS.has(out.slice(1).join(' '))));
    if (t === '' || t === '—' || t.startsWith('(')) break;
    if (t.startsWith('-')) { out.push(t); expectValue = true; }
    else if (expectValue) { out.push(t); expectValue = false; }
    else if (subcommand) { out.push(t); words++; }
    else if (/^['"<]|[/.]/.test(t)) out.push(t);
    else break;
    if (t !== raw) break;
  }
  return out.length > 1 ? out.join(' ') : undefined;
}

/**
 * A `yg …` command a line offers as the step (`…: yg type-suggest --file
 * <path>`, or quoted in backticks) — never one it mentions as what to do after
 * the fix (`… and re-run yg check`).
 */
function embeddedCommand(line: string): string | undefined {
  const at = line.search(/(:\s+|`)yg [a-z]/);
  if (at < 0) return undefined;
  return leadingCommand(line.slice(at).replace(/^[\s:`(]+/, '').replace(/`.*$/, ''));
}

/**
 * A repository file a fix names (`.yggdrasil/model/app/svc-05/yg-node.yaml`),
 * to edit. The graph's own two files are named by their place in the repository
 * even when the fix names them bare.
 */
function namedFile(line: string): string | undefined {
  const m = /(?:^|\s)((?:\.?[\w@-]+\/)*[\w.@-]+\.(?:ya?ml|md|mjs|cjs|js|ts|tsx|json))\b/.exec(line);
  if (m === null) return undefined;
  if (/^yg-(?:architecture|config)\.yaml$/.test(m[1])) return `.yggdrasil/${m[1]}`;
  // A bare name (`yg-node.yaml`) is not a location: which one is not said.
  return m[1].includes('/') ? m[1] : undefined;
}

/**
 * A file a person designs an architecture type for: source code — never a
 * document, a manifest, a lockfile or a dotfile. A fresh repository's first
 * uncovered files are README.md and package.json, and a step that asks for a
 * type to classify the README is the wrong first move.
 */
function isCodeFile(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  if (base.startsWith('.') || !/\.[A-Za-z0-9]+$/.test(base)) return false;
  return !/\.(?:md|mdx|markdown|txt|rst|adoc|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|lock|xml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf|html?|css|scss|map|log|env)$/i.test(base);
}

/** Fill what the CLI knows into a step's placeholders: a node, a code file. */
function fillPlaceholders(text: string, b: CheckBlock): string {
  const first = b.members[0];
  let out = text;
  if (first.nodePath !== undefined) out = out.split('<node>').join(toPosixPath(first.nodePath));
  const file = b.members.flatMap((m) => m.uncoveredFiles ?? []).find(isCodeFile);
  if (file !== undefined) out = out.replace(/<(?:uncovered-)?path>/g, toPosixPath(file));
  return out;
}

/** The reviewer causes whose pairs wait on a reviewer that is missing or failed: no fill clears them. */
const WAITS_ON_REVIEWER: ReadonlySet<string> = new Set(['reviewer-missing', 'reviewer-unreachable', 'reviewer-failed']);

/** The step a block names when its remedy is the user's decision, or undefined. */
function decisionOf(b: CheckBlock): string | undefined {
  return codeInfo(b.code).decision ?? (b.cause === 'reviewer-missing' ? CONFIGURE_REVIEWER_STEP : undefined);
}

/** A pending block one recording run fills. */
function isFill(b: CheckBlock): boolean {
  return b.severity === 'error' && b.tier === 'T3' && b.fix?.startsWith('yg check --approve') === true;
}

/**
 * The first step of a block, in the Next contract's terms: a runnable `yg`
 * command, or an imperative naming a concrete location (`edit src/a.ts:1`), or
 * — when the remedy is the user's to decide — the step worded as one to ask
 * for. Everything the CLI knows is filled in; a placeholder stays only for what
 * a person must supply (`<why this change was made>`).
 */
function blockAction(b: CheckBlock): Action | undefined {
  if (b.outside) return undefined;
  const first = b.members[0];
  const node = first.nodePath !== undefined ? toPosixPath(first.nodePath) : undefined;
  const target = { ...(node !== undefined ? { node } : {}) };
  const decision = decisionOf(b);
  if (decision !== undefined) return { text: decision, target, requiresUser: true };
  // A script rule's refusal is fixed where it is: the first violation's line.
  const located = issueViolations(first)?.find((v) => v.file !== '');
  if (located !== undefined) {
    const where = `${located.file}${located.line !== null ? `:${located.line}` : ''}`;
    return { text: `edit ${where}`, target: { ...target, file: located.file } };
  }
  // A refusal with no line to point at is still fixed in the code, never by
  // re-running what was just recorded for that same code.
  const base = b.code.replace(/-outside$/, '');
  if (base === 'aspect-violation-enforced' || base === 'aspect-violation-advisory') {
    const unit = node ?? (first.unitKey?.startsWith('file:') ? toPosixPath(first.unitKey.slice(5)) : undefined);
    return { text: `change the code${unit !== undefined ? ` of ${unit}` : ''} so it satisfies ${b.aspectId ?? first.aspectId ?? 'the rule'}`, target };
  }
  const raw = b.fix ?? first.messageData.next ?? '';
  // A hint about where the provider's full output goes is never the step.
  const lines = raw.replace(/\s*For the provider's full output[^\n]*/g, '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  // A reviewer that could not run: the step is its own cause, then the re-run.
  if (b.cause !== undefined && WAITS_ON_REVIEWER.has(b.cause)) {
    const rerun = /^Then re-run:\s*(yg .+?)\.?$/.exec(lines[1] ?? '');
    return { text: `${lines[0].replace(/\.$/, '')}${rerun !== null ? `, then ${rerun[1]}` : ''}`, target };
  }
  // A heading introducing a list (`Four exits:`) is not a step; its first item is.
  // A line ending in ':' is a heading only when a numbered list follows it.
  const written = lines[0].endsWith(':') && lines.length > 1 && /^\d+\.\s/.test(lines[1]) ? lines[1].replace(/^\d+\.\s*/, '') : lines[0];
  const line = fillPlaceholders(written, b);
  const command = leadingCommand(line);
  if (command !== undefined) return { text: command, command, target };
  // A file the fix itself names — not one the CLI filled into a placeholder,
  // which belongs to the command around it.
  // Only a fix that says to change a file names where to go; a file mentioned
  // in passing (a mapping it refers to) is not the step.
  const verb = /^(?:fix|edit|correct|add|remove|change|update|declare|set|rename|move|create|define)\b/i.test(written);
  // A node's own file named bare (`yg-node.yaml`, `log.md`) is that node's file, which the CLI knows.
  const bareOwn = verb && node !== undefined ? /(?:^|\s)(yg-node\.yaml|log\.md)\b/.exec(written) : null;
  // The node a templated fix names is the first member's (the CLI knows it).
  const own = node !== undefined ? written.split('<node>').join(node) : written;
  const file = verb ? namedFile(own) ?? (bareOwn !== null ? `.yggdrasil/model/${node}/${bareOwn[1]}` : undefined) : undefined;
  if (file !== undefined) return { text: `edit ${fillPlaceholders(file, b)}`, target: { ...target, file } };
  // A command that still holds a placeholder the CLI could not fill (no code
  // file to name) is not a step; the sentence before it is.
  const embedded = embeddedCommand(line);
  if (embedded !== undefined && !/<(?:uncovered-)?path>/.test(embedded)) return { text: embedded, command: embedded, target };
  return { text: (embedded !== undefined ? line.split(/(?<=\.)\s+/)[0] : line).replace(/\.$/, ''), target };
}

/**
 * The errors left, by what clears them: a code or graph fix, a recording run
 * (`fillable` pairs), the user's decision (`needsUser`), or a reviewer that is
 * missing or could not run (`waitingOnReviewer` pairs). Each error is in
 * exactly one bucket, so a count never claims a code fix a reviewer owes.
 */
interface Remaining {
  needsFix: number;
  fillable: number;
  needsUser: number;
  waitingOnReviewer: number;
}

function remainingOf(blocks: CheckBlock[]): Remaining {
  const out: Remaining = { needsFix: 0, fillable: 0, needsUser: 0, waitingOnReviewer: 0 };
  for (const b of blocks) {
    if (b.severity !== 'error') continue;
    const n = b.members.length;
    if (isFill(b)) out.fillable += n;
    else if (b.cause !== undefined && WAITS_ON_REVIEWER.has(b.cause)) out.waitingOnReviewer += n;
    else if (decisionOf(b) !== undefined) out.needsUser += n;
    else out.needsFix += n;
  }
  return out;
}

/** Whether a block's errors are in the `needsFix` bucket. */
function needsCodeOrGraphFix(b: CheckBlock): boolean {
  return b.severity === 'error' && !isFill(b) && !(b.cause !== undefined && WAITS_ON_REVIEWER.has(b.cause)) && decisionOf(b) === undefined;
}

/**
 * The recording run a report names, and what running it costs — the whole
 * command, never one block's share of it. `yg check --approve` fills every
 * pending pair, the reviewer's too, so when the step is only the free script
 * pairs it is `--only-deterministic`, which cannot spend anything; a step that
 * does call the reviewer states the full cost and asks the user first (the
 * agent protocol: a paid run is the user's decision).
 */
interface FillStep {
  command: string;
  cost: BlockCost;
  paid: boolean;
}

function fillStep(fills: CheckBlock[], lead: CheckBlock | undefined): FillStep {
  const total = fills.reduce<BlockCost>((c, b) => ({ free: c.free + (b.cost?.free ?? 0), reviewerPairs: c.reviewerPairs + (b.cost?.reviewerPairs ?? 0) }), { free: 0, reviewerPairs: 0 });
  const scriptOnly = total.reviewerPairs === 0 || (lead !== undefined && (lead.cost?.reviewerPairs ?? 0) === 0);
  if (scriptOnly) return { command: 'yg check --approve --only-deterministic', cost: { free: total.free, reviewerPairs: 0 }, paid: false };
  return { command: 'yg check --approve', cost: total, paid: true };
}

/** A fill step's cost in words, with the ask when it is paid. */
function fillWords(step: FillStep): string {
  return `${costWords(step.cost)}${step.paid ? ' — ask the user first' : ''}`;
}

/**
 * The Next contract. `next:` is the first step of the first block — the
 * highest tier present, so never a fill while a code or graph error stands —
 * annotated with the block it belongs to when there are others, with what it
 * costs (the whole command's cost), and with what remains. It never restates a
 * code and never repeats a fix word for word: with one block whose fix IS the
 * step, there is no `next:`. `then:` names the fill once the fixes are in, or —
 * after a free script-only fill — the paid review it left for the user to
 * approve.
 */
export function computeNext(blocks: CheckBlock[], result: Pick<CheckResult, 'issues'>): NextStep {
  const errors = blocks.filter((b) => b.severity === 'error');
  const pool = errors.length > 0 ? errors : blocks;
  const remaining = remainingOf(blocks);
  // Nothing blocks and something sits outside the change: the honest step is
  // the audit that shows it all, never a per-finding remedy the change did not owe.
  if (errors.length === 0 && result.issues.some((i) => OUTSIDE_CODES.has(i.code))) {
    const n = countOutside(result.issues);
    const text = `yg check --full  (${count(n, 'obligation')} outside your changes)`;
    return {
      text,
      json: { command: ['yg', 'check', '--full'], text, target: {}, cost: { free: 0, reviewerPairs: 0 }, remaining, requiresUser: false, then: null },
    };
  }
  const first = pool.find((b) => blockAction(b) !== undefined);
  if (first === undefined) return { json: null };
  const fills = errors.filter(isFill);
  let action = blockAction(first)!;
  let cost: BlockCost = { free: 0, reviewerPairs: 0 };
  let then: string | undefined;
  if (isFill(first)) {
    const step = fillStep(fills, first);
    action = { text: step.command, command: step.command, target: action.target, ...(step.paid ? { requiresUser: true } : {}) };
    cost = step.cost;
    // A free script-only step leaves the reviewer's pairs: name that paid run next.
    const left = fillStep(fills, undefined);
    if (!step.paid && left.paid) then = `yg check --approve  (${count(left.cost.reviewerPairs, 'reviewer pair')} · paid — ask the user first)`;
  } else if (first.tier !== 'T3' && fills.length > 0) {
    // Then: the fill, once the fixes above it are in.
    const step = fillStep(fills, undefined);
    then = `${step.command}  (${fillWords(step)})`;
  }
  // One parenthetical: which block the step belongs to, what it costs, and what remains.
  const annotations: string[] = [];
  if (pool.length > 1) annotations.push(first.label);
  if (isFill(first)) annotations.push(fillWords(fillStep(fills, first)));
  const ownFixes = needsCodeOrGraphFix(first) ? first.members.length : 0;
  if (first.tier !== 'T3' && first.severity === 'error' && remaining.needsFix > ownFixes) {
    annotations.push(`${count(remaining.needsFix, 'error')} ${remaining.needsFix === 1 ? 'needs' : 'need'} a code or graph fix`);
  }
  const text = `${action.text}${annotations.length > 0 ? `  (${annotations.join(' — ')})` : ''}`;
  const fixFirstLine = first.fix?.split('\n')[0].trim();
  // One block of its kind (the only error, or the only finding) whose fix IS
  // the step: the step would only repeat it.
  const repeatsFix = pool.length === 1 && then === undefined && fixFirstLine !== undefined && fixFirstLine.replace(/\.$/, '') === action.text;
  const json: CheckJsonNext = {
    command: action.requiresUser === true && action.command === undefined ? null : commandArgv(action.command),
    text: action.text,
    target: action.target,
    cost,
    remaining,
    requiresUser: action.requiresUser === true,
    then: then ?? null,
  };
  return { ...(repeatsFix ? {} : { text }), ...(then !== undefined ? { then } : {}), json };
}

// ── The report ─────────────────────────────────────────────

/** The standing facts a report states after its findings: one line each. */
function notes(result: CheckResult): string[] {
  const out: string[] = [];
  const architectureUnloaded = result.issues.some((i) => i.code === 'architecture-invalid');
  if (result.typeLevel && (result.classifyingTypeCount ?? 0) === 0 && !architectureUnloaded) out.push(ZERO_CLASSIFYING_TYPES_NOTICE);
  if (result.featureIndexNotIgnored) out.push(FEATURE_INDEX_NOT_IGNORED_NOTICE);
  for (const text of [renderByteGuardNotice(result), renderBaselineNoiseNotice(result), renderExternalJudgesNotice(result)]) {
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** The step lines at the end of a report. */
function stepLines(step: NextStep): string[] {
  const out: string[] = [];
  if (step.text !== undefined) out.push(nextLine(step.text));
  if (step.then !== undefined) out.push(thenLine(step.then));
  return out.length > 0 ? ['', ...out] : [];
}

export function formatOutput(result: CheckResult, view: CheckView = { kind: 'full' }, autoFilled = false, emoji = useEmoji, render: CheckRenderOptions = {}): string {
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const all = buildBlocks(result.issues);
  const step = computeNext(all, result);

  const viewTag = view.kind === 'top' ? `top ${view.n}` : view.kind === 'aspect' ? `aspect ${view.id}` : view.kind === 'summary' ? (view.by === 'nodes' ? 'summary by node' : 'summary') : view.kind === 'details' ? 'details' : undefined;
  const lines: string[] = [renderHeader(result, errors.length, warnings.length, autoFilled, emoji, viewTag)];

  // The graph did not load as written: say so before anything else, in every
  // view, because everything below was computed without the part that failed.
  const partial = renderPartialResultBanner(result);
  if (partial !== undefined) lines.push('', emoji ? paint.yellow(partial) : partial);

  if (view.kind === 'summary') {
    lines.push('', ...(view.by === 'nodes' ? summaryByNode(result.issues) : summaryByCode(all)));
  } else if (view.kind === 'top') {
    const shown = all.slice(0, view.n);
    lines.push(...renderBlocks(shown, { capMembers: true }, emoji));
    if (all.length > shown.length) lines.push('', `… +${count(all.length - shown.length, 'more block')}  (yg check)`);
  } else if (view.kind === 'aspect') {
    const filtered = all.filter((b) => b.members.some((m) => m.aspectId === view.id));
    const own = buildBlocks(result.issues.filter((i) => i.aspectId === view.id));
    lines.push(...renderBlocks(own, { capMembers: false }, emoji));
    if (filtered.length === 0) lines.push('', `note: rule '${view.id}' has no findings in this run.`);
    // The step for this rule, when it has one of its own; otherwise the run's.
    const ownStep = computeNext(own, { issues: result.issues.filter((i) => i.aspectId === view.id) });
    if (render.coverage && result.typeVisibility && result.typeVisibility.byType.length > 0) {
      lines.push('', renderTypeVisibilityBlock(result, { countsOnly: false }));
    }
    lines.push(...stepLines(ownStep.text !== undefined || ownStep.then !== undefined ? ownStep : step), '');
    return lines.join('\n');
  } else {
    lines.push(...renderBlocks(all, { capMembers: view.kind !== 'details' }, emoji));
  }

  // Type-visibility: a statement of fact about the type tier's own coverage,
  // printed only when asked for by name (--coverage) — counts only inside the
  // two triage views, which exist to keep the report short.
  if (render.coverage && result.typeVisibility && result.typeVisibility.byType.length > 0) {
    lines.push('', renderTypeVisibilityBlock(result, { countsOnly: view.kind === 'summary' || view.kind === 'top' }));
  }

  const standing = notes(result);
  if (standing.length > 0) lines.push('', ...standing.map((t) => (emoji ? paint.dim(note(t)) : note(t))));

  lines.push(...stepLines(step), '');
  return lines.join('\n');
}

// ── Summary views ──────────────────────────────────────────

/**
 * `--summary`: one line per severity, each label with its count, in report
 * order — `errors    refused 8 · relation-broken 1 · unverified 24 (24 reviewer)`.
 * An unverified count says how much of it is free to fill and how much needs
 * the reviewer. Nothing is dropped: every finding the verdict line counts is
 * under exactly one label here.
 */
function summaryByCode(blocks: CheckBlock[]): string[] {
  const out: string[] = [];
  for (const severity of ['error', 'warning'] as const) {
    const byLabel = new Map<string, { size: number; free: number; reviewer: number }>();
    for (const b of blocks.filter((x) => x.severity === severity)) {
      const agg = byLabel.get(b.label) ?? { size: 0, free: 0, reviewer: 0 };
      agg.size += b.size;
      agg.free += b.cost?.free ?? 0;
      agg.reviewer += b.cost?.reviewerPairs ?? 0;
      byLabel.set(b.label, agg);
    }
    if (byLabel.size === 0) continue;
    const parts = [...byLabel].map(([label, a]) => {
      const split = [a.free > 0 ? `${a.free} script` : '', a.reviewer > 0 ? `${a.reviewer} reviewer` : ''].filter((p) => p !== '');
      return `${label} ${a.size}${split.length > 0 ? ` (${split.join(' · ')})` : ''}`;
    });
    out.push(`${severity === 'error' ? 'errors  ' : 'warnings'}  ${parts.join(' · ')}`);
  }
  return out;
}

/** How many per-node rows `--summary nodes` prints before it counts the rest. */
const SUMMARY_CAP = MEMBER_CAP * 2;

/**
 * `--summary nodes`: one row per node (or file, or `(repository)` for a
 * finding about neither) — each label with its count, zero counts left out;
 * the rows with the most findings first when there are more than fit.
 */
function summaryByNode(issues: CheckIssue[]): string[] {
  const byUnit = new Map<string, Map<string, number>>();
  for (const issue of issues) {
    const unit = issue.nodePath !== undefined
      ? toPosixPath(issue.nodePath)
      : issue.unitKey?.startsWith('file:') ? toPosixPath(issue.unitKey.slice('file:'.length)) : '(repository)';
    const label = COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code) ? coverageBlockLabel(issue.code) : getIssueLabel(issue);
    const row = byUnit.get(unit) ?? new Map<string, number>();
    row.set(label, (row.get(label) ?? 0) + (COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code) ? (issue.uncoveredCount ?? 1) : 1));
    byUnit.set(unit, row);
  }
  const total = (u: string): number => [...byUnit.get(u)!.values()].reduce((a, b) => a + b, 0);
  const ranked = [...byUnit.keys()].sort((a, b) => total(b) - total(a) || a.localeCompare(b, 'en'));
  const shown = ranked.slice(0, SUMMARY_CAP);
  const width = Math.max(0, ...shown.map((u) => u.length));
  const out = shown.map((u) => `${u.padEnd(width)}  ${[...byUnit.get(u)!].map(([l, n]) => `${l} ${n}`).join(' · ')}`);
  const hidden = ranked.slice(SUMMARY_CAP);
  if (hidden.length > 0) {
    out.push(`… +${count(hidden.length, 'more row')} with ${count(hidden.reduce((n, u) => n + total(u), 0), 'finding')}  (yg check --details)`);
  }
  return out;
}

// ── Machine document extras ────────────────────────────────

/**
 * Add to a yg-check/1 document what only the command layer knows: each
 * finding's label (the word the text heads it with), the text report's blocks
 * (subject, shared why and fix stated once, members as indexes into `issues`),
 * the partial-result banner, and the Next step — `suggestedNext` set to the
 * text of the report's own `next:` line, and `next` the same step as data.
 * Every field the document already had keeps its shape.
 */
export function enrichCheckJson(doc: CheckJsonDocument, result: CheckResult): CheckJsonDocument {
  const labelOf = (issue: CheckIssue): string =>
    COVERAGE_GROUP_EXCLUDED_CODES.has(issue.code) ? coverageBlockLabel(issue.code) : getIssueLabel(issue);
  const index = new Map<CheckIssue, number>();
  result.issues.forEach((issue, i) => {
    index.set(issue, i);
    doc.issues[i].label = labelOf(issue);
  });
  const blocks = buildBlocks(result.issues);
  doc.groups = blocks.map((b): CheckJsonGroup => ({
    code: b.code,
    label: b.label,
    aspect: b.aspectId ?? null,
    severity: b.severity,
    subject: b.subject,
    ...(b.cause !== undefined ? { cause: b.cause } : {}),
    why: b.why ?? null,
    next: b.fix ?? null,
    members: b.members.map((m) => index.get(m) ?? -1).filter((i) => i >= 0),
  }));
  const step = computeNext(blocks, result);
  doc.suggestedNext = step.json?.text !== undefined ? (step.text ?? step.json.text) : null;
  doc.next = step.json;
  doc.banner = renderPartialResultBanner(result) ?? null;
  // Every fact the text states is in the document: its standing notes too.
  doc.notes = notes(result);
  return doc;
}

/**
 * The yg-check/1 document of a cost preview (`yg check --approve --dry-run
 * --json`): the report of the tree as it stands, with the budget, and an
 * `exit` that says what the process does — a preview exits 0 whatever the
 * tree holds, so `code` is 0 and `status` is `preview`, while `reason` keeps
 * what the tree's own gate would say.
 */
export function previewCheckJson(doc: CheckJsonDocument, budget: NonNullable<CheckJsonDocument['dryRunBudget']>): CheckJsonDocument {
  doc.exit = { code: 0, status: 'preview', reason: `A cost preview: nothing was filled or written. The tree as it stands: ${doc.exit.reason}` };
  doc.dryRunBudget = budget;
  return doc;
}

// ── Gate abort ─────────────────────────────────────────────

/** Which gate stopped a recording run, and the findings that stopped it. */
export interface FillAbort {
  stage: 'structural' | 'log-gate';
  issues: CheckIssue[];
  /** The command to re-run once the gate is cleared — the user's own, flags kept. */
  retry?: string;
}

/** The one-line account of an abort the verdict line and the document both carry. */
function abortReason(abort: FillAbort): string {
  const n = abort.stage === 'log-gate'
    ? new Set(abort.issues.map((i) => i.nodePath ?? '')).size
    : abort.issues.length;
  return abort.stage === 'log-gate'
    ? `nothing recorded — ${count(n, 'node')} ${n === 1 ? 'needs' : 'need'} a log entry first`
    : `nothing ran — ${count(n, 'problem')} must be fixed first`;
}

/**
 * The report of a recording run a gate stopped before it recorded anything:
 * the verdict line says ABORTED (keeping the `yg check:` anchor), the gating
 * findings render as blocks like any report's, `next:` is the first of them
 * with everything the CLI knows filled in, and `then:` re-runs the user's own
 * command, flags kept.
 */
export function formatAbort(abort: FillAbort, emoji = useEmoji): string {
  const lines: string[] = [verdict('yg check', 'ABORTED', abortReason(abort), emoji)];
  const blocks = buildBlocks(abort.issues);
  lines.push(...renderBlocks(blocks, { capMembers: true }, emoji));
  const first = blocks.map(blockAction).find((a) => a !== undefined);
  const step: NextStep = { json: null };
  if (first !== undefined) step.text = first.text;
  if (abort.retry !== undefined) step.then = abort.retry;
  lines.push(...stepLines(step), '');
  return lines.join('\n');
}

/**
 * The yg-check/1 document of an aborted recording run: the read-only report of
 * the same tree (so every count is true), with `exit.status` `aborted`, the
 * reason, the gating findings under `aborted`, and the abort's own next step.
 */
export function abortCheckJson(doc: CheckJsonDocument, abort: FillAbort, issueOf: (i: CheckIssue) => CheckJsonIssue): CheckJsonDocument {
  doc.exit = { code: 1, status: 'aborted', reason: `yg check --approve stopped: ${abortReason(abort)}.` };
  doc.aborted = { stage: abort.stage, issues: abort.issues.map(issueOf) };
  const blocks = buildBlocks(abort.issues);
  const first = blocks.map((b) => ({ b, a: blockAction(b) })).find((x) => x.a !== undefined);
  if (first !== undefined) {
    doc.suggestedNext = first.a!.text;
    doc.next = {
      command: commandArgv(first.a!.command),
      text: first.a!.text,
      target: first.a!.target,
      cost: { free: 0, reviewerPairs: 0 },
      remaining: remainingOf(blocks),
      requiresUser: first.a!.requiresUser === true,
      then: abort.retry ?? null,
    };
  }
  return doc;
}

/**
 * The step list a recording-run preview owes before its budget can be spent:
 * the log entries the gate will ask for, as blocks under one note line.
 */
export function formatOwed(owed: CheckIssue[], emoji = useEmoji): string {
  return [note('a fill stops before spending this budget until these exist:'), ...renderBlocks(buildBlocks(owed), { capMembers: true }, emoji)].join('\n');
}

// ── Partial result ─────────────────────────────────────────

/**
 * The banner a report carries when part of the graph did not load as written:
 * which part, and that the findings below were computed without it. Undefined
 * on every ordinary run.
 */
function renderPartialResultBanner(result: CheckResult): string | undefined {
  const failed = result.issues.filter((i) => i.severity === 'error' && (GRAPH_INVALID_CODES.has(i.code) || isConfigLoadFailure(i)));
  if (failed.length === 0) return undefined;
  const parts: string[] = [];
  if (failed.some((i) => isConfigLoadFailure(i))) parts.push('yg-config.yaml did not load, so its defaults were used');
  if (failed.some((i) => i.code === 'architecture-invalid')) parts.push('yg-architecture.yaml did not load, so no architecture rule was checked');
  const components = [...new Set(failed.filter((i) => i.code === 'yaml-invalid' && i.nodePath !== undefined).map((i) => toPosixPath(i.nodePath!)))];
  const otherYaml = failed.filter((i) => i.code === 'yaml-invalid' && i.nodePath === undefined).length;
  if (components.length > 0) {
    const sample = components.slice(0, 3).join(', ') + (components.length > 3 ? ', …' : '');
    parts.push(`${count(components.length, 'component file')} did not parse (${sample}), so ${components.length === 1 ? 'that component was' : 'those components were'} left out`);
  }
  if (otherYaml > 0) parts.push(`${count(otherYaml, 'rule file')} did not parse`);
  if (failed.some((i) => i.code === 'lock-invalid')) parts.push('the verdict lock did not load');
  return `partial: ${parts.join('; ')} — the findings below were computed without it and may be symptoms of it; fix it first.`;
}
