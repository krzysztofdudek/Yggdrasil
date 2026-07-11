/**
 * source/cli/src/io/drill-results-store.ts — append-only, write-only sidecar for
 * `yg drill` case outcomes. Every drill case appends exactly one JSON line to a
 * local, gitignored file under `.yggdrasil/`, so a maintainer (and later a
 * rule-health analysis) can see, run over run, which regression cases still
 * pass / MISS / FALSE-ALARM.
 *
 * Local telemetry ONLY: nothing in the engine (check / verify / render / fill)
 * reads it back — `yg drill` never touches the lock. A failed append must never
 * affect a drill run's outcome (see the try/catch below), mirroring the
 * verdict-events sidecar's best-effort contract.
 */

import path from 'node:path';
import { appendToDebugLog, ensureGitignoreLine } from './debug-log-writer.js';

/** The drill-results sidecar's filename, relative to the `.yggdrasil/` graph root.
 *  Gitignored — never committed, never read by any check / verify / render path. */
export const DRILL_RESULTS_FILENAME = '.drill-results.jsonl';

/** The gitignore entry the writer self-ensures — the `*` also covers any future
 *  rotation of the file (e.g. `.drill-results.jsonl.1`). */
const DRILL_RESULTS_GITIGNORE_LINE = `${DRILL_RESULTS_FILENAME}*`;

/**
 * One line of the append-only drill-results sidecar. `v` is the line-schema
 * version — a reader must treat an absent `v` as v1.
 */
export interface DrillResultLine {
  /** Line-schema version. Readers treat an absent `v` as v1. */
  v: 1;
  /** ISO 8601 UTC timestamp — from the command's injected clock. */
  ts: string;
  aspect: string;
  /** `<dir>/<relfile>` case label, repo-relative POSIX (extension stripped). */
  case: string;
  /** Expected verdict, decoded from the `violates-`/`satisfies-` dir prefix. */
  expect: 'refused' | 'satisfied';
  /** Observed verdict, or a no-verdict disposition (`unrun` infra / `unsupported` capability gap). */
  got: 'refused' | 'satisfied' | 'unrun' | 'unsupported';
  /** `dev` = in-repo drills/; `holdout` = external --dir corpus. */
  src: 'dev' | 'holdout';
  /** Corpus label — the --corpus value, else `dev` or the --dir basename. */
  corpus: string;
  /** sha256 of the concatenated case file contents. */
  caseHash: string;
  /** sha256 of the rule source (check.mjs | content.md) at run time. */
  ruleHash: string;
  kind: 'deterministic' | 'llm';
  /** LLM only — resolved tier NAME. */
  tier?: string;
  /** LLM only — the consensus vote split for this case. */
  votes?: { satisfied: number; total: number };
}

/**
 * Append one drill-results line. Best-effort and write-only: self-ensures the
 * `.drill-results.jsonl*` line in `.yggdrasil/.gitignore` before the write (G5),
 * then appends one complete JSON line. A failed append loses one line and
 * nothing else — it MUST NEVER throw into the drill run.
 */
export function appendDrillResult(yggRootPath: string, line: DrillResultLine): void {
  try {
    ensureGitignoreLine(yggRootPath, DRILL_RESULTS_GITIGNORE_LINE);
    appendToDebugLog(path.join(yggRootPath, DRILL_RESULTS_FILENAME), JSON.stringify(line) + '\n');
  } catch {
    /* swallowed by contract — telemetry must never affect a drill run */
  }
}
