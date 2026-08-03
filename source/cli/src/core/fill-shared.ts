/**
 * source/cli/src/core/fill-shared.ts — small shared types and utilities for the
 * fill stage (spec §7). These are the leaf primitives the per-kind fillers
 * (deterministic, LLM), the worker pool, and the orchestrator all build on; they
 * live here so the cohesive fill modules share them without a circular import.
 */

import type { VerdictEntry } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { AspectResponse } from '../llm/types.js';
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
  | { kind: 'verdict'; entry: VerdictEntry; callsMade: number; votes: AspectResponse[] }
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
