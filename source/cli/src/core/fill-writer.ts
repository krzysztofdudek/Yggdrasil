/**
 * source/cli/src/core/fill-writer.ts — the fill stage's single verdict-collection
 * chokepoint (spec §7): the serialized lock writer every real verdict passes
 * through, and the write-only telemetry sidecar every disposition is recorded on.
 *
 * Interruption-safety (§7): the lock is mutated in memory and re-serialized
 * through a single serialized promise chain after EACH completed pair, so a
 * killed run keeps every finished pair and the next run resumes. Concentrating
 * that chain in one place is what lets the deterministic loop and the concurrent
 * LLM pool both persist mid-run without racing each other.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition records a telemetry line here and NOTHING else — the prior
 * baseline stays intact and the pair stays unverified.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile, VerdictEntry } from '../model/lock.js';
import type { ExpectedPair } from './pairs.js';
import { writeLock } from '../io/lock-store.js';
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
  /** Queue a re-serialization of the in-memory lock behind every write already
   *  queued. Handed to the closure and GC stages so their own writes join the
   *  same chain. */
  persistLock: () => Promise<void>;
  /** Record ONE pair's real verdict: mutate the in-memory lock, persist, then
   *  emit the telemetry line. The ONLY path that writes verdict content. */
  setEntry: (
    pair: ExpectedPair,
    entry: VerdictEntry,
    tierName?: string,
    votes?: { satisfied: number; total: number },
    judge?: { provider: string; model: string },
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
  /** Await every lock write queued so far — drained before the run reports. */
  drain: () => Promise<void>;
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
}): VerdictWriter {
  const { graph, lock, now, onlyDeterministic, committedLlm, deterministicAspectIds } = params;

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

  // ── Serialized lock writer (interruption-safe, §7). ───────────────────────
  // --only-deterministic writes ONLY the gitignored det file; a full run writes all three.
  const writeScope = onlyDeterministic ? 'deterministic' : 'all';
  let writeChain: Promise<void> = Promise.resolve();
  let lockWrites = 0;
  const persistLock = (): Promise<void> => {
    writeChain = writeChain.then(() => writeLock(graph.rootPath, lock, { scope: writeScope, deterministicAspectIds }));
    return writeChain;
  };
  const setEntry = async (
    pair: ExpectedPair,
    entry: VerdictEntry,
    tierName?: string,
    votes?: { satisfied: number; total: number },
    judge?: { provider: string; model: string },
  ): Promise<void> => {
    // Normalize the storage key to POSIX — the committed lock is shared across
    // platforms, and every read/compare/display of a unitKey already normalizes,
    // so a raw OS-native key (backslashes on Windows) would be stored under a key
    // no normalized lookup could find. A no-op on POSIX.
    (lock.verdicts[pair.aspectId] ??= {})[toPosixPath(pair.unitKey)] = entry;
    lockWrites += 1;
    await persistLock();
    // Verdict-persisted-BEFORE-event: the lock write above is the source of truth
    // and has already resolved; the telemetry event below is a strictly-AFTER
    // side effect on the write-only sidecar (never read back by any engine path).
    emitEvent(pair.aspectId, pair.unitKey, pair.kind, entry.verdict, {
      hash: entry.hash,
      reason: entry.reason,
      tier: tierName,
      votes,
      judge,
    });
  };

  return {
    persistLock,
    setEntry,
    emitEvent,
    drain: () => writeChain,
    get lockWrites() { return lockWrites; },
  };
}
