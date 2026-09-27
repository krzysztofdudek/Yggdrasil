/**
 * source/cli/src/cli/check-flags.ts — the `yg check` flag parse: which flag
 * combinations are refused, and which report view the rest select.
 *
 * Pure: every function here reads only the parsed flags (and, for the first,
 * the raw argument list) and returns the refusal to print or the view to
 * render. The command decides where a refusal goes and exits; nothing here
 * writes, loads a graph or ends the process.
 *
 * The checks run in the command in a fixed order — the argument-only refusals
 * before the graph is loaded, the combination refusals after it — and each
 * function returns the FIRST refusal in its own list, so the one a user sees
 * for a flag set that breaks several rules at once never depends on anything
 * but that order.
 */

import type { IssueMessage } from '../model/validation.js';
import { resolveTopValue, type CheckView } from '../formatters/check-render-views.js';

/** The flags `yg check` parses. */
export interface CheckFlags {
  approve?: boolean;
  onlyDeterministic?: boolean;
  dryRun?: boolean;
  top?: boolean | string;
  summary?: boolean | string;
  details?: boolean;
  aspect?: string;
  coverage?: boolean;
  quiet?: boolean;
  full?: boolean;
  json?: boolean;
  compact?: boolean;
  attentionDump?: boolean;
}

/** The flag of the read-only view the flags select, first match in a fixed order. */
function viewFlagOf(opts: CheckFlags, wantsTop: boolean): string {
  return wantsTop ? '--top' : opts.summary ? '--summary' : opts.details ? '--details' : '--aspect';
}

/**
 * The refusals decided from the arguments alone, before the graph is loaded.
 *
 * --approve and --no-approve set ONE option, so commander silently keeps
 * whichever came last: `--approve --no-approve` read, `--no-approve --approve`
 * filled. A contradiction must not depend on argument order — it is refused,
 * like every other contradictory pair on this command, from the raw arguments.
 */
export function earlyCheckFlagRefusal(opts: CheckFlags, rawArgs: readonly string[]): IssueMessage | null {
  if (rawArgs.includes('--approve') && rawArgs.includes('--no-approve')) {
    return {
      what: '--approve cannot be combined with --no-approve.',
      why: '--approve asks for a fill (it writes verdicts); --no-approve forces a read-only check. Both set the same switch, so whichever came last would silently win — the run would depend on argument order.',
      next: 'Run: yg check --approve (fill), or yg check --no-approve (read-only).',
    };
  }
  if (opts.compact === true && opts.json !== true) {
    return {
      what: '--compact requires --json.',
      why: '--compact shortens the machine document; the text report is already the short form.',
      next: 'yg check --json --compact',
    };
  }
  return null;
}

/**
 * The refusals of a view flag combined with --json, with another view, or with
 * the writer. --top, --summary, --details and --aspect are READ-ONLY triage
 * views over the plain check wall: they are mutually exclusive with each other,
 * and none combines with --approve (which has its own --dry-run cost preview).
 */
export function checkFlagCombinationRefusal(opts: CheckFlags): IssueMessage | null {
  return jsonFlagRefusal(opts) ?? viewFlagRefusal(opts) ?? aspectFlagRefusal(opts);
}

/**
 * --json is not a narrower view, it is a DIFFERENT one: the document always
 * carries the whole run. The four text-view selectors exist to shorten a wall
 * of prose, and there is no wall here to shorten — a narrowed document would
 * read as a smaller problem rather than a smaller rendering, which is exactly
 * the false-green the triage views are themselves written to avoid.
 *
 * --coverage is legal with every OTHER flag on this command — it is the
 * coverage axis, not a fifth view (see check-render-views.ts). The one
 * exception is --json, and for the opposite reason: the document carries
 * coverage as aggregate counts only and never the per-type listing, so
 * --coverage would have nothing to add to it and would be silently ignored.
 */
function jsonFlagRefusal(opts: CheckFlags): IssueMessage | null {
  if (opts.json !== true) return null;
  const wantsTop = opts.top !== undefined;
  if (wantsTop || opts.summary || opts.details || opts.aspect !== undefined) {
    const viewFlag = viewFlagOf(opts, wantsTop);
    return {
      what: `${viewFlag} cannot be combined with --json.`,
      why: `${viewFlag} narrows the TEXT report — fewer blocks, same counts. --json emits one machine document that always carries the whole run, so there is nothing for a narrowing flag to narrow, and a document trimmed to a few findings would read as a smaller problem instead of a smaller rendering.`,
      next: `Run: yg check --json (the whole run as a document), or yg check ${viewFlag}${opts.aspect !== undefined ? ' <id>' : wantsTop ? ' <n>' : ''} (the narrowed text view).`,
    };
  }
  if (opts.coverage) {
    return {
      what: '--coverage cannot be combined with --json.',
      why: '--coverage adds the per-type coverage LISTING to the text report. The --json document reports coverage as aggregate counts (files, covered, node-owned, type-covered, excluded) and has never carried the per-type breakdown, so there is nothing for --coverage to add — accepting it would silently do nothing.',
      next: 'Run: yg check --coverage (the text report with the per-type listing), or yg check --json (the machine document with the coverage counts).',
    };
  }
  return null;
}

/** --top, --summary and --details against each other and against the writer flags. */
function viewFlagRefusal(opts: CheckFlags): IssueMessage | null {
  const wantsTop = opts.top !== undefined;
  if (wantsTop && opts.summary) {
    return {
      what: '--top and --summary cannot be combined.',
      why: 'Both are read-only triage VIEWS of the same `yg check` result — --top renders the N highest-priority blocks, --summary renders per-node counts only. Asking for both at once is ambiguous; pick one lens.',
      next: 'Run: yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
    };
  }
  // This refusal is also why the type-coverage block's counts-only line
  // (--top / --summary) can never name a "cannot run" pair's SPECIFIC
  // reason: that fact only ever exists inside a --approve run's own
  // in-process fill→check handoff (core/fill.ts), so a view that can
  // never combine with --approve can never carry it either — see
  // check-render-header.ts's unverifiedInstanceTotal, which still shows
  // the plain "no confirmed verdict" COUNT here (that fact costs
  // nothing extra: result.issues already has it regardless of view).
  if ((wantsTop || opts.summary) && opts.approve) {
    return {
      what: `${wantsTop ? '--top' : '--summary'} cannot be combined with --approve.`,
      why: '--top and --summary triage the READ-ONLY check wall (they narrow the output of plain `yg check`, which writes nothing). --approve is the writer path; its own free cost preview is --dry-run. Mixing a read-only triage view with the writer is contradictory.',
      next: `Run: yg check ${wantsTop ? '--top <n>' : '--summary'} (read-only triage), or yg check --approve --dry-run (preview the writer's cost).`,
    };
  }
  // --only-deterministic is a FILL flag (it implies --approve). The read-only
  // triage views (--top / --summary / --details / --aspect) would each be
  // forced read-only by the triage-view override in the command, SILENTLY
  // dropping the requested deterministic fill — the user would believe they
  // filled the deterministic pairs when they did not. Reject the contradiction
  // outright rather than running a read-only check. (The --no-approve +
  // --only-deterministic mutex below covers the explicit read-only flag; this
  // covers the implicit read-only of a triage view.)
  if (opts.onlyDeterministic && (wantsTop || opts.summary || opts.details || opts.aspect !== undefined)) {
    const viewFlag = viewFlagOf(opts, wantsTop);
    return {
      what: `${viewFlag} cannot be combined with --only-deterministic.`,
      why: `${viewFlag} is a READ-ONLY view of the plain \`yg check\` result (it narrows output and writes nothing). --only-deterministic is a FILL flag (it implies --approve, writing the script verdict cache). Mixing a read-only view with the writer would silently drop the fill — the script pairs would NOT be filled.`,
      next: `Run: yg check ${viewFlag}${opts.aspect !== undefined ? ' <id>' : wantsTop ? ' <n>' : ''} (read-only view), or yg check --approve --only-deterministic (script-rule fill).`,
    };
  }
  if (opts.details && (wantsTop || opts.summary)) {
    return {
      what: '--details cannot be combined with --top or --summary.',
      why: '--details, --top, and --summary are all mutually exclusive read-only views of the same `yg check` result — each presents the issue set through a different lens. Asking for more than one at once is ambiguous; pick one.',
      next: 'Run: yg check --details (ungrouped per-issue), yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
    };
  }
  if (opts.details && opts.approve) {
    return {
      what: '--details cannot be combined with --approve.',
      why: '--details is a read-only view of the plain `yg check` result (it writes nothing). --approve is the writer path. Mixing a read-only view with the writer is contradictory.',
      next: 'Run: yg check --details (read-only ungrouped view), or yg check --approve (fill unverified pairs).',
    };
  }
  if (opts.approve === false && opts.onlyDeterministic) {
    return {
      what: '--no-approve cannot be combined with --only-deterministic.',
      why: '--no-approve forces a read-only check (no fill); --only-deterministic asks for a script-rule FILL. The two are contradictory.',
      next: 'Run: yg check --no-approve (read-only), or yg check --approve --only-deterministic (script-rule fill).',
    };
  }
  return null;
}

/** --aspect is a read-only drill-in view and cannot combine with the writer or another view. */
function aspectFlagRefusal(opts: CheckFlags): IssueMessage | null {
  if (opts.aspect === undefined) return null;
  const wantsTop = opts.top !== undefined;
  if (opts.approve) {
    return {
      what: '--aspect cannot be combined with --approve.',
      why: '--aspect is a read-only focus view (it writes nothing). --approve is the writer path. Mixing a read-only view with the writer is contradictory.',
      next: 'Run: yg check --aspect <id> (read-only focus on one rule), or yg check --approve (fill unverified pairs).',
    };
  }
  if (wantsTop || opts.summary || opts.details) {
    const conflicting = wantsTop ? '--top' : opts.summary ? '--summary' : '--details';
    return {
      what: `--aspect cannot be combined with ${conflicting}.`,
      why: '--aspect, --top, --summary, and --details are all mutually exclusive read-only views of the same `yg check` result. Asking for more than one at once is ambiguous; pick one.',
      next: `Run: yg check --aspect <id> (focus view), or yg check ${conflicting} (that view alone).`,
    };
  }
  return null;
}

/**
 * Resolve the read-only triage view. An absent --top is the full view; a
 * numeric/garbage --top is validated here (a NaN/negative/0-as-garbage value is
 * a guided refusal, never a silent full dump), and so is a --summary argument.
 */
export function resolveCheckView(opts: CheckFlags): { view: CheckView } | { refusal: IssueMessage } {
  if (opts.aspect !== undefined) return { view: { kind: 'aspect', id: opts.aspect } };
  if (opts.details) return { view: { kind: 'details' } };
  if (opts.summary !== undefined && opts.summary !== false) {
    if (opts.summary !== true && opts.summary !== 'nodes' && opts.summary !== 'codes') {
      return {
        refusal: {
          what: `--summary takes 'nodes' or nothing; got "${String(opts.summary)}".`,
          why: '--summary rolls the findings up by label (one line per severity); --summary nodes rolls them up by node instead. There is no other way to roll them up.',
          next: 'yg check --summary',
        },
      };
    }
    return { view: { kind: 'summary', by: opts.summary === 'nodes' ? 'nodes' : 'codes' } };
  }
  if (opts.top !== undefined) {
    const n = resolveTopValue(opts.top);
    if (n === null) {
      return {
        refusal: {
          what: `--top expects a positive whole number (1 or more); got "${String(opts.top)}".`,
          why: '--top N prints the N highest-priority issue blocks. Zero, a negative, fractional, or non-numeric value is meaningless, and printing the full wall instead would silently hide that the flag was ignored — masking the very output you tried to narrow.',
          next: 'Run: yg check --top 5 (top 5 blocks), yg check --top (the single suggested-next group), or yg check (full output).',
        },
      };
    }
    return { view: { kind: 'top', n } };
  }
  return { view: { kind: 'full' } };
}

/**
 * Whether the flags select a triage view (--top / --summary / --details /
 * --aspect). A triage view is READ-ONLY and must NOT trigger a fill even when
 * auto_approve is configured.
 */
export function isTriageView(opts: CheckFlags): boolean {
  return opts.top !== undefined || Boolean(opts.summary) || Boolean(opts.details) || opts.aspect !== undefined;
}

/**
 * --dry-run is a preview MODE of --approve, not a standalone alias for the
 * plain read. Without an effective approve mode it is refused: the refusal
 * steers to the intended command rather than silently behaving like `yg check`.
 * Under a committed auto_approve, a bare `yg check` is itself a fill, so only
 * `--no-approve` names the free read there.
 */
export function dryRunWithoutApproveRefusal(autoApprove: string | false | undefined): IssueMessage {
  const autoApproveOn = autoApprove === 'deterministic' || autoApprove === 'full';
  const plainRead = autoApproveOn ? 'yg check --no-approve' : 'yg check';
  return {
    what: '--dry-run requires --approve.',
    why: `--dry-run previews what \`yg check --approve\` would fill (the reviewer-call budget and one line per paid pair) without writing or calling the reviewer; it is a mode of --approve, not a variant of the plain read. ${autoApproveOn ? `This project sets auto_approve: ${String(autoApprove)}, so a bare \`yg check\` fills; \`yg check --no-approve\` is the free, no-write read.` : 'Plain `yg check` is already a free, no-write read.'}`,
    next: `Run: yg check --approve --dry-run (cost preview), or ${plainRead} (plain read).`,
  };
}
