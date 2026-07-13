/**
 * source/cli/src/io/events-store.ts — append-only, write-only verdict-events
 * telemetry appender. Every fill appends one JSON line per (aspect, unit)
 * disposition under `.yggdrasil/`, to one of two homes (single-home switch, see
 * appendVerdictEvent): the LOCAL gitignored sidecar `.yg-events.jsonl` (default,
 * and the ONLY home for det/drill/diag events), or the COMMITTED shared stream
 * `yg-events.llm.jsonl` (opt-in; LLM-fill events only, `reason` stripped).
 *
 * Nothing in the engine reads either file back — the sole reader is the
 * quarantined io/events-reader.ts. A failed append must never affect a fill's
 * outcome — see the try/catch below.
 */

import path from 'node:path';
import { appendToDebugLog } from './debug-log-writer.js';

/** The LOCAL events sidecar's filename, relative to the `.yggdrasil/` graph root. Gitignored — never committed. */
export const EVENTS_FILENAME = '.yg-events.jsonl';

/**
 * The COMMITTED shared LLM-fill event stream's filename, relative to the
 * `.yggdrasil/` graph root. Opt-in only (`events: { committed_llm: true }`). NOT
 * gitignored — committed, `merge=union`-merged across branches, carrying ONLY
 * LLM-fill events (`source: 'fill'` + `kind: 'llm'`) with `reason` stripped.
 * Det/drill/diag NEVER land here (the keyless-CI zero-churn invariant).
 */
export const COMMITTED_EVENTS_FILENAME = 'yg-events.llm.jsonl';

/**
 * One line of the append-only verdict-events sidecar. `v` is the line-schema
 * version — a reader must treat an absent `v` as v1 (the field was added
 * after the first lines were ever written; existing consumers must degrade
 * gracefully rather than reject old lines).
 */
export interface VerdictEvent {
  /** Line-schema version. Readers treat an absent `v` as v1. */
  v: 1;
  /** ISO 8601 UTC timestamp — from the fill's injected clock, never Date.now() in core/. */
  ts: string;
  /** Discriminator for the emitting subsystem. 'fill' = yg check --approve (core);
   *  'drill' = yg drill (LLM case runs); 'diag' = yg aspect-test (--repeat / --tier).
   *  NEVER a hash ingredient. Every reader MUST filter by this field before
   *  aggregating — mixing regimes is corruption risk #1. */
  source: 'fill' | 'drill' | 'diag';
  aspectId: string;
  /** POSIX-normalized unit key: 'node:<path>' or 'file:<path>' for verification
   *  units, and 'drill:<aspect>/<case>' for a drill case run (source: 'drill'). */
  unitKey: string;
  kind: 'llm' | 'deterministic';
  disposition: 'approved' | 'refused' | 'infra' | 'companion-runtime-error' | 'runtime-error' | 'malformed-suppress';
  /** inputHash — present on approved/refused only. */
  hash?: string;
  /** Present on REFUSED only (mirrors the lock; approved rationale is deliberately NOT recorded in v1). */
  reason?: string;
  /** LLM only — tier NAME. */
  tier?: string;
  /** LLM only — PROMPT_FORMAT_REV at emission time. */
  promptRev?: number;
  /**
   * LLM verdicts only — the consensus vote split for this pair: how many of the
   * tier's independent review passes were satisfied (`satisfied`) out of the total
   * passes cast (`total`). A single-vote tier (consensus <= 1) records the
   * length-1 case, `total: 1`. Absent on deterministic verdicts and on every
   * no-write disposition.
   */
  votes?: { satisfied: number; total: number };
  /** LLM only — identity of the resolved judge at call time. Tier re-pointing is
   *  deliberately invisible to the lock, so without this field a quarter of
   *  telemetry mixes judge regimes undetectably. Absent ⇒ regime unknown
   *  (all pre-wave-2 lines). NEVER a hash ingredient. */
  judge?: { provider: string; model: string };
}

/** Options threaded from the caller's resolved config (dependency-injected — io
 *  never imports core to read config). */
export interface AppendVerdictEventOptions {
  /** Resolved `events.committed_llm`. When true, an LLM-fill event is routed to
   *  the committed shared stream with `reason` stripped, instead of the local
   *  sidecar (single-home — no double-write). Every other event stays local. */
  committedLlm?: boolean;
}

/**
 * Best-effort, write-only telemetry. MUST NEVER throw into the fill: a failed
 * append loses one event line and nothing else. Single-home switch: when
 * `opts.committedLlm` is set AND this is an LLM-fill event, the line goes to the
 * committed shared stream (`reason` stripped for privacy); everything else goes
 * to the local sidecar.
 */
export function appendVerdictEvent(
  yggRootPath: string,
  event: VerdictEvent,
  opts?: AppendVerdictEventOptions,
): void {
  try {
    if (opts?.committedLlm === true && event.source === 'fill' && event.kind === 'llm') {
      // Privacy: the shared copy never records `reason` (present only on refusals).
      const shared: VerdictEvent = { ...event };
      delete shared.reason;
      appendToDebugLog(path.join(yggRootPath, COMMITTED_EVENTS_FILENAME), JSON.stringify(shared) + '\n');
      return;
    }
    appendToDebugLog(path.join(yggRootPath, EVENTS_FILENAME), JSON.stringify(event) + '\n');
  } catch {
    /* swallowed by contract — telemetry must never affect a fill */
  }
}
