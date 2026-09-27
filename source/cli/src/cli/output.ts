/**
 * The CLI's output layer: the one place that decides how a count, a list, a
 * block, a verdict line, a next step and an error read — and where they go.
 *
 * Every command used to hand-roll these: its own plural ("1 pairs"), its own
 * cap and overflow spelling, its own `Error: ${buildIssueMessage(...)}` line
 * with its own exit. The same fact then read differently from command to
 * command, and every cleanup had to find every copy. The primitives below are
 * the shared vocabulary; the Diagnostic model and the code registry they work
 * on live in formatters/output-diagnostic.ts.
 *
 * Two sinks, one grammar: text (stderr for errors and progress, stdout for
 * reports) and JSON (a versioned document on stdout). When the invocation
 * answers in JSON ({@link isJsonOutput}), {@link fail} also writes the
 * `yg-error/1` document, so a consumer reading stdout never gets zero bytes for
 * a failed command.
 *
 * The grammar itself — the words and the layout — is a formatter
 * (formatters/output-grammar.ts), and the Diagnostic model and code registry
 * are one too (formatters/output-diagnostic.ts), so the report renderers can
 * use them without depending on the command layer; this module keeps the
 * streams and the error path and re-exports the grammar the commands speak.
 */

import type { CodedIssueMessage, IssueMessage } from '../model/validation.js';
import type { IssueCode, OutsideTwinCode } from '../model/issue-code.js';
import { type Diagnostic, fromIssueMessage, toIssueMessage, isDiagnostic } from '../formatters/output-diagnostic.js';
import { block, commandArgv, stepText } from '../formatters/output-grammar.js';
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
function guardTerminalOutput(): void {
  neutralizeStream(process.stdout);
  neutralizeStream(process.stderr);
}
guardTerminalOutput();

// ── Counts ─────────────────────────────────────────────────

// count() and plural() live in utils/count.ts, so the engine and the
// formatters (which may not import the command layer) write counts the same
// way; re-exported here as part of the grammar every command speaks.
export { count, plural } from '../utils/count.js';

// ── The grammar ────────────────────────────────────────────

// The words-and-layout half lives in formatters/output-grammar.ts; the parts
// the commands use are re-exported here, so a command reaches its whole
// grammar through this one module.
export { decorated, paint, field, heading, next, thenStep, note, NO_FILL_COST, fillStepFor, fillStepText } from '../formatters/output-grammar.js';
export type { FillCost } from '../formatters/output-grammar.js';

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

const stdoutSink: TextSink = { write: (text) => { writeOut(text); } };

/** A JSON document on stdout: pretty-printed, one trailing newline. */
function writeJsonDocument(doc: unknown, sink: TextSink = stdoutSink): void {
  sink.write(`${JSON.stringify(doc, null, 2)}\n`);
}

// ── Errors ─────────────────────────────────────────────────

/** Schema id of the machine form of a command error. */
const ERROR_JSON_SCHEMA = 'yg-error/1';

/**
 * The machine form of a command error. `next.command` is argv — the same form
 * as `yg-check/1`'s `next.command` — or null when the step is not a command a
 * reader can run as given; `next.text` is the step as the text's `next:` line
 * prints it. `why` is null when the error has no reason beyond what it says.
 */
export interface ErrorDocument {
  schema: typeof ERROR_JSON_SCHEMA;
  code: IssueCode | OutsideTwinCode;
  what: string;
  why: string | null;
  next: { command: string[] | null; text: string };
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
function isJsonOutput(): boolean {
  return jsonOutput ?? process.argv.slice(2).includes('--json');
}

/** The yg-error/1 document for a diagnostic. */
export function errorDocument(d: Diagnostic): ErrorDocument {
  const msg = toIssueMessage(d);
  return {
    schema: ERROR_JSON_SCHEMA,
    code: d.code,
    what: msg.what,
    why: msg.why !== '' ? msg.why : null,
    next: { command: commandArgv(d.fix?.command), text: stepText(msg.next) },
  };
}

/** A command error's diagnostic from a what/why/next triple. */
function asDiagnostic(d: Diagnostic | IssueMessage, code: IssueCode | OutsideTwinCode): Diagnostic {
  return isDiagnostic(d) ? d : fromIssueMessage(d, { code });
}

/**
 * Report a command error on stderr in the one error grammar —
 * `error[code]: what`, `why:`, `next:` — and, when this invocation answers in
 * JSON, the yg-error/1 document on stdout. Does not exit: the caller owns the
 * exit (most await exitAfterFlush so a long stdout drains first). `code` names
 * the error for machines and heads the text. It is always explicit: a
 * Diagnostic or a {@link CodedIssueMessage} carries its own, and a bare
 * what/why/next must be given one — the code is never guessed from the words,
 * which are free to change while the code is a contract. With
 * `document: false` the JSON document is left to the caller, whose own
 * document answers this outcome.
 */
export function fail(d: Diagnostic | CodedIssueMessage, code?: IssueCode, opts?: { document?: boolean }): void;
export function fail(d: IssueMessage, code: IssueCode, opts?: { document?: boolean }): void;
export function fail(d: Diagnostic | IssueMessage, code?: IssueCode, opts: { document?: boolean } = {}): void {
  const diag = asDiagnostic(d, code ?? ownCode(d));
  writeErr(`${block(diag, 'error')}\n`);
  // `document: false` for a command whose JSON answer to this outcome is its
  // own document (written next), so stdout still carries exactly one.
  if (isJsonOutput() && opts.document !== false) writeJsonDocument(errorDocument(diag));
}

/** The code a diagnostic or a coded message carries; the overloads of {@link fail} guarantee there is one. */
function ownCode(d: Diagnostic | IssueMessage): IssueCode | OutsideTwinCode {
  if (isDiagnostic(d)) return d.code;
  return (d as CodedIssueMessage).code;
}

/**
 * The one node-not-found error every command that takes a node answers with:
 * the same words, the same `node-not-found` code, and the same runnable step
 * (`yg find "<path>"`, argv under --json). `why` says what the command needed
 * the node for.
 */
export function nodeNotFound(nodePath: string, why: string): CodedIssueMessage {
  return { code: 'node-not-found', what: `node '${nodePath}' is not in the graph`, why, next: `yg find "${nodePath}"` };
}

/**
 * The one aspect-not-found error every command that takes a rule id answers
 * with: the same words, the same `aspect-not-found` code, and the same runnable
 * step (`yg aspects`, which lists every rule id the graph declares). The twin
 * of {@link nodeNotFound}; `why` says what the command needed the rule for.
 */
export function aspectNotFound(aspectId: string, why: string): CodedIssueMessage {
  return { code: 'aspect-not-found', what: `rule '${aspectId}' is not in the graph`, why, next: 'yg aspects' };
}

/** {@link fail}, then exit 1 at once. For a command that has written nothing else to stdout. */
export function failAndExit(d: Diagnostic | CodedIssueMessage, code?: IssueCode): never;
export function failAndExit(d: IssueMessage, code: IssueCode): never;
export function failAndExit(d: Diagnostic | IssueMessage, code?: IssueCode): never {
  fail(d as Diagnostic | CodedIssueMessage, code);
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
export function warn(d: Diagnostic | IssueMessage, code?: IssueCode): void {
  writeErr(`${block(d, 'warning', code)}\n`);
}
