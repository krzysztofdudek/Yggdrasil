/**
 * The CLI's output grammar — how a count reads next to its noun, how a list is
 * capped, how a block heading, a labelled field, a verdict line and a next: /
 * then: / note: line are laid out, and how a recording run is named with its
 * price. Pure functions from words to text, so every command and every report
 * renderer speaks the same grammar; where the text goes (the streams, the
 * error path, the JSON error document) is the command layer's output module
 * (cli/output.ts), which re-exports what the commands use from here.
 *
 * Colour lives here too, as decoration only: `paint` is the CLI's one door to
 * chalk, and `decorated` says whether this run decorates at all (off whenever
 * chalk is: NO_COLOR, a pipe, TERM=dumb), so no meaning ever lives in a colour
 * alone.
 */

import chalk from 'chalk';
import type { IssueMessage } from '../model/validation.js';
import type { IssueCode } from '../model/issue-code.js';
import { count } from '../utils/count.js';
import { type Diagnostic, type Fix, fromIssueMessage, isDiagnostic } from './output-diagnostic.js';

// ── Lists ──────────────────────────────────────────────────

/** How many members a list shows before it elides the rest — one constant for every text view. */
export const MEMBER_CAP = 12;

export interface ListOptions {
  /** Show at most this many items; `undefined` or `Infinity` shows them all. */
  cap?: number;
  /** A command that shows the elided items; printed on the overflow line. */
  drill?: string;
  /** Prefix for every line, overflow included. */
  indent?: string;
  /** Override the overflow line's wording (without indent). */
  overflow?: (hidden: number, drill: string | undefined) => string;
}

/** The default overflow line: `… +K more  (drill)`. */
export function overflowLine(hidden: number, drill: string | undefined): string {
  return drill !== undefined ? `… +${hidden} more  (${drill})` : `… +${hidden} more`;
}

/**
 * A list of already-rendered item lines, capped. An elided remainder is always
 * announced, with a drill command when one is given, so a shortened list can
 * never read as the whole of it.
 */
export function list(items: readonly string[], opts: ListOptions = {}): string[] {
  const indent = opts.indent ?? '';
  const cap = opts.cap ?? Infinity;
  const shown = items.length > cap ? items.slice(0, cap) : items;
  const out = shown.map((l) => `${indent}${l}`);
  const hidden = items.length - shown.length;
  if (hidden > 0) out.push(`${indent}${(opts.overflow ?? overflowLine)(hidden, opts.drill)}`);
  return out;
}

// ── The block grammar ──────────────────────────────────────

/**
 * Whether this run decorates its text: colour, and the one glyph a heading or
 * a verdict carries. Off whenever chalk is (NO_COLOR, a pipe, TERM=dumb), so a
 * reader in a pipe gets the same words and layout with nothing added. Meaning
 * is always in the words; decoration only repeats it.
 */
export const decorated: boolean = chalk.level > 0;

/**
 * Colour for the words a text view highlights — the one door to chalk in the
 * CLI. Decoration only: each is the identity whenever colour is off (NO_COLOR,
 * a pipe, TERM=dumb), so no meaning may live in a colour alone. A command that
 * needs a colour takes it from here instead of importing chalk, so what
 * decorates and when is decided in one place.
 */
export const paint = {
  red: (text: string): string => chalk.red(text),
  green: (text: string): string => chalk.green(text),
  yellow: (text: string): string => chalk.yellow(text),
  dim: (text: string): string => chalk.dim(text),
  bold: (text: string): string => chalk.bold(text),
} as const;

/** One of {@link paint}'s colours, for a helper that takes the colour as an argument. */
export type Paint = (text: string) => string;

/**
 * The field labels a block uses, in the order it uses them. Always lowercase,
 * always present when the field is: a line with no label is continuation of
 * the field above it, never a field of its own.
 *   at   — where: the members the finding is about
 *   why  — the reason it matters, stated once for the whole block
 *   fix  — what to do about it
 *   see  — where to read more
 *   id   — the handle a follow-up command takes (a nomination's id)
 */
export type FieldLabel = 'at' | 'why' | 'fix' | 'see' | 'id';

/** Every field value starts at this column; its label is padded to reach it. */
const FIELD_INDENT = '        ';

/**
 * A labelled field: `  why:  <text>`, every later line of a multi-line value
 * aligned under the first (column 9). An empty value renders nothing.
 */
export function field(label: FieldLabel, value: string | string[], colour = decorated): string[] {
  const lines = (Array.isArray(value) ? value : value.split('\n')).filter((l, i) => i > 0 || l.trim() !== '');
  if (lines.length === 0) return [];
  const head = `  ${`${label}:`.padEnd(6)}`;
  const tag = colour ? chalk.dim(head) : head;
  return [`${tag}${lines[0]}`, ...lines.slice(1).map((l) => `${FIELD_INDENT}${l}`)];
}

/** The severity words a heading can start with. */
export type HeadingSeverity = 'error' | 'warning' | 'note' | 'nomination';

/**
 * A block heading: `error[label] subject` (a report finding) or, with
 * `colon`, `error[code]: subject` (a command error). The glyph and the colour
 * are decoration only; the words carry the meaning.
 */
export function heading(severity: HeadingSeverity, label: string | undefined, subject: string, opts: { colon?: boolean; colour?: boolean } = {}): string {
  const colour = opts.colour ?? decorated;
  const tag = `${severity}${label !== undefined && label !== '' ? `[${label}]` : ''}`;
  const sep = opts.colon === true ? ': ' : ' ';
  if (!colour) return `${tag}${sep}${subject}`;
  const glyph = severity === 'error' ? '✗ ' : severity === 'warning' ? '! ' : '';
  const tone = severity === 'error' ? chalk.red : severity === 'warning' ? chalk.yellow : (t: string) => t;
  return `${tone(`${glyph}${tag}`)}${sep}${chalk.bold(subject)}`;
}

/**
 * A diagnostic as a command error or notice reads, on stderr:
 *
 *   error[code]: <what>
 *     <further lines of what>
 *     why:  <why>
 *   next: <step>
 *
 * `severity` picks the heading word (`note` for a notice).
 */
export function block(d: Diagnostic | IssueMessage, severity: HeadingSeverity = 'error', code?: IssueCode): string {
  // A note carries no code, and a warning shows one only when it has one; an
  // error with none named is a command-error.
  const shown = code ?? (isDiagnostic(d) ? d.code : severity === 'error' ? 'command-error' : undefined);
  const diag = isDiagnostic(d) ? d : fromIssueMessage(d, { code: shown ?? 'command-error' });
  const label = severity === 'note' || shown === undefined ? undefined : diag.code;
  const lines = [heading(severity, label, diag.summary, { colon: true })];
  for (const extra of diag.detail ?? []) if (extra.trim() !== '') lines.push(`  ${extra.replace(/^\s+/, '')}`);
  if (diag.why !== undefined && diag.why !== '') lines.push(...field('why', diag.why));
  if (diag.fix !== undefined && diag.fix.text !== '') {
    // An error ends the output, so its step is the `next:` line. A warning or a
    // note is said while a command goes on — a report, or more of the run,
    // follows it — so its remedy is a `fix:` field: `next:` is only ever the
    // last line of the output, and a run shows at most one.
    lines.push(...(severity === 'error' ? [next(stepText(diag.fix.text))] : field('fix', stepText(diag.fix.text))));
  }
  return lines.join('\n');
}

/**
 * A step as it reads: the step itself — `yg tree`, not `Run: yg tree`. The one
 * place a step's text is cleaned, so the text and the JSON form of an error say
 * the same words.
 */
export function stepText(text: string): string {
  return text.replace(/^Run:?\s+(?=yg )/, '');
}

/**
 * A runnable command as argv — `yg find "nope"` is `["yg", "find", "nope"]` —
 * or null when it is not one a reader can run as given: it holds a placeholder
 * (`<name>`), an optional part (`[--model <m>]`) or an unbalanced quote.
 */
export function commandArgv(command: string | undefined): string[] | null {
  if (command === undefined || !/^yg [a-z]/.test(command.trim()) || /[<>[\]]/.test(command)) return null;
  const tokens = command.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  if (tokens.some((t) => /^['"]/.test(t) ? t.length < 2 || t[0] !== t[t.length - 1] : /['"]/.test(t))) return null;
  return tokens.map((t) => (/^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t));
}

export type VerdictStatus = 'PASS' | 'FAIL' | 'ABORTED';

/**
 * A report's first line: `<command>: <STATUS>  <tail>`. The `yg check: ` shape
 * is the one anchor external parsers key on, so every report that states a
 * verdict states it through here.
 */
export function verdict(command: string, status: VerdictStatus, tail = '', colour = true): string {
  const glyph = colour && decorated ? (status === 'PASS' ? '✓ ' : '✗ ') : '';
  const word = !colour ? status : status === 'PASS' ? chalk.green(status) : chalk.red(status);
  return `${glyph}${command}: ${word}${tail !== '' ? `  ${tail}` : ''}`;
}

/**
 * A report's or an error's last line: `next: <step>` — one line; a step that
 * needs more lines keeps them aligned under its first.
 */
export function next(step: string, suffix = ''): string {
  const [first, ...rest] = `${step}${suffix}`.split('\n');
  // Later lines keep their own indentation (a YAML snippet is only correct as written).
  return [`next: ${first}`, ...rest.map((l) => `      ${l.trimEnd()}`)].join('\n');
}

/**
 * The step after `next:`, when there is one worth naming: `then: <step>`.
 * (Never exported as `then`: a module exporting a `then` function is a
 * thenable, and `await import()` of it would call it.)
 */
export function thenStep(step: string): string {
  return `then: ${step.split('\n')[0]}`;
}

/** A standing fact that is not a finding: `note: <text>`, one line. */
export function note(text: string): string {
  return `note: ${text}`;
}

// ── Fill steps ─────────────────────────────────────────────

/** What a recording run fills, priced: script pairs free, reviewer pairs as pairs and the calls they bill. */
export interface FillCost {
  free: number;
  reviewerPairs: number;
  reviewerCalls: number;
}

export const NO_FILL_COST: FillCost = { free: 0, reviewerPairs: 0, reviewerCalls: 0 };

/**
 * A cost, in words: `24 script pairs · free`, `3 reviewer pairs · 9 calls ·
 * paid`, or both — the reviewer's share always as pairs AND calls, since a
 * tier's consensus multiplies what each pair bills.
 */
export function costWords(cost: FillCost): string {
  const free = cost.free > 0 ? `${count(cost.free, 'script pair')} · free` : '';
  const paid = cost.reviewerPairs > 0 ? `${count(cost.reviewerPairs, 'reviewer pair')} · ${count(cost.reviewerCalls, 'call')} · paid` : '';
  return [free, paid].filter((p) => p !== '').join(' + ');
}

/** A recording run as a step: the command, its arguments, what it fills and whether that bills the reviewer. */
export interface FillStep {
  command: string;
  argv: string[];
  cost: FillCost;
  paid: boolean;
}

/**
 * The recording run that fills pending pairs costing `cost`: `yg check
 * --approve --only-deterministic` while none of them calls the reviewer — a
 * run that cannot spend anything — else `yg check --approve`, paid. Every
 * command that names a fill names it through here, so the step and its price
 * read the same from `check`, `context`, `aspects --health` and `impact`. The
 * price is stated, never turned into a question: the agent protocol has the
 * agent run the paid fill itself once its change is final.
 */
export function fillStepFor(cost: FillCost): FillStep {
  if (cost.reviewerPairs === 0) {
    return { command: 'yg check --approve --only-deterministic', argv: ['yg', 'check', '--approve', '--only-deterministic'], cost: { ...NO_FILL_COST, free: cost.free }, paid: false };
  }
  return { command: 'yg check --approve', argv: ['yg', 'check', '--approve'], cost: { ...cost }, paid: true };
}

/** A fill step as a line states it: the command, then what it costs in parentheses. */
export function fillStepText(step: FillStep): string {
  const words = costWords(step.cost);
  return words !== '' ? `${step.command}  (${words})` : step.command;
}

/** The first line of a fix, or all of it when that line is a heading introducing a list. */
export function fixPointer(fix: Fix | string): string {
  const text = typeof fix === 'string' ? fix : fix.text;
  const firstLine = text.split('\n')[0];
  return firstLine.trimEnd().endsWith(':') ? text : firstLine;
}
