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
import { buildIssueMessage } from '../formatters/message-builder.js';
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

/** `noun` or its plural, by `n`. The plural defaults to `noun + 's'`. */
export function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return n === 1 ? noun : pluralNoun;
}

/** `n` and its noun, agreeing: `1 pair`, `2 pairs`, `0 pairs`. */
export function count(n: number, noun: string, pluralNoun?: string): string {
  return `${n} ${plural(n, noun, pluralNoun)}`;
}

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

// ── Blocks, verdicts, next steps ───────────────────────────

/**
 * A diagnostic as the three-part text every command prints today: what (all of
 * its lines), why, next — one per line, no labels. The labelled block grammar
 * is a later, deliberate change; this keeps the bytes every current reader
 * parses.
 */
export function block(d: Diagnostic | IssueMessage): string {
  return buildIssueMessage(isDiagnostic(d) ? toIssueMessage(d) : d);
}

export type VerdictStatus = 'PASS' | 'FAIL' | 'ABORTED';

/**
 * A report's first line: `<command>: <STATUS>  <tail>`. The `yg check: ` shape
 * is the one anchor external parsers key on, so every report that states a
 * verdict states it through here.
 */
export function verdict(command: string, status: VerdictStatus, tail = '', colour = true): string {
  const word = !colour ? status : status === 'PASS' ? chalk.green(status) : chalk.red(status);
  return `${command}: ${word}${tail !== '' ? `  ${tail}` : ''}`;
}

/** A report's last line: `Next: <step><suffix>`. */
export function next(step: string, suffix = ''): string {
  return `Next: ${step}${suffix}`;
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

export const stdoutSink: TextSink = { write: (text) => { process.stdout.write(text); } };
export const stderrSink: TextSink = { write: (text) => { process.stderr.write(text); } };

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
 * Report a command error: the `Error: what / why / next` text on stderr, in
 * red, and — when this invocation answers in JSON — the yg-error/1 document on
 * stdout. Does not exit: the caller owns the exit (most await exitAfterFlush so
 * a long stdout drains first). `code` names the error for machines; it
 * defaults to `command-error`. With `document: false` the JSON document is
 * left to the caller, whose own document answers this outcome.
 */
export function fail(d: Diagnostic | IssueMessage, code = 'command-error', opts: { document?: boolean } = {}): void {
  const diag = asDiagnostic(d, code);
  process.stderr.write(chalk.red(`Error: ${block(diag)}`) + '\n');
  // `document: false` for a command whose JSON answer to this outcome is its
  // own document (written next), so stdout still carries exactly one.
  if (isJsonOutput() && opts.document !== false) writeJsonDocument(errorDocument(diag));
}

/** {@link fail}, then exit 1 at once. For a command that has written nothing else to stdout. */
export function failAndExit(d: Diagnostic | IssueMessage, code?: string): never {
  fail(d, code);
  process.exit(1);
}

/**
 * A non-fatal notice on stderr — `<prefix>: what / why / next` in yellow. For
 * something the reader should know before the result (a flag held back by
 * CI, a scope the run could not measure), never for a failure.
 */
export function notice(d: Diagnostic | IssueMessage, prefix = 'Notice'): void {
  process.stderr.write(chalk.yellow(`${prefix}: ${block(d)}`) + '\n');
}
