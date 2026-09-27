/**
 * source/cli/src/core/check-contract.ts — the public data contract of a check
 * run, as the engine names it: one issue, and the whole result the run hands
 * back.
 *
 * Types only, no logic. The shapes themselves are declared in the model layer,
 * so every consumer of a check result (the command layer, the report
 * renderers, the portal extractors, the fill stage) can name them without
 * pulling the orchestrator's own dependencies in behind them.
 *
 * The OPTIONS contract deliberately does NOT live here — it is declared beside
 * `runCheck` itself. The rule that proves every call site supplies runCheck's
 * issue-gating inputs derives that option set from a single parse of the file
 * declaring the function, so interface and function have to stay together or
 * the derivation finds nothing to check call sites against.
 */

// CheckIssue and CheckResult live in the model layer (model/check-issue.ts,
// model/check-result.ts) so modules the orchestrator calls, and the renderers that
// print a result, can name them without depending on it; re-exported for this
// module's callers.
import type { CheckIssue } from '../model/check-issue.js';
import type { CheckResult } from '../model/check-result.js';
export type { CheckIssue, CheckResult };
