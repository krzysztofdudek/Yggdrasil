/**
 * source/cli/src/io/events-reader.ts — the FIRST and ONLY reader of the
 * append-only verdict-events telemetry sidecar written by io/events-store.ts.
 *
 * This module is deliberately quarantined from the engine: it reads local,
 * gitignored telemetry ONLY, and nothing in a check/verify/render/fill path may
 * import it (enforced by the `events-reader-boundary` dogfood aspect). It exists
 * so a presentation command (yg log read --with-verdicts, and later aspects/
 * advise) can surface otherwise-invisible fill outcomes back to the operator.
 *
 * Read tolerance (fail-open — telemetry, never a hard failure):
 *   - an ABSENT `v` field means v1 (the field was added after the first lines
 *     were ever written);
 *   - an unknown `v`, an unknown unitKey prefix, or a non-JSON line is COUNTED
 *     (`skipped`) and dropped, never thrown;
 *   - a missing sidecar yields an empty result, no throw;
 *   - ANY unexpected error degrades to an empty / partial result rather than
 *     propagating — a reader crash must never break a log-read command.
 *
 * The rotated `.1` sidecar (if present) is read BEFORE the current file so the
 * merged event stream stays in chronological (append) order.
 *
 * Union reader: the returned set is union(local, local `.1`, committed) deduped
 * by FULL line. The committed shared stream (`yg-events.llm.jsonl`) carries only
 * LLM-fill events; older CLIs write ONLY the local sidecar, so they do not
 * contribute. Full-line dedupe collapses the byte-identical duplicates a git
 * `merge=union` can leave on the committed stream.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_FILENAME, COMMITTED_EVENTS_FILENAME, type VerdictEvent } from './events-store.js';

/** Verbatim honesty label for the committed contribution — older CLIs write only
 *  the local sidecar, so the shared record is never assumed complete. */
export const COMMITTED_STREAM_NOTE = 'machines on older CLIs do not contribute';

/** Result of reading the verdict-events telemetry (local union committed). */
export interface EventsReadResult {
  /** Parsed events, deduped by full line — local rotated `.1`, local current, then committed. */
  events: VerdictEvent[];
  /** Count of dropped lines: unknown `v`, unknown unitKey prefix, or non-JSON. */
  skipped: number;
  /** True when the LOCAL sidecar is git-tracked — the caller must then refuse the "local" label. */
  gitTracked: boolean;
  /** Earliest `ts` observed across accepted events (undefined when none). */
  firstTs?: string;
  /** Count of accepted events sourced from the committed shared stream. 0 when that file is absent/empty. */
  committedCount: number;
  /** Verbatim honesty label ({@link COMMITTED_STREAM_NOTE}) — present only when committedCount > 0. */
  committedNote?: string;
}

/** Unit-key prefixes a v1 line may carry; any other prefix is an unknown future shape. */
const KNOWN_UNIT_PREFIXES = ['node:', 'file:'];

/** Read a UTF-8 file, degrading a missing file (or any read error) to undefined. */
function readSidecarSafe(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    // Missing sidecar (ENOENT) or any other read error → treat as absent.
    return undefined;
  }
}

/**
 * True when `filePath` is tracked by git. Resolved from the exit code of
 * `git ls-files --error-unmatch <path>` (non-zero ⇒ untracked). ALL errors —
 * a non-zero exit, git absent from PATH, no repository — collapse to false: an
 * unknowable tracking state must never be reported as "tracked".
 */
function isGitTracked(filePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], {
      cwd: path.dirname(filePath),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Type guard: a parsed JSON value that is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the verdict-events telemetry sidecar under `yggRootPath` (the `.yggdrasil/`
 * graph root). Never throws — see the module header for the tolerance contract.
 */
export function readVerdictEvents(yggRootPath: string): EventsReadResult {
  const currentPath = path.join(yggRootPath, EVENTS_FILENAME);
  // Rotation: the previous generation `<sidecar>.1` is read first so the merged
  // stream stays in append order; the opt-in committed stream is read last.
  const rotatedPath = `${currentPath}.1`;
  const committedPath = path.join(yggRootPath, COMMITTED_EVENTS_FILENAME);

  const events: VerdictEvent[] = [];
  let skipped = 0;
  let firstTs: string | undefined;
  let committedCount = 0;

  // Full-line dedupe across the union: a git `merge=union` can leave byte-identical
  // duplicate lines. A byte-identical line is the SAME event, accepted once (a
  // duplicate is NOT counted as a skip — it is not malformed).
  const seenLines = new Set<string>();

  const sources: Array<{ filePath: string; committed: boolean }> = [
    { filePath: rotatedPath, committed: false },
    { filePath: currentPath, committed: false },
    { filePath: committedPath, committed: true },
  ];

  for (const { filePath, committed } of sources) {
    const content = readSidecarSafe(filePath);
    if (content === undefined) continue;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      if (seenLines.has(line)) continue; // full-line dedupe (union-merge duplicates, cross-source repeats)
      seenLines.add(line);

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }

      if (!isPlainObject(parsed)) {
        skipped += 1;
        continue;
      }

      // Absent `v` ≙ v1; any other version is an unknown future shape.
      const v = parsed.v;
      if (v !== undefined && v !== 1) {
        skipped += 1;
        continue;
      }

      const unitKey = parsed.unitKey;
      if (typeof unitKey !== 'string' || !KNOWN_UNIT_PREFIXES.some((p) => unitKey.startsWith(p))) {
        skipped += 1;
        continue;
      }

      const event = parsed as unknown as VerdictEvent;
      events.push(event);
      if (committed) committedCount += 1;

      const ts = event.ts;
      if (typeof ts === 'string' && (firstTs === undefined || ts < firstTs)) {
        firstTs = ts;
      }
    }
  }

  return {
    events,
    skipped,
    // gitTracked keys on the LOCAL sidecar (the honesty check is about the local
    // file being mistakenly committed, not the intentionally-committed stream).
    gitTracked: isGitTracked(currentPath),
    firstTs,
    committedCount,
    ...(committedCount > 0 ? { committedNote: COMMITTED_STREAM_NOTE } : {}),
  };
}
