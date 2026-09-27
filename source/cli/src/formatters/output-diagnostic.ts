/**
 * The Diagnostic model and the code registry — the data half of the CLI's
 * output layer (the words and layout half is `output-grammar.ts`, and the
 * streams it is written to are the command layer's `cli/output.ts`).
 *
 * A Diagnostic is one thing the CLI has to tell its reader: an error that stops
 * a command, a finding in a report, a warning, a note. Every command used to
 * build that text by hand, so one fact came out in several layouts; the model
 * keeps the parts apart (what, where, why, fix) so a renderer can lay them out
 * one way everywhere, and so the JSON form carries the same parts the text
 * does.
 *
 * The code registry (utils/issue-code-registry.ts) answers, per issue code,
 * the questions every renderer used to answer on its own: the short label a
 * report heads the finding with, the tier it sorts into, the noun its members
 * are counted in. One table, so a label, a count and an ordering cannot
 * disagree between two views of the same run — and the same table the docs
 * code tables are rendered from, so what a report calls a code and what the
 * reference says it means cannot drift apart either.
 */

import type { IssueMessage } from '../model/validation.js';
import type { IssueCode, OutsideTwinCode } from '../model/issue-code.js';
import { CONFIGURE_REVIEWER_STEP, ISSUE_CODES, issueCodeEntry, type Tier } from '../utils/issue-code-registry.js';

// Re-exported so the report renderers keep reaching them where they always did.
export { CONFIGURE_REVIEWER_STEP };
export type { Tier };

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
  /** Stable machine identity — a registered issue code (a check finding's, or a command error's such as `usage`), or a finding's outside twin. */
  code: IssueCode | OutsideTwinCode;
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
 * Codes whose failure means the graph did not load as written: a
 * configuration, architecture, component or lock file that does not parse or
 * does not validate. While one is present, the rest of a report describes a
 * graph with parts missing or replaced by defaults.
 */
export const GRAPH_INVALID_CODES: ReadonlySet<string> = new Set<IssueCode>([
  'config-invalid',
  'architecture-invalid',
  'yaml-invalid',
  'lock-invalid',
]);

/**
 * Every code whose label, tier, noun or decision differs from the default
 * (label = the code itself, tier T1, noun "issue") — the codes a report ranks
 * and labels specially; a test holds each one's step to the Next contract. Read
 * off the registry, so a code gains or loses special treatment in one place.
 */
export const REGISTERED_CODES: readonly string[] = ISSUE_CODES.filter((code) => {
  const e = issueCodeEntry(code);
  return e !== undefined && (e.label !== undefined || e.tier !== undefined || e.noun !== undefined || e.decision !== undefined);
});

const DEFAULT_TIER: Tier = 'T1';

/** The suffix a finding put outside a measured change carries on its code and its label. */
const OUTSIDE_SUFFIX = '-outside';

/**
 * What the registry knows about `code`. An unknown code (every code with no
 * special label) reads as itself, tier T1, counted in issues. A finding put
 * outside a measured change (`<code>-outside`) reads as its mirror with the
 * same suffix on its label, in its mirror's tier.
 */
export function codeInfo(code: string): CodeInfo {
  const own = presentation(code);
  if (own !== undefined) return own;
  if (code.endsWith(OUTSIDE_SUFFIX)) {
    const base = presentation(code.slice(0, -OUTSIDE_SUFFIX.length));
    if (base !== undefined) return { ...base, label: `${base.label}${OUTSIDE_SUFFIX}` };
  }
  return { label: code, tier: DEFAULT_TIER, noun: 'issue' };
}

/** How a registered code renders, with the defaults filled in; undefined for an unregistered one. */
function presentation(code: string): CodeInfo | undefined {
  const e = issueCodeEntry(code);
  if (e === undefined) return undefined;
  return {
    label: e.label ?? code,
    tier: e.tier ?? DEFAULT_TIER,
    noun: e.noun ?? 'issue',
    ...(e.decision !== undefined ? { decision: e.decision } : {}),
  };
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
export function fromIssueMessage(msg: IssueMessage, opts: { code: IssueCode | OutsideTwinCode; severity?: Severity; subject?: string }): Diagnostic {
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

/** Whether a value is already a Diagnostic rather than the what/why/next triple it is built from. */
export function isDiagnostic(d: Diagnostic | IssueMessage): d is Diagnostic {
  return 'summary' in d;
}
