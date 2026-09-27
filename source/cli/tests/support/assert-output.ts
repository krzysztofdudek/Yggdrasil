// =============================================================================
// Assert on what the CLI DID, not on how it worded it.
//
// A behaviour test asks "was an `unverified` issue raised for this node, with
// this cause?" or "does next: point at merge-resolve?". Written as
// `toContain('<a sentence of the report>')`, the question breaks on every
// rewording although the answer did not change. These helpers ask it of the
// stable parts of the output instead:
//
//   - a `--json` document: issue `code`, `cause`, `node`, `aspect`, `severity`,
//     `label`; the `next` object's `command` and `requiresUser`; `exit.code`;
//   - the text report's structure: the `error[<label>]` / `warning[<label>]`
//     block headers, the `yg check: PASS|FAIL|ABORTED` verdict line and its
//     counts, and the command on the `next:` line;
//   - an error on stderr: the `error[<code>]:` header.
//
// The exact words the CLI prints are recorded once, in the golden corpus
// (tests/fixtures/golden-corpus/, see golden-corpus.ts). Assert a sentence only
// where that sentence is itself the contract under test.
//
// Every failure message prints what WAS there (the issue codes and causes, the
// block labels), so a failing test says what to look at without a re-run.
//
// Imports only vitest's expect and Node builtins — nothing from src/** — so an
// e2e suite using it stays on the public CLI surface.
// =============================================================================

import { expect } from 'vitest';

/** One issue of a `yg check --json` document — the fields a behaviour test may key on. */
export interface OutputIssue {
  code: string;
  severity?: string;
  cause?: string;
  node?: string;
  aspect?: string;
  unit?: string;
  label?: string;
  what?: string;
  why?: string;
  next?: unknown;
  files?: string[];
  [key: string]: unknown;
}

/** The `next` object of a machine document (`yg-check/1`, `yg-error/1`, …). */
export interface OutputNext {
  command?: string[] | string | null;
  text?: string;
  requiresUser?: boolean;
  target?: { node?: string; file?: string };
}

/**
 * What the issue helpers need of an issue. A suite's own narrower issue type
 * (one without an index signature) is accepted as it is, and returned as it is.
 */
export interface IssueLike {
  code: string;
  severity?: string;
  cause?: string;
  node?: string;
  aspect?: string;
}

/** Any document with an `issues` array: `OutputDoc`, or a suite's own narrower type. */
export interface DocWithIssues<I extends IssueLike> {
  issues?: readonly I[];
}

/** The parts of a machine document these helpers read. Any other field stays reachable. */
export interface OutputDoc {
  schema?: string;
  code?: string;
  issues?: OutputIssue[];
  next?: OutputNext | null;
  suggestedNext?: string | null;
  exit?: { code: number; status?: string };
  [key: string]: unknown;
}

/**
 * Parse the stdout of a `--json` run. On a parse failure the error carries the
 * first part of what was printed, so a test that got a text report or a crash
 * instead of a document says so.
 */
export function parseJson<T = OutputDoc>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`expected one JSON document on stdout, got:\n${stdout.slice(0, 2000)}`);
  }
}

/** The fields an issue can be matched on. Each given field must be equal. */
export type IssueMatch = Partial<Record<'code' | 'severity' | 'cause' | 'node' | 'aspect' | 'unit' | 'label', string>>;

function matches(issue: IssueLike, match: IssueMatch): boolean {
  return Object.entries(match).every(([k, v]) => (issue as unknown as Record<string, unknown>)[k] === v);
}

/** A compact listing of a document's issues, for failure messages. */
function describeIssues(doc: DocWithIssues<IssueLike>): string {
  const issues = doc.issues ?? [];
  if (issues.length === 0) return '(no issues)';
  return issues
    .map((i) => `${i.severity ?? '?'} ${i.code}${i.cause ? `/${i.cause}` : ''}${i.node ? ` @${i.node}` : ''}${i.aspect ? ` [${i.aspect}]` : ''}`)
    .join('\n');
}

/** Every issue of `doc` matching `match` (all issues when `match` is empty). */
export function findIssues<I extends IssueLike>(doc: DocWithIssues<I>, match: IssueMatch = {}): I[] {
  return (doc.issues ?? []).filter((i) => matches(i, match));
}

/** Assert at least one issue matches; returns the first match. */
export function expectIssue<I extends IssueLike>(doc: DocWithIssues<I>, match: IssueMatch): I {
  const found = findIssues(doc, match);
  expect(found.length, `no issue matching ${JSON.stringify(match)}; the document has:\n${describeIssues(doc)}`).toBeGreaterThan(0);
  return found[0];
}

/** Assert no issue matches. */
export function expectNoIssue<I extends IssueLike>(doc: DocWithIssues<I>, match: IssueMatch): void {
  const found = findIssues(doc, match);
  expect(found.length, `expected no issue matching ${JSON.stringify(match)}; the document has:\n${describeIssues(doc)}`).toBe(0);
}

/** The `next` command of a machine document as one string, or null when it names none. */
export function nextCommand(doc: { next?: OutputNext | null }): string | null {
  const cmd = doc.next?.command;
  if (cmd === undefined || cmd === null) return null;
  return Array.isArray(cmd) ? cmd.join(' ') : cmd;
}

/**
 * Assert what a machine document's `next` says. `command` is compared with the
 * command joined by spaces (`null` asserts the step is not a command to run);
 * `requiresUser`, `node` and `file` compare the matching fields.
 */
export function expectNext(
  doc: { next?: OutputNext | null },
  want: { command?: string | null; requiresUser?: boolean; node?: string; file?: string },
): void {
  const got = doc.next;
  expect(got, 'the document carries no next object').toBeTruthy();
  const shown = JSON.stringify(got);
  if (want.command !== undefined) expect(nextCommand(doc), `next is ${shown}`).toBe(want.command);
  if (want.requiresUser !== undefined) expect(got?.requiresUser ?? false, `next is ${shown}`).toBe(want.requiresUser);
  if (want.node !== undefined) expect(got?.target?.node, `next is ${shown}`).toBe(want.node);
  if (want.file !== undefined) expect(got?.target?.file, `next is ${shown}`).toBe(want.file);
}

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

/** One block header of a text report: `error[unverified] 3 pairs …`. */
export interface TextBlock {
  severity: 'error' | 'warning';
  label: string;
  /** The rest of the header line — prose; read it only where the wording is the contract. */
  subject: string;
}

const BLOCK_RE = /^(error|warning)\[([^\]]+)\](?!:)\s?(.*)$/gm;

/** Every block header in a text report, in order. `error[code]:` diagnostics are not blocks — see {@link errorCodes}. */
export function textBlocks(text: string): TextBlock[] {
  return [...text.matchAll(BLOCK_RE)].map((m) => ({ severity: m[1] as TextBlock['severity'], label: m[2], subject: m[3] }));
}

/** Assert a block with this label (and severity, when given) is in the report; returns the first. */
export function expectBlock(text: string, want: { label: string; severity?: TextBlock['severity'] }): TextBlock {
  const blocks = textBlocks(text);
  const found = blocks.filter((b) => b.label === want.label && (want.severity === undefined || b.severity === want.severity));
  const listing = blocks.map((b) => `${b.severity}[${b.label}]`).join(', ') || '(no blocks)';
  expect(found.length, `no ${want.severity ?? 'error or warning'} block [${want.label}]; the report has: ${listing}`).toBeGreaterThan(0);
  return found[0];
}

/** Assert no block with this label (and severity, when given) is in the report. */
export function expectNoBlock(text: string, want: { label: string; severity?: TextBlock['severity'] }): void {
  const found = textBlocks(text).filter((b) => b.label === want.label && (want.severity === undefined || b.severity === want.severity));
  expect(found.map((b) => `${b.severity}[${b.label}] ${b.subject}`)).toEqual([]);
}

/** The `error[<code>]:` diagnostic codes in a stream (a command's refusal, a usage error). */
export function errorCodes(text: string): string[] {
  return [...text.matchAll(/^error\[([^\]]+)\]:/gm)].map((m) => m[1]);
}

/** Assert the stream carries an `error[<code>]:` diagnostic with this code. */
export function expectErrorCode(text: string, code: string): void {
  expect(errorCodes(text), `no error[${code}]: diagnostic in:\n${text.slice(0, 2000)}`).toContain(code);
}

/** The verdict line of a `yg check` report: `yg check: FAIL  5 errors · 1 warning …`. */
export interface VerdictLine {
  status: 'PASS' | 'FAIL' | 'ABORTED';
  errors: number;
  warnings: number;
}

/** Read the verdict line; undefined when the report has none. Absent counts read as 0. */
export function verdictLine(text: string): VerdictLine | undefined {
  const m = /^yg check: (PASS|FAIL|ABORTED)\b(.*)$/m.exec(text);
  if (m === null) return undefined;
  const count = (noun: string): number => {
    const c = new RegExp(`(\\d+) ${noun}s?\\b`).exec(m[2]);
    return c === null ? 0 : Number(c[1]);
  };
  return { status: m[1] as VerdictLine['status'], errors: count('error'), warnings: count('warning') };
}

/** Assert the verdict line's status and, when given, its counts. */
export function expectVerdict(text: string, want: { status: VerdictLine['status']; errors?: number; warnings?: number }): void {
  const got = verdictLine(text);
  expect(got, `no "yg check:" verdict line in:\n${text.slice(0, 2000)}`).toBeDefined();
  expect(got?.status).toBe(want.status);
  if (want.errors !== undefined) expect(got?.errors).toBe(want.errors);
  if (want.warnings !== undefined) expect(got?.warnings).toBe(want.warnings);
}

/**
 * The command on a text report's `next:` line — the text up to the two-space gap
 * before its note (`next: yg check --approve  (3 pairs · free)` gives
 * `yg check --approve`). Undefined when there is no `next:` line.
 */
export function textNext(text: string): string | undefined {
  const m = /^next: (.*)$/m.exec(text);
  if (m === null) return undefined;
  return m[1].split(/ {2,}/)[0].trim();
}
