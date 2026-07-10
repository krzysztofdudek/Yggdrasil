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
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_FILENAME, type VerdictEvent } from './events-store.js';

/** Result of reading the local verdict-events telemetry sidecar. */
export interface EventsReadResult {
  /** Parsed events, in file order — rotated `.1` first, then the current file. */
  events: VerdictEvent[];
  /** Count of dropped lines: unknown `v`, unknown unitKey prefix, or non-JSON. */
  skipped: number;
  /** True when the sidecar is git-tracked — the caller must then refuse the "local" label. */
  gitTracked: boolean;
  /** Earliest `ts` observed across accepted events (undefined when none). */
  firstTs?: string;
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
  // Rotation convention: the previous generation is `<sidecar>.1`, read first so
  // the merged stream stays in append (chronological) order.
  const rotatedPath = `${currentPath}.1`;

  const events: VerdictEvent[] = [];
  let skipped = 0;
  let firstTs: string | undefined;

  for (const filePath of [rotatedPath, currentPath]) {
    const content = readSidecarSafe(filePath);
    if (content === undefined) continue;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;

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

      const ts = event.ts;
      if (typeof ts === 'string' && (firstTs === undefined || ts < firstTs)) {
        firstTs = ts;
      }
    }
  }

  return { events, skipped, gitTracked: isGitTracked(currentPath), firstTs };
}
