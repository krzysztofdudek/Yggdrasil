/**
 * source/cli/src/core/fill-shared.ts — small shared types and utilities for the
 * fill stage (spec §7). These are the leaf primitives the per-kind fillers
 * (deterministic, LLM), the worker pool, and the orchestrator all build on; they
 * live here so the cohesive fill modules share them without a circular import.
 */

import type { VerdictEntry } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { AspectResponse } from '../llm/types.js';
import type { ExpectedPair } from './pairs.js';
import type { VerdictEvent } from '../io/events-store.js';
import type { FillEventSink, FillLane } from '../model/fill-event.js';
import { debugWrite } from '../utils/debug-log.js';

/** Outcome of filling one deterministic pair. A real verdict carries an entry to
 *  write; a runtime-error is an infra disposition (no write — spec §3.2) and carries
 *  the structured notice so the orchestrator can collect and group by aspectId before
 *  emitting (one message per aspect instead of one per pair). `code` is the thrown
 *  StructureRunnerError's own code (undefined for a runtime error with no such
 *  instance behind it — a bare `succeeded: false` result, or a taint that survived
 *  the one re-run) — the orchestrator's only way to learn WHICH disposition this was,
 *  for the component-free files core/type-visibility.ts's translator can name. */
export type DetFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry }
  | { kind: 'runtime-error'; messageData: IssueMessage; code?: string }
  // A malformed (reasonless) `yg-suppress` marker in a mapped source file. This is
  // a fault in the marker, NOT in check.mjs, so it is a DISTINCT disposition (no
  // write) that must never be reported as aspect-check-runtime-error / "check.mjs
  // crashed" — the exact mirror of how companion-runtime-error stays distinct.
  | { kind: 'malformed-suppress'; messageData: IssueMessage };

/** Outcome of filling one LLM pair. A real verdict carries an entry to write; an
 *  infra disposition writes NOTHING (spec §3.2) and carries a reason + `callsMade`
 *  (consensus-inclusive). Infra causes:
 *    - reference unreadable (a declared reference file could not be read);
 *    - provider error / unparseable response (the reviewer could not produce a verdict);
 *    - prompt-too-large gate (assembled prompt exceeds the tier limit).
 *  A companion-runtime-error is a distinct disposition for hook-resolution failures
 *  (companion.mjs threw / returned a bad shape / a resolved path is missing / a
 *  resolved path is outside allowed-reads / observations stayed inconsistent across
 *  two runs). It is decided BEFORE the reviewer runs (callsMade: 0), counted
 *  separately, and reported as aspect-companion-runtime-error — the exact mirror of
 *  aspect-check-runtime-error for deterministic pairs.
 *  Both dispositions carry structured `messageData` ({ what, why, next }) so the
 *  failure is self-describing at the point it is produced. The bare `why` stays for
 *  callers that fold it into their own surrounding message. */
export type LlmFillOutcome =
  | {
    kind: 'verdict';
    entry: VerdictEntry;
    callsMade: number;
    votes: AspectResponse[];
    /** The reviewer's reason for an APPROVAL. The lock keeps a reason only on a
     *  refusal; this one travels to the local events line alone, so an approval
     *  can be audited afterwards (what did the reviewer say it looked at?)
     *  without adding a word to the committed lock. Absent on a refusal, whose
     *  reason already rides on `entry.reason`. */
    approvalReason?: string;
  }
  | { kind: 'infra'; why: string; messageData?: IssueMessage; callsMade: number }
  | { kind: 'companion-runtime-error'; why: string; messageData: IssueMessage; callsMade: 0 };

/**
 * Read a file's raw bytes, returning an empty Buffer when the file is missing or
 * unreadable. Used by both the deterministic and LLM fillers to hash subject
 * files from current disk — a deleted subject hashes to the empty-buffer hash,
 * which mirrors the verifier's re-read and keeps producer/verifier in sync.
 */
export async function readBytesOrEmpty(absPath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(absPath);
  } catch (e) {
    debugWrite(`[fill] readBytesOrEmpty failed for ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return Buffer.alloc(0);
  }
}

// ============================================================
// Contracts the orchestrator hands to the fill phases
// ============================================================
// Declared here, beside the other shared fill primitives, so the per-kind phases
// (fill-det-phase, fill-llm-phase) name what they are handed without depending on the
// orchestrator's own modules (fill-writer, fill-report, fill-progress), which call them.

/** One infrastructure diagnostic collected during a fill phase, grouped by aspect before it is emitted. */
export interface InfraDiagnosticItem {
  aspectId: string;
  unitKey: string;
  messageData: IssueMessage;
}

/** The progress display's per-pair callbacks, implemented by fill-progress.ts's ProgressTracker. */
export interface PairProgress {
  /** Called just before a pair starts filling. */
  onPairStart(kind: FillLane, aspectId: string, unitKey: string, emit: FillEventSink): void;
  /** Called after a pair completes; `votes` is a consensus review's split (verdict votes only). */
  onPairComplete(
    kind: FillLane,
    aspectId: string,
    unitKey: string,
    verdict: string,
    emit: FillEventSink,
    votes?: { satisfied: number; total: number },
  ): void;
}

/** Extra, disposition-specific fields recorded on one verdict-events line. */
export interface VerdictEventExtra {
  hash?: string;
  reason?: string;
  tier?: string;
  votes?: { satisfied: number; total: number };
  judge?: { provider: string; model: string };
}

export interface VerdictWriter {
  /** Write out the in-memory lock as it stands now (every partition, since the
   *  caller mutated it directly) and resolve once that state is on disk. Handed
   *  to the closure and GC stages so their own writes join the same writer.
   *  Rejects with a LockEnvironmentError when the write fails. */
  persistLock: () => Promise<void>;
  /** Record ONE pair's real verdict: mutate the in-memory lock and mark it
   *  unwritten; its telemetry line is emitted after the flush that carries it.
   *  An LLM verdict resolves once it is on disk (or its flush failed — it then
   *  rides the next one); a deterministic verdict resolves at once unless a full
   *  batch is waiting. Never rejects. The ONLY path that writes verdict content. */
  setEntry: (
    pair: ExpectedPair,
    entry: VerdictEntry,
    tierName?: string,
    votes?: { satisfied: number; total: number },
    judge?: { provider: string; model: string },
    /** An approval's reason, for the local events line only (never the lock). */
    approvalReason?: string,
  ) => Promise<void>;
  /** Append one (aspect, unit) disposition line to the telemetry sidecar —
   *  used directly for the no-write dispositions; `setEntry` calls it itself
   *  for a real verdict. */
  emitEvent: (
    aspectId: string,
    unitKey: string,
    kind: 'llm' | 'deterministic',
    disposition: VerdictEvent['disposition'],
    extra?: VerdictEventExtra,
  ) => void;
  /** Flush every unwritten verdict — drained before the run reports. Throws a
   *  LockEnvironmentError when the final flush still fails. */
  drain: () => Promise<void>;
  /** Best-effort final flush and teardown on any exit from the run, including
   *  an error. Never throws. */
  close: () => Promise<void>;
  /** Count of verdict-content writes performed this run (one per setEntry).
   *  Read ONLY by the convergence sentinel at the report boundary — GC's
   *  canonical re-serialization and closure's fingerprint writes are
   *  deliberately NOT counted, since only a real verdict write would
   *  legitimately explain a change in the unverified set between the pre-fill
   *  and post-fill classifications. */
  readonly lockWrites: number;
}
