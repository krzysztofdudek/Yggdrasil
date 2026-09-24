/**
 * The Diagnostic model and the code registry — the data half of the CLI's
 * output layer (the words and layout half is `output.ts`).
 *
 * A Diagnostic is one thing the CLI has to tell its reader: an error that stops
 * a command, a finding in a report, a warning, a note. Every command used to
 * build that text by hand, so one fact came out in several layouts; the model
 * keeps the parts apart (what, where, why, fix) so a renderer can lay them out
 * one way everywhere, and so the JSON form carries the same parts the text
 * does.
 *
 * The registry answers, per issue code, the questions every renderer used to
 * answer on its own: the short label a report heads the finding with, the
 * tier it sorts into, the noun its members are counted in. One table, so a
 * label, a count and an ordering cannot disagree between two views of the same
 * run.
 */

import type { IssueMessage } from '../model/validation.js';

/** How a diagnostic weighs: `error` blocks, `warning` never does, `note` is context. */
export type Severity = 'error' | 'warning' | 'note';

/**
 * The remedy. `text` is always present and always readable on its own;
 * `command` is set when the remedy IS a command the reader can run as-is, so a
 * machine consumer never has to fish one out of prose.
 */
export interface Fix {
  command?: string;
  text: string;
}

/** One thing the CLI tells its reader. */
export interface Diagnostic {
  severity: Severity;
  /** Stable machine identity — an issue code, or `usage` / `internal` for a command error. */
  code: string;
  /** Short heading word; defaults to the registry label for `code`. */
  label?: string;
  /** What the diagnostic is about — a node, a file, a rule — when it is about one thing. */
  subject?: string;
  /** What happened, in one line. */
  summary: string;
  /** Further lines of what happened (a violation list, a file list), in order. */
  detail?: string[];
  /** Why it matters. */
  why?: string;
  /** What to do about it. */
  fix?: Fix;
}

/**
 * Where a code sorts in a report, most urgent first.
 *   - T0: the graph itself did not load as written — every other finding in
 *     the run was computed on a fallback and may be a symptom of this one.
 *   - T1: code and graph errors — a refusal, a relation, coverage, structure.
 *   - T2: gate prerequisites — what must exist before verdicts can be recorded.
 *   - T3: pending — pairs a recording run fills.
 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

/** What the registry knows about one code. */
export interface CodeInfo {
  /** The heading word a report uses for this code. */
  label: string;
  tier: Tier;
  /** Singular noun the members of a finding with this code are counted in. */
  noun: string;
  /**
   * Set when the remedy is the user's decision, never the agent's: the step a
   * report's `next:` names for this code, worded as one to ask the user for.
   * Its JSON `next.command` stays null and `next.requiresUser` is true, so no
   * reader can run it blindly.
   */
  decision?: string;
}

/**
 * The step that configures a reviewer, as a report names it: configuring one
 * sends code to that provider on the user's account, so it is always asked
 * for, never run. `--model` is required by every provider but claude-code, and
 * the draft alternative stays in view.
 */
export const CONFIGURE_REVIEWER_STEP = 'ask the user first: yg init --provider <name> [--model <m>] configures a reviewer, or set the reviewer rules to status: draft';

/**
 * Codes whose failure means the graph did not load as written: a
 * configuration, architecture, component or lock file that does not parse or
 * does not validate. While one is present, the rest of a report describes a
 * graph with parts missing or replaced by defaults.
 */
export const GRAPH_INVALID_CODES: ReadonlySet<string> = new Set([
  'config-invalid',
  'architecture-invalid',
  'yaml-invalid',
  'lock-invalid',
]);

/**
 * The codes whose label, tier or noun differs from the default (label = the
 * code itself, tier T1, noun "issue"). The label is the word in a report's
 * heading brackets — `error[refused]` — and the same word the JSON document
 * carries as `label` beside the full `code`, so a reader can match one to the
 * other without a table. A Map, never an object literal, so a lookup of an
 * arbitrary code string can never land on an inherited Object.prototype key.
 */
const REGISTRY: ReadonlyMap<string, CodeInfo> = new Map<string, CodeInfo>([
  ['config-invalid', { label: 'config-invalid', tier: 'T0', noun: 'issue' }],
  ['architecture-invalid', { label: 'architecture-invalid', tier: 'T0', noun: 'issue' }],
  ['yaml-invalid', { label: 'yaml-invalid', tier: 'T0', noun: 'file' }],
  ['lock-invalid', { label: 'lock-invalid', tier: 'T0', noun: 'issue' }],
  ['aspect-violation-enforced', { label: 'refused', tier: 'T1', noun: 'pair' }],
  ['aspect-violation-advisory', { label: 'refused', tier: 'T1', noun: 'pair' }],
  ['prompt-too-large', { label: 'prompt-too-large', tier: 'T1', noun: 'pair' }],
  ['aspect-companion-runtime-error', { label: 'aspect-companion-runtime-error', tier: 'T1', noun: 'pair' }],
  ['unmapped-files', { label: 'unmapped', tier: 'T1', noun: 'file' }],
  ['uncovered-advisory', { label: 'uncovered', tier: 'T1', noun: 'file' }],
  ['log-conflict', { label: 'log-conflict', tier: 'T2', noun: 'node' }],
  ['log-entry-missing', { label: 'log-entry-missing', tier: 'T2', noun: 'node' }],
  ['config-reviewer-missing', { label: 'config-reviewer-missing', tier: 'T2', noun: 'issue', decision: CONFIGURE_REVIEWER_STEP }],
  ['unverified', { label: 'unverified', tier: 'T3', noun: 'pair' }],
]);

const DEFAULT_TIER: Tier = 'T1';

/** The suffix a finding put outside a measured change carries on its code and its label. */
export const OUTSIDE_SUFFIX = '-outside';

/**
 * What the registry knows about `code`. An unknown code (every code with no
 * special label) reads as itself, tier T1, counted in issues. A finding put
 * outside a measured change (`<code>-outside`) reads as its mirror with the
 * same suffix on its label, in its mirror's tier.
 */
export function codeInfo(code: string): CodeInfo {
  const own = REGISTRY.get(code);
  if (own !== undefined) return own;
  if (code.endsWith(OUTSIDE_SUFFIX)) {
    const base = REGISTRY.get(code.slice(0, -OUTSIDE_SUFFIX.length));
    if (base !== undefined) return { ...base, label: `${base.label}${OUTSIDE_SUFFIX}` };
  }
  return { label: code, tier: DEFAULT_TIER, noun: 'issue' };
}

/** Sort key for a tier: T0 first. */
export function tierRank(tier: Tier): number {
  return Number(tier.slice(1));
}

/**
 * A diagnostic from the what/why/next triple every engine module returns. The
 * first line of `what` is the summary, the rest its detail; `next` becomes the
 * fix text. The fix is also recorded as a command when its first line IS one,
 * whole: it starts with `yg `, and carries no placeholder, no trailing prose
 * and no second clause to strip — so a machine consumer can run it as given.
 */
export function fromIssueMessage(msg: IssueMessage, opts: { code: string; severity?: Severity; subject?: string }): Diagnostic {
  const [summary, ...detail] = msg.what.split('\n');
  const firstNext = msg.next.split('\n')[0].trim();
  const command = /^yg [^\s]/.test(firstNext) && !/[<>—;(]|,\s/.test(firstNext) && !firstNext.endsWith('.') ? firstNext : undefined;
  return {
    severity: opts.severity ?? 'error',
    code: opts.code,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    summary,
    ...(detail.length > 0 ? { detail } : {}),
    why: msg.why,
    fix: { ...(command !== undefined ? { command } : {}), text: msg.next },
  };
}

/** The what/why/next triple a diagnostic was built from (or would be). */
export function toIssueMessage(d: Diagnostic): IssueMessage {
  return {
    what: [d.summary, ...(d.detail ?? [])].join('\n'),
    why: d.why ?? '',
    next: d.fix?.text ?? '',
  };
}
