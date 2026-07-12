/**
 * source/cli/src/io/drill-results-reader.ts — the reader counterpart of the
 * append-only drill-results sidecar written by io/drill-results-store.ts.
 *
 * Like io/events-reader, this module reads local, gitignored telemetry ONLY and
 * is quarantined from the engine: nothing in a check / verify / render / fill
 * path may import it, and core/** never reaches it (the advise CLI boundary reads
 * it and passes the plain data into the pure nomination engine as a parameter).
 * It exists so the read-only `yg advise` surface can turn a recorded drill MISS
 * into an attention nomination — but ONLY while the recorded rule hash still
 * matches the current rule source (freshness is decided by the engine, not here).
 *
 * Read tolerance (fail-open — telemetry, never a hard failure):
 *   - an ABSENT `v` field means v1;
 *   - an unknown `v`, a non-JSON line, or a mis-shaped record is COUNTED
 *     (`skipped`) and dropped, never thrown;
 *   - a missing sidecar yields an empty result, no throw;
 *   - ANY unexpected read error degrades to an empty / partial result.
 *
 * The rotated `.1` sidecar (if present) is read BEFORE the current file so the
 * merged stream stays in chronological (append) order.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DRILL_RESULTS_FILENAME, type DrillResultLine } from './drill-results-store.js';

/** Result of reading the local drill-results telemetry sidecar. */
export interface DrillResultsReadResult {
  /** Parsed drill-result lines, in file order — rotated `.1` first, then current. */
  results: DrillResultLine[];
  /** Count of dropped lines: unknown `v`, non-JSON, or a mis-shaped record. */
  skipped: number;
  /** Earliest `ts` observed across accepted lines (undefined when none). */
  firstTs?: string;
}

/** Drill outcomes a v1 line may record for `expect` / `got`. */
const KNOWN_EXPECT = new Set(['refused', 'satisfied']);
const KNOWN_GOT = new Set(['refused', 'satisfied', 'unrun', 'unsupported']);

/** Read a UTF-8 file, degrading a missing file (or any read error) to undefined. */
function readSidecarSafe(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Type guard: a parsed JSON value that is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the drill-results telemetry sidecar under `yggRootPath` (the `.yggdrasil/`
 * graph root). Never throws — see the module header for the tolerance contract.
 * Only the fields the nomination engine consumes are validated; a line missing a
 * required field is dropped rather than surfaced as a malformed nomination.
 */
export function readDrillResults(yggRootPath: string): DrillResultsReadResult {
  const currentPath = path.join(yggRootPath, DRILL_RESULTS_FILENAME);
  const rotatedPath = `${currentPath}.1`;

  const results: DrillResultLine[] = [];
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

      const { ts, aspect, case: caseLabel, expect, got, ruleHash } = parsed;
      if (
        typeof ts !== 'string' ||
        typeof aspect !== 'string' ||
        typeof caseLabel !== 'string' ||
        typeof expect !== 'string' ||
        !KNOWN_EXPECT.has(expect) ||
        typeof got !== 'string' ||
        !KNOWN_GOT.has(got) ||
        typeof ruleHash !== 'string'
      ) {
        skipped += 1;
        continue;
      }

      results.push(parsed as unknown as DrillResultLine);

      if (typeof ts === 'string' && (firstTs === undefined || ts < firstTs)) {
        firstTs = ts;
      }
    }
  }

  return { results, skipped, firstTs };
}
