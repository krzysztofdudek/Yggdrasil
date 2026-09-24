/**
 * The machine-readable form of a drill run (`yg drill --json`).
 *
 * The text form prints one line per case and a summary line with the five
 * outcome counts. A layer above the agent — Horde's rule ladder, which will not
 * promote a rule whose own cases do not answer as written — needs those counts
 * without reading a sentence whose wording is the CLI's to change.
 *
 * `schema` is the only field a consumer must branch on; new fields may be added
 * freely within `yg-drill/1`, and only a change to an EXISTING field's shape
 * takes a new schema number.
 *
 * This module holds only the document's shape and its pure renderer; the
 * builder, which needs the drill runner's result type, lives in `cli/drill.ts`
 * (the same split as `yg-aspects/1` and `yg-suppressions/1`).
 *
 * The honesty frame of the text form holds here too: a case is named by its
 * corpus label and content hashes, never by its source.
 */

export const DRILL_JSON_SCHEMA = 'yg-drill/1';

/** How one case answered against what its directory says it must be. */
export type DrillJsonOutcome = 'pass' | 'miss' | 'false-alarm' | 'unrun' | 'unsupported';

export interface DrillJsonCounts {
  pass: number;
  miss: number;
  falseAlarm: number;
  unrun: number;
  unsupported: number;
}

export interface DrillJsonCase {
  /** Corpus-relative label, e.g. `violates-todo/bad`. */
  case: string;
  /** What the case directory says the rule must answer. */
  expect: 'refused' | 'satisfied';
  /** What the rule answered, or why it did not. */
  got: 'refused' | 'satisfied' | 'unrun' | 'unsupported';
  outcome: DrillJsonOutcome;
  kind: 'deterministic' | 'llm';
  caseHash: string;
  ruleHash: string;
  /** Reviewer tier, for a reviewer rule. */
  tier: string | null;
  /** Consensus votes, for a reviewer rule that was answered. */
  votes: { satisfied: number; total: number } | null;
  /** Why a case did not run (a prompt over the limit, say), when the runner said. */
  detail: string | null;
}

export interface DrillJsonDocument {
  schema: typeof DRILL_JSON_SCHEMA;
  aspect: string;
  corpus: {
    /** The run's corpus label: `dev`, the `--dir` basename, or `--corpus`. */
    label: string;
    /** `dev` = the rule's own `drills/` directory; `holdout` = a `--dir` corpus. */
    source: 'dev' | 'holdout';
    /** Where the cases were read from, repo-relative (or as given to `--dir`). */
    path: string;
  };
  counts: DrillJsonCounts;
  /** Number of cases run; 0 when the corpus holds none. */
  total: number;
  cases: DrillJsonCase[];
  /**
   * The exit code the command ends with: 1 when any case missed or false-alarmed,
   * 2 when a case did not run and none missed, 0 otherwise (also for an empty
   * corpus, which is not a pass: `total` is 0).
   */
  exitCode: 0 | 1 | 2;
}

/** The document as printed: pretty JSON with a trailing newline. */
export function formatDrillJson(doc: DrillJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
