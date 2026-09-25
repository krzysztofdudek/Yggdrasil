/**
 * The machine-readable form of a check run (`yg check --json`).
 *
 * The text report is written for a person and for an agent that reads prose. A
 * layer sitting ABOVE the agent — a wave close computing a quality index, a
 * dashboard, a CI step deciding what to schedule — needs the same facts without
 * parsing that report. Parsing it is the fragility this document removes: the
 * report is written to be READ, so every wording improvement in it is a breaking
 * change to anyone who scraped it.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within `yg-check/1`,
 * and only a change to an EXISTING field's shape takes a new schema number.
 * Every path is repo-relative POSIX, and every count is the TRUE one for the
 * whole run — the text view's narrowing flags never reach this document.
 */

import type { AspectStatus } from '../model/graph.js';

export const CHECK_JSON_SCHEMA = 'yg-check/1';

/**
 * What the lock currently says about one pair.
 *
 * `unverified` and `stale` are one state as far as the gate is concerned — both
 * block, both are cleared by the same command — but they are different facts: a
 * pair the lock has never seen was never judged, while a stale one was judged
 * and the code moved since.
 */
export type CheckJsonVerdict =
  | 'approved'
  | 'refused'
  | 'unverified'
  | 'stale'
  | 'prompt-too-large'
  | 'companion-error';

/** One expected (rule, unit) pair and what the lock says about it. */
export interface CheckJsonPair {
  aspect: string;
  /** The subject: one component, or one file governed by its architecture type. */
  unit: { kind: 'node' | 'file'; path: string };
  /** The owning component, or null for a file no component owns. */
  node: string | null;
  /** Which reviewer kind answers for this pair. */
  kind: 'llm' | 'deterministic';
  /** Effective status on this subject — what decides whether a finding blocks. */
  status: AspectStatus;
  verdict: CheckJsonVerdict;
  /**
   * Who answered: `deterministic` for a local check, the judge's name for a
   * verdict recorded outside the configured reviewer, otherwise the reviewer
   * tier the rule resolves to. Null when nothing has answered yet.
   */
  reviewer: string | null;
  /** The hash the recorded verdict is bound to, when the lock holds an entry at all. */
  hash: string | null;
  /**
   * WHEN `--approve` filled this verdict, and at which commit — independent of
   * whether the verdict is still in force, so a stale or refused pair still
   * reports it. Null for a deterministic pair (filling one costs nothing, so
   * there is nothing to attribute) and for any pair the lock has never filled.
   * `sha` is null when no commit was resolvable at fill time (no repository,
   * no commit yet, git missing from PATH) — the key is present regardless, so
   * a consumer always finds it.
   */
  filled: { ts: string; sha: string | null } | null;
  /** The violation report, on a refusal in force. */
  report?: string;
}

/** One finding, exactly as the text report counts it. */
export interface CheckJsonIssue {
  code: string;
  severity: 'error' | 'warning';
  aspect?: string;
  node?: string;
  unit?: string;
  what: string;
  why: string;
  next: string;
  /**
   * On an `unverified` finding (or its outside twin): why the pair has no
   * valid verdict. `reviewer-missing`, `reviewer-unreachable`,
   * `reviewer-failed`, `check-failed-to-run` and `suppress-marker-invalid` are
   * infrastructure — re-running the same fill cannot clear them, and `next`
   * names what does; the four fill-time ones appear on the report of the
   * recording run that witnessed them. `stale`, `never-reviewed` and
   * `deterministic-not-run` are pairs waiting for a fill.
   */
  cause?: string;
  /** The word a text report heads this finding with — `refused`, `unmapped`, `unverified`, or the code itself — the same word the text prints in `error[<label>]`. */
  label?: string;
  /** `unit` as a structured subject, the same shape as a pair's `unit`. */
  unitRef?: { kind: 'node' | 'file'; path: string };
  /** A script rule's violations, one per reported location, never cut. */
  violations?: CheckJsonViolation[];
  /** The dependency edges a relation finding is about, never cut. */
  edges?: CheckJsonEdge[];
  /** Every file a coverage finding names, never cut (its `what` may list fewer). */
  files?: string[];
}

/** One location a script rule reported. `line` is null when the rule named none. */
export interface CheckJsonViolation {
  file: string;
  line: number | null;
  message: string;
}

/** One dependency edge: the importing file (and line, when known) and what it reaches. */
export interface CheckJsonEdge {
  file: string;
  line: number | null;
  target: string;
}

/**
 * One text-report group: the findings that share a code (and a rule, for a
 * per-rule code), with the rationale and remedy they share stated once —
 * `members` indexes into `issues`. The per-issue `why` stays in each issue for
 * compatibility; a consumer that wants each rationale once reads it here.
 */
export interface CheckJsonGroup {
  code: string;
  label: string;
  aspect: string | null;
  severity: 'error' | 'warning';
  /** The block's heading sentence, as the text report prints it after `error[<label>]`. */
  subject?: string;
  /** For an unverified block: why its pairs have no verdict. */
  cause?: string;
  /** The shared rationale, or null when the members' rationales differ. */
  why: string | null;
  /** The shared remedy, or null when the members' remedies differ. */
  next: string | null;
  members: number[];
}

/**
 * The one step the run points at first, as data: the same step the text
 * report's `next:` line prints (and `suggestedNext` carries as that line's
 * text). `command` is set when the step is a runnable command, as argv — the
 * same form `yg-error/1`'s `next.command` takes.
 */
export interface CheckJsonNext {
  command: string[] | null;
  text: string;
  /** What the step is about: the node or file it names, when it names one. */
  target: { node?: string; file?: string };
  /**
   * What running `command` costs — the whole command, never one block's share
   * of it: every pending pair it would fill, advisory ones included. Script
   * pairs are free; reviewer pairs are paid, and `reviewerCalls` is what they
   * bill — each pair its tier's consensus — so the three numbers equal the
   * `dryRunBudget` of `command --dry-run --json` on the same tree (`free` its
   * `deterministic`, `reviewerCalls` its `reviewerCalls`). Zero for a step that
   * is not a fill. A fill whose pending pairs are all script pairs is named as
   * `yg check --approve --only-deterministic`, which cannot call the reviewer.
   * (`reviewerCalls` added in 6.1.0.)
   */
  cost: { free: number; reviewerPairs: number; reviewerCalls: number };
  /**
   * The errors the run leaves, each in exactly one bucket by what clears it:
   * `needsFix` a code or graph fix, `fillable` pairs a recording run records,
   * `needsUser` a decision only the user makes (configuring a reviewer), and
   * `waitingOnReviewer` pairs no run can judge until a reviewer is configured
   * or reachable. (`needsUser` and `waitingOnReviewer` added in 6.1.0.)
   */
  remaining: { needsFix: number; fillable: number; needsUser?: number; waitingOnReviewer?: number };
  /**
   * True when the step needs the user's approval before it runs: a fill that
   * calls the paid reviewer, or a decision that is the user's (configuring a
   * reviewer sends code to that provider). Such a step is asked for, never run
   * blindly; a decision's `command` is null.
   */
  requiresUser?: boolean;
  /** The step after this one, as the text report's `then:` line prints it, or null. */
  then: string | null;
}

/** Why a recording run stopped before recording anything, and what stopped it. */
export interface CheckJsonAbort {
  /** `log-gate`: components owe a justification entry; `structural`: a problem leaves the run unsafe. */
  stage: 'structural' | 'log-gate';
  /** The findings that stopped the run, in the same shape as `issues`. */
  issues: CheckJsonIssue[];
}

/** Who judged outside the configured reviewer, and how many pairs in force are theirs. */
export interface CheckJsonJudge {
  name: string;
  pairs: number;
}

/**
 * What this report stands on that the change never touched — present only when
 * the project measures changes against a branch. With nothing to measure
 * against there is no untouched code to speak of, and a zero would claim one.
 */
export interface CheckJsonProgressive {
  /** The branch or ref the change was measured against. */
  reference: string | null;
  /** How many changed paths the measurement accounted for. */
  changedInputs: number | null;
  /** Enforced obligations held outside the change. */
  outside: number | null;
  /** Findings the content guard kept blocking despite git reporting their files unchanged. */
  byteGuardKept: number | null;
  /** The reference tree's object ids could not be reproduced, so no content check was made. */
  byteGuardUnavailable: boolean;
  /** The standing floor: advisory refusals, and enforced findings, on untouched code. */
  noiseFloor: { advisory: number; enforcedOutside: number } | null;
}

export interface CheckJsonDocument {
  schema: typeof CHECK_JSON_SCHEMA;
  project: { name: string; nodes: number; aspects: number; flows: number };
  /** Whether the run blocks, and the exit code it leaves — the same one the text run leaves. */
  /**
   * `preview` on `yg check --approve --dry-run --json`: a cost preview always
   * exits 0, so `code` is 0 whatever the tree holds; `reason` still says what
   * the tree's own gate would say.
   */
  exit: { code: 0 | 1; status: 'pass' | 'fail' | 'aborted' | 'preview'; reason: string };
  coverage: {
    files: number;
    covered: number;
    /** Owned by a component's mapping. Null when the type-level tier is off. */
    nodeOwned: number | null;
    /** Satisfied by an architecture type alone. Null when the type-level tier is off. */
    typeCovered: number | null;
    /** Excluded from coverage by design. Null when the type-level tier is off. */
    excluded: number | null;
    /** True when nothing is required to be covered, so an uncovered file can never fail. */
    requiresNothing: boolean;
  };
  totals: {
    errors: number;
    warnings: number;
    /**
     * How many rules stand at draft — each one's pairs are removed from the
     * expected set entirely. A count of rules, not of pairs (it always was;
     * the description said pairs until 6.1.0).
     */
    draftSkipped: number;
    /** Pair counts by what the lock says, summing to `pairs.length`. */
    verdicts: Record<CheckJsonVerdict, number>;
    /** Verified pairs split by reviewer kind, as the header reports them. */
    verified: { deterministic: number; llm: number };
  };
  pairs: CheckJsonPair[];
  issues: CheckJsonIssue[];
  judges: CheckJsonJudge[];
  /** Null on a project that does not measure changes against a branch. */
  progressive: CheckJsonProgressive | null;
  /** The one concrete step the run points at, or null when there is nothing to do. */
  suggestedNext: string | null;
  /**
   * Present only on `yg check --approve --dry-run --json`: what the fill would
   * cost, as numbers — the same counts the human budget header on stderr states.
   */
  dryRunBudget?: { pairs: number; nodes: number; files: number; deterministic: number; reviewerCalls: number };
  /** The text report's groups, in its order (added by the command layer). */
  groups?: CheckJsonGroup[];
  /** The step `suggestedNext` names, as data (added by the command layer); null on a run with nothing to do. */
  next?: CheckJsonNext | null;
  /**
   * The text report's partial-result banner, or null: set when part of the graph
   * did not load as written, so every other number here describes a fallback.
   */
  banner?: string | null;
  /** Present only when a recording run stopped at a gate (exit.status `aborted`). */
  aborted?: CheckJsonAbort;
  /** The text report's standing `note:` lines, in its order — facts that are not findings (added by the command layer). */
  notes?: string[];
  /**
   * Present (true) only on `yg check --json --compact`: the same document with
   * what a reader can recompute left out — `pairs` lists only the pairs that
   * are not approved (`totals.verdicts.approved` still counts them all), an
   * issue omits its `why` and `next` when its group (`groups[]`) states them,
   * its `label` (its group's) and its `unitRef` (its `unit`, parsed), and the
   * JSON is not indented. Every other field keeps its shape.
   */
  compact?: true;
}

/** Render one check document as pretty-printed JSON with a trailing newline. */
export function formatCheckJson(doc: CheckJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The compact form of a check document (`--json --compact`), for a reader that
 * pays per token: approved pairs left out of `pairs` (their count stays in
 * `totals.verdicts`), each issue's `why` and `next` left out where its group
 * states them once, its `label` and `unitRef` (its group's label, its `unit`
 * parsed), and no indentation. The full document is often 15–40 times
 * the size of the text report, and a gate read by an agent on every change
 * pays for all of it.
 */
export function formatCompactCheckJson(doc: CheckJsonDocument): string {
  const groupOf = new Map<number, CheckJsonGroup>();
  for (const g of doc.groups ?? []) for (const m of g.members) groupOf.set(m, g);
  const issues = doc.issues.map((issue, i) => {
    const g = groupOf.get(i);
    // `label` is its group's, `unitRef` is `unit` parsed: both recomputable.
    const { why, next, label, unitRef, ...rest } = issue;
    return {
      ...rest,
      ...(g !== undefined && g.label === label ? {} : label !== undefined ? { label } : {}),
      ...(unitRef !== undefined && issue.unit === undefined ? { unitRef } : {}),
      ...(g?.why !== undefined && g.why !== null && g.why === why ? {} : { why }),
      ...(g?.next !== undefined && g.next !== null && g.next === next ? {} : { next }),
    };
  });
  const compact = { ...doc, pairs: doc.pairs.filter((p) => p.verdict !== 'approved'), issues, compact: true as const };
  return `${JSON.stringify(compact)}\n`;
}
