// ============================================================
// Fill events — what the fill stage reports while it runs, as data
// ============================================================
//
// The fill stage (`yg check --approve`) used to write finished sentences into a
// text sink. It now reports each thing it has to say as one of these events,
// and whoever runs it decides how each one reads: the command layer renders
// them to stderr through the fill-text formatter, a test can assert on the data
// itself. The words live in one place and the engine owns none of them.

import type { IssueMessage } from './validation.js';

/** Which kind of rule a pair is judged by: a local script, or the reviewer. */
export type FillLane = 'det' | 'llm';

/** What the run is about to fill, counted before anything is dispatched. */
export interface FillDispatchCounts {
  fillPairs: number;
  /** Distinct components among the pairs (a nodeless pair is not one). */
  nodeCount: number;
  /** Distinct type-covered files among the pairs. */
  fileCount: number;
  detPairs: number;
  reviewerCallBudget: number;
  /** Reviewer pairs left alone because the run is script-rules-only. */
  skippedLlmPairs: number;
  /** Reviewer pairs left alone because the change is not accountable for them. */
  skippedOutsideLlmPairs: number;
  /** False when yg-config.yaml has no reviewer section at all. */
  reviewerConfigured?: boolean;
  /** True for a cost preview (`--dry-run`), which fills nothing. */
  preview?: boolean;
}

/** One pair a cost preview prices. `unit` is the POSIX unit key, or the file for a nodeless pair. */
export interface DryRunPair {
  lane: FillLane;
  aspectId: string;
  unit: string;
  /** Reviewer calls this pair would cost (reviewer pairs only). */
  reviewerCalls?: number;
}

/** One verdict the garbage collector removed (or would remove, in a preview). */
export interface PrunedEntry {
  aspectId: string;
  unitKey: string;
  kind: 'llm' | 'deterministic' | 'unknown';
  reason: string;
}

/** What a finished fill did, for its closing line. */
export interface FillOutcomeTotals {
  reviewerCallsMade: number;
  infraFailures: number;
  runtimeErrors: number;
  companionRuntimeErrors: number;
  malformedSuppressErrors: number;
  skippedLlmPairs: number;
  skippedOutsideLlmPairs: number;
  detApproved: number;
  detRefused: number;
  skippedByDetGate: number;
  reviewerConfigured?: boolean;
  /** Refusals already recorded for unchanged code, which this run left standing. */
  cachedRefusals?: number;
  /** Wall time of the run from its start to its closing line, in milliseconds. */
  elapsedMs?: number;
  /** What the reviewer calls consumed, summed over the calls whose provider
   *  reported it (`reportedCalls` of `reviewerCallsMade`). Absent when no call
   *  reported anything. */
  usage?: FillUsageTotals;
  /** How every pair the run finished ended: approved, refused, or not judged (infra). */
  outcomes?: FillProgressCounts;
}

/** Summed reviewer usage for a run — see FillOutcomeTotals.usage. */
export interface FillUsageTotals {
  reportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Absent when no call reported a cost. */
  costUsd?: number;
}

/** Running tallies the progress events carry. */
export interface FillProgressCounts {
  completed: number;
  total: number;
  approved: number;
  refused: number;
  infra: number;
}

export type FillEvent =
  /** The pre-dispatch header: what will be filled and what it costs. */
  | { type: 'dispatch'; counts: FillDispatchCounts }
  /** Judgment pairs counted in the header that no configured reviewer can judge. */
  | { type: 'no-reviewer'; message: IssueMessage }
  /** A cost preview's per-subject breakdown. */
  | { type: 'dry-run'; nodes: Array<{ nodePath: string; pairs: DryRunPair[] }>; files: DryRunPair[]; reviewerCallBudget: number; /** False when no reviewer is configured, so a real fill could record the script pairs only. */ reviewerConfigured?: boolean }
  /** Verdicts the garbage collector removed. */
  | { type: 'prune'; entries: PrunedEntry[]; billedCount: number; freeCount: number; unknownCount: number }
  /** A rule's standing moved since the last run, and the move was written into its log. */
  | { type: 'rule-status'; aspectId: string; from: string; to: string }
  /** A pair finished with something other than an approval (refused, infra), or
   *  was approved by a consensus that split. `votes` is the consensus split —
   *  verdict votes only — present whenever the tier cast more than one. */
  | { type: 'pair-outcome'; lane: FillLane; aspectId: string; unitKey: string; verdict: string; votes?: { satisfied: number; total: number } }
  /** A periodic tally line (non-interactive sinks). */
  | { type: 'milestone'; counts: FillProgressCounts }
  /** Nothing finished for a while (non-interactive sinks). */
  | { type: 'still-working'; completed: number; total: number; currentPair: string }
  /** The single in-place status line (interactive sinks). `columns` is the width it must fit. */
  | { type: 'status'; counts: FillProgressCounts; elapsedSeconds: number; currentPair: string; columns: number }
  /** Clear the in-place status line (interactive sinks). */
  | { type: 'clear-line' }
  /** The closing line: what the run did. */
  | { type: 'totals'; totals: FillOutcomeTotals }
  /**
   * SIGINT/SIGTERM stopped the run. `saved` verdicts this run wrote are on disk
   * (`flushed` false when that last write failed); the other pairs of `total`
   * stay unverified and the next run resumes with only them. In-flight
   * reviewer calls were stopped with the run.
   */
  | { type: 'interrupted'; saved: number; total: number; flushed: boolean; message: IssueMessage };

/** Where fill events go. */
export type FillEventSink = (event: FillEvent) => void;
