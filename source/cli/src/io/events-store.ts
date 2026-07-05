/**
 * source/cli/src/io/events-store.ts — append-only, write-only verdict-events
 * telemetry sidecar. Every fill (`yg check --approve`) appends one JSON line
 * per (aspect, unit) disposition — approved, refused, or an infra/runtime
 * no-write outcome — to a local, gitignored file under `.yggdrasil/`.
 *
 * This is local telemetry ONLY: nothing in the engine (check/verify/render/
 * fill) ever reads `.yg-events.jsonl` back. It exists to make otherwise
 * invisible fill outcomes (a refused pair, an infra failure that silently
 * blocks a run) observable across runs, motivating future rule-health
 * reporting. A failed append must never affect a fill's outcome — see the
 * try/catch below.
 */

import path from 'node:path';
import { appendToDebugLog } from './debug-log-writer.js';

/** The events sidecar's filename, relative to the `.yggdrasil/` graph root. Gitignored — never committed, never read by any check/verify/render path. */
export const EVENTS_FILENAME = '.yg-events.jsonl';

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
  /** Discriminator for the emitting subsystem; future diagnostic sources use other tokens. */
  source: 'fill';
  aspectId: string;
  /** POSIX-normalized unit key ('node:<path>' or 'file:<path>'). */
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
}

/**
 * Best-effort, write-only telemetry. MUST NEVER throw into the fill: a failed
 * append loses one event line and nothing else. No engine path reads this file.
 */
export function appendVerdictEvent(yggRootPath: string, event: VerdictEvent): void {
  try {
    appendToDebugLog(path.join(yggRootPath, EVENTS_FILENAME), JSON.stringify(event) + '\n');
  } catch {
    /* swallowed by contract — telemetry must never affect a fill */
  }
}
