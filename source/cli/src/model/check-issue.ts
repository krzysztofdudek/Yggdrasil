/**
 * One issue of a check run, and why a pair is unverified. Pure types, in the model
 * layer so every module that builds or reads an issue (the orchestrator, the modules
 * it calls, the renderers) can name them without a dependency back on the
 * orchestrator. core/check-contract.ts and core/check-codes.ts re-export them.
 */
import type { ValidationIssue } from './validation.js';

/**
 * Why a pair has no valid verdict. One `unverified` code used to cover every
 * one of these, under one label and one fix — so a reviewer that was down, a
 * check.mjs that crashed, a fresh clone whose free local cache was simply never
 * built, and a pair nobody had reviewed yet all told the reader the same thing:
 * run `yg check --approve` again. For the first two that command is certain to
 * reproduce the same failure, and for the third it names a paid run where a
 * free one does the job. The cause travels on the issue (and into the
 * `yg-check/1` document) so each group can name the fix that actually works.
 *
 * The first five are infrastructure: the pair was never judged because
 * something around it failed, and re-running changes nothing until that is
 * fixed. `reviewer-missing` is known from the config alone; the other four are
 * facts only a recording run witnesses, so they appear on that run's own
 * report. The last four are the ordinary states of a pair waiting for a fill;
 * `keyed-by-earlier-release` is a script verdict whose inputs did not move but
 * which an earlier release (or an earlier parser grammar) keyed differently, so
 * an upgrade re-opens it once — free to re-record.
 */
export type UnverifiedCause =
  | 'reviewer-missing'
  | 'reviewer-unreachable'
  | 'reviewer-failed'
  | 'check-failed-to-run'
  | 'suppress-marker-invalid'
  | 'stale'
  | 'keyed-by-earlier-release'
  | 'never-reviewed'
  | 'deterministic-not-run';

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
  /**
   * For an `unverified` reviewer pair (and its outside twin): how many reviewer
   * calls filling it costs — its tier's consensus, or 1 when no tier resolves,
   * the same count a fill's cost preview budgets for it. Absent on a script
   * pair (free) and on every other issue.
   */
  reviewerCalls?: number;
  /**
   * For `unverified` (and its outside twin): WHY the pair has no valid verdict
   * — see {@link UnverifiedCause}. Decides the group it renders in, its label,
   * and the fix it names; carried into the `yg-check/1` document as `cause`.
   */
  unverifiedCause?: UnverifiedCause;
  // `aspectId` / `unitKey` / `flowName` / `relationEdges` are inherited from
  // `ValidationIssue` (model/validation.ts) — every non-pair emit site that
  // stamps them (ambiguous-node-type, type-relation-forbidden,
  // description-missing's aspect/flow cases, tracked-file-gitignored,
  // type-strict-orphan, strict-overlap-conflict) produces a plain
  // `ValidationIssue`, not a `CheckIssue`, so the fields have to live on the
  // shared base to type-check there. See that interface for the full doc.
}
