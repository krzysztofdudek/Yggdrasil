/**
 * source/cli/src/core/check-contract.ts — the public data contract of a check
 * run: one issue, and the whole result the run hands back.
 *
 * Types only, no logic, so every consumer of a check result (the command layer,
 * the portal extractors, the fill stage) can name these shapes without pulling
 * the orchestrator's own dependencies in behind them.
 *
 * The OPTIONS contract deliberately does NOT live here — it is declared beside
 * `runCheck` itself. The rule that proves every call site supplies runCheck's
 * issue-gating inputs derives that option set from a single parse of the file
 * declaring the function, so interface and function have to stay together or
 * the derivation finds nothing to check call sites against.
 */

import type { ValidationIssue } from '../model/validation.js';
import type { TypeVisibilityReport } from './type-visibility.js';

export interface CheckIssue extends Omit<ValidationIssue, 'code'> {
  /** All issues have a code -- override optional from ValidationIssue */
  code: string;
  /** For unmapped-files: uncovered file paths */
  uncoveredFiles?: string[];
  /** For unmapped-files: total count of uncovered files */
  uncoveredCount?: number;
  /**
   * For pair-derived issues (unverified / refused): the reviewer kind of the
   * pair. Lets the CLI's `--summary` view split per-node counts into
   * deterministic-free vs LLM without re-resolving the pair. Data-only — set
   * from `pair.kind`; absent on non-pair issues (coverage / log / relation /
   * structural), which the summary buckets as "other".
   */
  pairKind?: 'llm' | 'deterministic';
  // `aspectId` / `unitKey` / `flowName` / `relationEdges` are inherited from
  // `ValidationIssue` (model/validation.ts) — every non-pair emit site that
  // stamps them (ambiguous-node-type, type-relation-forbidden,
  // description-missing's aspect/flow cases, tracked-file-gitignored,
  // type-strict-orphan, strict-overlap-conflict) produces a plain
  // `ValidationIssue`, not a `CheckIssue`, so the fields have to live on the
  // shared base to type-check there. See that interface for the full doc.
}

export interface CheckResult {
  projectName: string;
  nodeCount: number;
  nodeTypeCounts: Map<string, number>;
  aspectCount: number;
  flowCount: number;
  coveredFiles: number;
  totalFiles: number;
  issues: CheckIssue[];
  /** Suggested next command based on highest-priority error */
  suggestedNext: string | null;
  /** Count of aspect-violation-advisory warnings (subset of issues). Surfaced as a footer tally. */
  advisoryWarnings: number;
  /** Count of (node, aspect) pairs where the aspect resolves to effective status 'draft'. */
  draftSkipped: number;
  /**
   * Count of VERIFIED pairs whose reviewer kind is deterministic. Tallied from
   * the same loop that emits per-pair issues (`emitPairIssue` emits nothing for
   * a verified pair, the only place this datum exists). Read-side only — not a
   * hash ingredient (`core/pair-hash.ts` is untouched).
   */
  verifiedDet: number;
  /** Count of VERIFIED LLM pairs. See `verifiedDet`. */
  verifiedLlm: number;
  /**
   * Whether `coverage.type_level` was on this run — gates the header's
   * node-owned/type-covered split and the zero-classifying-types notice.
   * Optional so every pre-existing `CheckResult` literal renders unchanged.
   */
  typeLevel?: boolean;
  /**
   * Files silently satisfied by the type-level lattice (matched by exactly one
   * classifying type's `when`, no node, no issue). 0 when the flag is off or
   * the coverage scan did not run.
   */
  typeCoveredCount?: number;
  /**
   * Count of architecture types declaring `when:` — a pure architecture fact,
   * computed regardless of the flag. `typeLevel` on with this at 0 means the
   * lattice can never match a file — the standing notice's trigger.
   */
  classifyingTypeCount?: number;
  /**
   * Files actually owned by a node mapping (`totalFiles` minus uncovered).
   * Distinct from `coveredFiles` (also folds in `coverage.excluded` files,
   * kept for the flag-off header / `portal/extract.ts`) so the flag-on
   * header's "node-owned" term never claims a file no node maps.
   */
  nodeOwnedFiles?: number;
  /**
   * Uncovered files under a `coverage.excluded` root — the ones
   * `partitionByCoverageTier` drops silently. `coveredFiles ===
   * nodeOwnedFiles + excludedFiles` always holds; its own field (not derived
   * at render time) so a rendering bug can never go negative/inconsistent.
   */
  excludedFiles?: number;
  /** Per-file type-tier enforcement report. Undefined at flag-off. */
  typeVisibility?: TypeVisibilityReport;
  /**
   * How many issues fell OUTSIDE the change scope this run was given. Undefined
   * whenever no scope was supplied — which is every run today, since nothing
   * populates these three yet. They are declared here so the shape a later
   * report renders from is fixed before anything writes it.
   */
  outsideCount?: number;
  /** The plain name the change was measured against, for the report to quote. */
  progressiveReference?: string;
  /** How many changed paths that measurement actually accounted for. */
  changedInputCount?: number;
}
