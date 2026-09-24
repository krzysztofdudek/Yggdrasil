/**
 * The CLI's output layer: the one place that decides how a count, a list, a
 * block, a verdict line, a next step and an error read — and where they go.
 *
 * Every command used to hand-roll these: its own plural ("1 pairs"), its own
 * cap and overflow spelling, its own `Error: ${buildIssueMessage(...)}` line
 * with its own exit. The same fact then read differently from command to
 * command, and every cleanup had to find every copy. The primitives below are
 * the shared vocabulary; the Diagnostic model and the code registry they work
 * on live in output-diagnostic.ts.
 *
 * Two sinks, one grammar: text (stderr for errors and progress, stdout for
 * reports) and JSON (a versioned document on stdout). When the invocation
 * answers in JSON ({@link isJsonOutput}), {@link fail} also writes the
 * `yg-error/1` document, so a consumer reading stdout never gets zero bytes for
 * a failed command.
 */

import chalk from 'chalk';
import type { IssueMessage } from '../model/validation.js';
import { type Diagnostic, type Fix, fromIssueMessage, toIssueMessage } from './output-diagnostic.js';
import { neutralizeStream } from '../utils/terminal-safe.js';

// ── Terminal safety ────────────────────────────────────────

/**
 * Show, never obey, control sequences in anything written to stdout or stderr
 * other than yg's own colour and line redraw (see utils/terminal-safe.ts).
 * File names, descriptions, rule text, log entries and reviewer reasons come
 * from the repository or a model and reach the terminal inside yg's output; an
 * OSC 52 in a file name wrote the clipboard, an `ESC[2J` in a description
 * cleared the screen.
 *
 * Installed when this module loads. Every command reaches its output through
 * this layer, so it is loaded before any command writes a byte; the entry point
 * cannot install it itself, because it may depend on command modules only.
 * Idempotent.
 */
export function guardTerminalOutput(): void {
  neutralizeStream(process.stdout);
  neutralizeStream(process.stderr);
}
guardTerminalOutput();

// ── Counts ─────────────────────────────────────────────────

// count() and plural() live in utils/count.ts, so the engine and the
// formatters (which may not import the command layer) write counts the same
// way; re-exported here as part of the grammar every command speaks.
export { count, plural } from '../utils/count.js';

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
export const FIELD_INDENT = '        ';

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
export function block(d: Diagnostic | IssueMessage, severity: HeadingSeverity = 'error', code?: string): string {
  const diag = isDiagnostic(d) ? d : fromIssueMessage(d, { code: code ?? (severity === 'error' ? 'command-error' : '') });
  // A note carries no code; a warning shows one only when it has one.
  const label = severity === 'note' || diag.code === '' ? undefined : diag.code;
  const lines = [heading(severity, label, diag.summary, { colon: true })];
  for (const extra of diag.detail ?? []) if (extra.trim() !== '') lines.push(`  ${extra.replace(/^\s+/, '')}`);
  if (diag.why !== undefined && diag.why !== '') lines.push(...field('why', diag.why));
  // A step reads as the step itself: `yg tree`, not `Run: yg tree`.
  if (diag.fix !== undefined && diag.fix.text !== '') lines.push(next(diag.fix.text.replace(/^Run:?\s+(?=yg )/, '')));
  return lines.join('\n');
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

/** The first line of a fix, or all of it when that line is a heading introducing a list. */
export function fixPointer(fix: Fix | string): string {
  const text = typeof fix === 'string' ? fix : fix.text;
  const firstLine = text.split('\n')[0];
  return firstLine.trimEnd().endsWith(':') ? text : firstLine;
}

// ── Sinks ──────────────────────────────────────────────────

/** Where text goes. */
export interface TextSink {
  write(text: string): void;
}

/**
 * Write text to stdout — a report, a listing, a JSON document. Every command
 * writes its output through this (or {@link writeErr}) rather than calling
 * process.stdout.write itself, so the one place that decides where output
 * goes, and what guards it (terminal safety, installed when this module
 * loads), is here. Returns the stream's backpressure answer, as the stream does.
 */
export function writeOut(text: string): boolean {
  return process.stdout.write(text);
}

/**
 * Write text to stderr — progress, a prompt, a hint around a result. An error,
 * a notice or a warning goes through {@link fail}, {@link notice} or
 * {@link warn} instead, which render it in the one grammar first.
 */
export function writeErr(text: string): boolean {
  return process.stderr.write(text);
}

export const stdoutSink: TextSink = { write: (text) => { writeOut(text); } };
export const stderrSink: TextSink = { write: (text) => { writeErr(text); } };

/** A JSON document on stdout: pretty-printed, one trailing newline. */
export function writeJsonDocument(doc: unknown, sink: TextSink = stdoutSink): void {
  sink.write(`${JSON.stringify(doc, null, 2)}\n`);
}

// ── Errors ─────────────────────────────────────────────────

/** Schema id of the machine form of a command error. */
export const ERROR_JSON_SCHEMA = 'yg-error/1';

/** The machine form of a command error. */
export interface ErrorDocument {
  schema: typeof ERROR_JSON_SCHEMA;
  code: string;
  what: string;
  why: string;
  next: { command: string | null; text: string };
}

let jsonOutput: boolean | undefined;

/**
 * Declare whether this invocation answers in JSON, overriding what the command
 * line says. For a caller that runs a command in-process (a test); the CLI
 * itself never needs it.
 */
export function setJsonOutput(on: boolean | undefined): void {
  jsonOutput = on;
}

/**
 * Whether this invocation answers in JSON: `--json` on its command line. Only a
 * command that declares `--json` gets as far as reporting an error through this
 * layer — the argument parser rejects the flag on every other command first —
 * so reading it here is reading the command's own option.
 */
export function isJsonOutput(): boolean {
  return jsonOutput ?? process.argv.slice(2).includes('--json');
}

/** The yg-error/1 document for a diagnostic. */
export function errorDocument(d: Diagnostic): ErrorDocument {
  const msg = toIssueMessage(d);
  return {
    schema: ERROR_JSON_SCHEMA,
    code: d.code,
    what: msg.what,
    why: msg.why,
    next: { command: d.fix?.command ?? null, text: msg.next },
  };
}

function isDiagnostic(d: Diagnostic | IssueMessage): d is Diagnostic {
  return 'summary' in d;
}

/** A command error's diagnostic from a what/why/next triple. */
function asDiagnostic(d: Diagnostic | IssueMessage, code: string): Diagnostic {
  return isDiagnostic(d) ? d : fromIssueMessage(d, { code });
}

/**
 * Report a command error on stderr in the one error grammar —
 * `error[code]: what`, `why:`, `next:` — and, when this invocation answers in
 * JSON, the yg-error/1 document on stdout. Does not exit: the caller owns the
 * exit (most await exitAfterFlush so a long stdout drains first). `code` names
 * the error for machines and heads the text; it defaults to `command-error`.
 * With `document: false` the JSON document is left to the caller, whose own
 * document answers this outcome.
 */
export function fail(d: Diagnostic | IssueMessage, code?: string, opts: { document?: boolean } = {}): void {
  const diag = asDiagnostic(d, code ?? (isDiagnostic(d) ? d.code : inferErrorCode(d.what)));
  writeErr(`${block(diag, 'error')}\n`);
  // `document: false` for a command whose JSON answer to this outcome is its
  // own document (written next), so stdout still carries exactly one.
  if (isJsonOutput() && opts.document !== false) writeJsonDocument(errorDocument(diag));
}

/**
 * The code of a command error its caller did not name, from what it says: a
 * node that is not in the graph is `node-not-found`, a flag used wrongly is
 * `usage`, anything else `command-error`. A caller that knows better names the
 * code itself.
 */
export function inferErrorCode(what: string): string {
  if (/^node\b.*\b(?:not found|is not in the graph|does not exist in the graph)/i.test(what)) return 'node-not-found';
  if (/cannot be combined|\brequires? --|\bexpects\b|is required|\bneeds (?:exactly )?one of|exactly one of|go together|\btakes '|unknown option|missing required|too many arguments/i.test(what)) return 'usage';
  return 'command-error';
}

/** {@link fail}, then exit 1 at once. For a command that has written nothing else to stdout. */
export function failAndExit(d: Diagnostic | IssueMessage, code?: string): never {
  fail(d, code);
  process.exit(1);
}

/**
 * A non-fatal notice on stderr, in the same grammar as an error but headed
 * `note:` — for something the reader should know before the result (a flag
 * held back by CI, a scope the run could not measure), never for a failure.
 */
export function notice(d: Diagnostic | IssueMessage): void {
  writeErr(`${block(d, 'note')}\n`);
}

/**
 * A non-fatal problem on stderr while a command goes on — a reviewer that
 * could not be reached, a divergence the fill noticed — headed `warning:` in
 * the same grammar as an error. The command's own result reports what it
 * means for the outcome.
 */
export function warn(d: Diagnostic | IssueMessage, code?: string): void {
  writeErr(`${block(d, 'warning', code)}\n`);
}
