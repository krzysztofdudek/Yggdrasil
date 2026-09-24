/**
 * source/cli/src/core/fill-writer.ts — the fill stage's single verdict-collection
 * chokepoint (spec §7): the serialized lock writer every real verdict passes
 * through, and the write-only telemetry sidecar every disposition is recorded on.
 *
 * Interruption-safety (§7): the lock is mutated in memory and written out in
 * coalesced flushes — at most one write in flight, each one picking up the
 * latest state — so a killed run keeps every verdict flushed before it died and
 * the next run resumes the rest. What a kill can cost is bounded, see
 * FLUSH_EVERY_DET_VERDICTS and FLUSH_INTERVAL_MS below: a paid (LLM) verdict is
 * flushed at once and its pool slot waits for that flush; a free deterministic
 * one waits for the next batch. Rewriting the whole lock once per verdict made
 * a fill cost pairs × lock size in serialization and disk traffic; a batch
 * costs one write per partition that changed. Concentrating the writes in one
 * place is what lets the deterministic loop and the concurrent LLM pool both
 * persist mid-run without racing each other.
 *
 * A failed flush poisons nothing: its verdicts stay in memory, marked unwritten,
 * and the next flush carries them again. Only a failure that outlasts the run —
 * the final flush in `drain` still failing — surfaces, as an environment error
 * that names how many verdicts were not saved.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition records a telemetry line here and NOTHING else — the prior
 * baseline stays intact and the pair stays unverified.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile, VerdictEntry } from '../model/lock.js';
import type { ExpectedPair } from './pairs.js';
import { acquireApproveLock, LockEnvironmentError, onInterruptFlushLock, writeLock, writeLockSync } from '../io/lock-store.js';
import { debugWrite } from '../utils/debug-log.js';
import { appendVerdictEvent, type VerdictEvent } from '../io/events-store.js';
import { PROMPT_FORMAT_REV } from '../llm/prompt.js';
import { toPosixPath } from '../utils/posix.js';

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

/**
 * Build this run's verdict writer over `lock` (mutated in place).
 *
 * `now` is the SAME injected clock the rest of the fill uses (never Date.now()
 * directly — engine files must not touch runtime state directly, see
 * no-nondeterminism-direct); the `Date` constructor called WITH an argument is
 * deterministic (it only formats a value someone else produced), so the event
 * timestamp below does not trip that rule.
 *
 * `onlyDeterministic` is this run's scope: it narrows the write to the
 * gitignored deterministic file (a full run writes all three), and it is part
 * of the fill's identity this writer is built for — under it no LLM pair is
 * dispatched at all, so no LLM disposition is ever recorded here.
 *
 * `committedLlm` is the resolved committed-events opt-in (RZ-14), passed via
 * the injected-config pattern (io never reads core config). When ON, the
 * appender routes an LLM-fill event to the COMMITTED shared stream (reason
 * stripped) instead of the local sidecar; deterministic events stay local.
 * Never folds into any verdict hash.
 */
export function createVerdictWriter(params: {
  graph: Graph;
  lock: LockFile;
  now: () => number;
  onlyDeterministic: boolean;
  committedLlm: boolean;
  deterministicAspectIds: Set<string>;
  /** Commit this run's fill executes at (`git rev-parse HEAD`), resolved by the
   *  CLI boundary before entering fill — core never calls git. Stamped onto
   *  every verdict this writer records (VerdictEntry.filledSha) and onto its
   *  telemetry line (VerdictEvent.sha), except on a deterministic entry, which
   *  records neither. Absent when unresolvable (no repository, no commit yet,
   *  git missing from PATH); never fabricated, never a hash ingredient. */
  sha?: string;
  /** The run's approval lock, which closes this writer before letting go. */
  exclusion?: FillExclusion;
  /**
   * Called synchronously when SIGINT/SIGTERM interrupts the run, AFTER the
   * in-memory verdicts have been put on disk, with how many verdicts this run
   * wrote (all of them now saved) and whether that final write succeeded — so
   * the run can say "K of N saved" before the signal takes the process down.
   */
  onInterrupted?: (saved: number, flushed: boolean) => void;
}): VerdictWriter {
  const { graph, lock, now, onlyDeterministic, committedLlm, deterministicAspectIds, sha, exclusion, onInterrupted } = params;

  // ── Verdict-events telemetry sidecar (write-only; nothing in the engine ever
  // reads it back). One line per (aspect, unit) disposition — a real verdict
  // (approved/refused) or a no-write infra/runtime outcome — appended to a local,
  // gitignored file under .yggdrasil/.
  const emitEvent = (
    aspectId: string,
    unitKey: string,
    kind: 'llm' | 'deterministic',
    disposition: VerdictEvent['disposition'],
    extra?: VerdictEventExtra,
  ): void => {
    const event: VerdictEvent = {
      v: 1,
      ts: new Date(now()).toISOString(),
      source: 'fill',
      aspectId,
      unitKey: toPosixPath(unitKey),
      kind,
      disposition,
    };
    if (sha !== undefined) event.sha = sha;
    if (extra?.hash !== undefined) event.hash = extra.hash;
    if (extra?.reason !== undefined) event.reason = extra.reason;
    if (extra?.tier !== undefined) {
      event.tier = extra.tier;
      event.promptRev = PROMPT_FORMAT_REV;
    }
    if (extra?.votes !== undefined) event.votes = extra.votes;
    // LLM only — the resolved judge identity, recorded wherever a tier resolved
    // (verdict site + LLM infra sites). Absent on deterministic lines and on the
    // no-reviewer / tier-unresolvable site (no judge ever resolved there).
    if (extra?.judge !== undefined) event.judge = extra.judge;
    // Single-home switch (RZ-14): see this factory's own doc for what the
    // committed-events opt-in reroutes.
    appendVerdictEvent(graph.rootPath, event, { committedLlm });
  };

  // ── Coalescing lock writer (interruption-safe, §7). ───────────────────────
  // --only-deterministic writes ONLY the gitignored det file; a full run writes all three.
  const writeScope = onlyDeterministic ? 'deterministic' : 'all';
  let lockWrites = 0;
  // `gen` counts mutations; `persistedGen` is the newest mutation known on disk.
  let gen = 0;
  let persistedGen = 0;
  // Partitions changed since the last flush that started.
  let dirty = { nondet: false, logs: false, det: false };
  // Verdict telemetry lines waiting for the flush that carries their verdict.
  let pending: Array<() => void> = [];
  let inFlight: Promise<boolean> | null = null;
  let lastError: unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const anyDirty = (): boolean => dirty.nondet || dirty.logs || dirty.det;

  const runFlush = (): Promise<boolean> => {
    const target = gen;
    const parts = dirty;
    dirty = { nondet: false, logs: false, det: false };
    const batch = pending;
    pending = [];
    const flight = (async (): Promise<boolean> => {
      try {
        await writeLock(graph.rootPath, lock, { scope: writeScope, deterministicAspectIds, partitions: parts });
      } catch (e) {
        // Nothing is lost yet: the verdicts are still in memory. Put the marks
        // back so the next flush carries them, and remember why this one failed.
        dirty = { nondet: dirty.nondet || parts.nondet, logs: dirty.logs || parts.logs, det: dirty.det || parts.det };
        pending = batch.concat(pending);
        lastError = e;
        debugWrite(`[fill] lock flush failed, will retry with the next one: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      persistedGen = Math.max(persistedGen, target);
      lastError = undefined;
      // Verdict-persisted-BEFORE-event: each line below describes a verdict the
      // write above has already put on disk.
      for (const emit of batch) emit();
      return true;
    })();
    inFlight = flight;
    void flight.then(() => {
      inFlight = null;
      scheduleFlush();
    });
    return flight;
  };

  // Start a flush when a full batch is waiting; otherwise make sure one runs
  // within FLUSH_INTERVAL_MS so a slow trickle of verdicts is not held back.
  // After a failed flush the next attempt waits for the timer, so a disk that
  // keeps refusing is retried once per interval, never in a tight loop.
  const scheduleFlush = (): void => {
    if (inFlight || !anyDirty()) return;
    if (pending.length >= FLUSH_EVERY_DET_VERDICTS && lastError === undefined) {
      void runFlush();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!inFlight && anyDirty()) void runFlush();
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  // Resolve true once every mutation up to `target` is on disk, false when a
  // flush started after this call failed. At most one extra attempt per call.
  const persistUpTo = async (target: number): Promise<boolean> => {
    let attempted = false;
    for (;;) {
      if (persistedGen >= target) return true;
      if (inFlight) {
        await inFlight;
        continue;
      }
      if (attempted) return false;
      attempted = true;
      await runFlush();
    }
  };

  const writeFailure = (unsaved: number): LockEnvironmentError => {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    return new LockEnvironmentError('lock-write-failed', {
      what: `The verdict lock could not be written: ${detail}${unsaved > 0 ? ` — ${unsaved} verdict(s) from this run were not saved.` : ''}`,
      why: 'The file system refused the write even after retrying — a permission on .yggdrasil/, a full disk, or a lock file held open by another program. This is a problem in the environment, not in the code or the lock\'s content; every verdict written before the failure is kept.',
      next: 'Fix the cause above (check write permission on .yggdrasil/ and free disk space), then re-run: yg check --approve — the verdicts that were not saved are filled again.',
    });
  };

  const persistLock = async (): Promise<void> => {
    gen += 1;
    dirty = { nondet: true, logs: true, det: true };
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!(await persistUpTo(gen))) throw writeFailure(pending.length);
  };

  const setEntry = async (
    pair: ExpectedPair,
    entry: VerdictEntry,
    tierName?: string,
    votes?: { satisfied: number; total: number },
    judge?: { provider: string; model: string },
    approvalReason?: string,
  ): Promise<void> => {
    // WHEN this verdict was filled, and at which commit — so a consumer above
    // the agent can attribute reviewer cost to the branch that caused it.
    // Never on a deterministic entry: filling one costs nothing, so there is
    // nothing to attribute (see CheckJsonPair.filled / VerifiedPair.filled).
    if (pair.kind !== 'deterministic') {
      entry.filledAt = new Date(now()).toISOString();
      if (sha !== undefined) entry.filledSha = sha;
    }
    // Normalize the storage key to POSIX — the committed lock is shared across
    // platforms, and every read/compare/display of a unitKey already normalizes,
    // so a raw OS-native key (backslashes on Windows) would be stored under a key
    // no normalized lookup could find. A no-op on POSIX.
    (lock.verdicts[pair.aspectId] ??= {})[toPosixPath(pair.unitKey)] = entry;
    lockWrites += 1;
    gen += 1;
    if (deterministicAspectIds.has(pair.aspectId)) dirty.det = true;
    else dirty.nondet = true;
    // The telemetry line waits for the flush that carries this verdict.
    pending.push(() => emitEvent(pair.aspectId, pair.unitKey, pair.kind, entry.verdict, {
      hash: entry.hash,
      // A refusal's reason is the lock's own; an approval's reason exists only
      // here, on the local line (the committed stream strips every reason).
      reason: entry.reason ?? approvalReason,
      tier: tierName,
      votes,
      judge,
    }));
    if (pair.kind !== 'deterministic') {
      // A paid verdict: flush now and hold the pool slot until it is on disk,
      // so a kill loses at most the verdicts of the flush in flight. A failed
      // flush does not fail the pair — the verdict stays unwritten in memory
      // and rides the next flush (or surfaces from drain).
      if (timer !== null) { clearTimeout(timer); timer = null; }
      await persistUpTo(gen);
      return;
    }
    if (pending.length >= FLUSH_EVERY_DET_VERDICTS && lastError === undefined) {
      // Back-pressure: a full batch is flushed before the next verdict is
      // produced, which is what bounds what a kill can lose.
      await persistUpTo(gen);
      return;
    }
    scheduleFlush();
  };

  // SIGINT/SIGTERM: put the in-memory state on disk synchronously before the
  // signal takes the process down, so an interrupt loses nothing already decided.
  const flushOnInterrupt = (): void => {
    let flushed = true;
    if (anyDirty() || pending.length > 0) {
      try {
        writeLockSync(graph.rootPath, lock, { scope: writeScope, deterministicAspectIds });
        for (const emit of pending.splice(0)) emit();
      } catch (e) {
        flushed = false;
        debugWrite(`[fill] final lock write on interrupt failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    onInterrupted?.(lockWrites, flushed);
  };
  const disposeInterrupt = onInterruptFlushLock(flushOnInterrupt);
  let closed = false;

  const drain = async (): Promise<void> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!(await persistUpTo(gen))) throw writeFailure(pending.length);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!(await persistUpTo(gen))) {
        debugWrite(`[fill] final lock flush failed on close; ${pending.length} verdict(s) not saved`);
      }
    } catch (e) {
      debugWrite(`[fill] final lock flush threw on close: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      disposeInterrupt();
    }
  };

  const writer: VerdictWriter = {
    persistLock,
    setEntry,
    emitEvent,
    drain,
    close,
    get lockWrites() { return lockWrites; },
  };
  exclusion?.bind(writer);
  return writer;
}

/**
 * How many deterministic verdicts may wait in memory before the next one waits
 * for a flush. With FLUSH_INTERVAL_MS this bounds what a SIGKILL can cost: the
 * batch being written plus the one being gathered — at most about twice this
 * many free verdicts (plus the handful a parallel wave has in progress), and
 * never more than about two intervals' worth — each re-filled at no cost by
 * the next run. A paid (LLM) verdict never waits for a batch: at most the paid
 * verdicts whose write is in flight can be lost.
 */
export const FLUSH_EVERY_DET_VERDICTS = 256;

/** The longest an unwritten verdict waits for its flush when no batch fills up. */
export const FLUSH_INTERVAL_MS = 1000;

/** One run's hold on the repository: the approval lock, plus the writer that
 *  must be closed before the lock is let go. */
export interface FillExclusion {
  bind: (writer: VerdictWriter) => void;
  release: () => Promise<void>;
}

/**
 * Take the repository's approval lock for one fill (see acquireApproveLock):
 * a second approval fails fast with an environment error instead of silently
 * overwriting this one's verdicts. `release` closes the bound writer first —
 * a final best-effort flush on every exit path, including an error — and only
 * then lets the lock go.
 */
export function acquireFillExclusion(yggRootPath: string, nowMs: number): FillExclusion {
  const releaseLock = acquireApproveLock(yggRootPath, nowMs);
  let writer: VerdictWriter | undefined;
  return {
    bind: (w) => { writer = w; },
    release: async () => {
      try {
        if (writer) await writer.close();
      } finally {
        releaseLock();
      }
    },
  };
}
