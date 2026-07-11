import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { debugWrite } from '../utils/debug-log.js';

/** Generic synchronous local-log appender. The debug log and the write-only
 *  telemetry/forensic sidecars all route their raw appends through here. */
export function appendToDebugLog(filePath: string, text: string): void {
  appendFileSync(filePath, text, 'utf-8');
}

/**
 * Ensure `<yggRoot>/.gitignore` carries an exact ignore `line` (G5 — a write-only
 * sidecar guarantees its OWN gitignore entry, independent of `yg init`, so a
 * rebuildable local artifact can never be committed). Append-only and idempotent;
 * a missing gitignore is treated as empty state and created. The idempotency test
 * is an exact trimmed-line match, so callers must pass the SAME string every time
 * (e.g. `.drill-results.jsonl*`). Shared chokepoint for every telemetry/forensic
 * sidecar's self-ensure so the node:fs usage lives in exactly one place.
 */
export function ensureGitignoreLine(yggRootPath: string, line: string): void {
  const giPath = path.join(yggRootPath, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf-8') : '';
  const present = existing.split('\n').some((l) => l.trim() === line);
  if (present) return;
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(giPath, `${sep}${line}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Convergence-sentinel evidence log (C15)
// ---------------------------------------------------------------------------

/** The convergence-sentinel evidence log's filename, relative to the
 *  `.yggdrasil/` graph root. Gitignored — local, best-effort forensic state
 *  written only when the fill detects a 0-fill divergence; never committed. */
export const FILL_DIVERGENCE_FILENAME = '.yg-fill-divergence.log';

/**
 * Persist one convergence-sentinel evidence dump. Synchronous and best-effort —
 * the sentinel fires at the fill's report boundary just before the CLI exits, so
 * the dump must land before the process ends rather than race a fire-and-forget
 * async write. Steps: self-ensure the gitignore line, single-rotate any prior
 * dump to `<name>.1`, then write the fresh dump. Never throws — a sentinel
 * failure must never fail a fill.
 */
export function writeFillDivergence(yggRootPath: string, text: string): void {
  try {
    ensureGitignoreLine(yggRootPath, FILL_DIVERGENCE_FILENAME);
    const logPath = path.join(yggRootPath, FILL_DIVERGENCE_FILENAME);
    const rotated = `${logPath}.1`;
    if (existsSync(logPath)) {
      try {
        // Replace any prior rotation so rename never fails on a pre-existing
        // target (cross-platform), then move the current dump aside.
        if (existsSync(rotated)) rmSync(rotated, { force: true });
        renameSync(logPath, rotated);
      } catch (e) {
        debugWrite(
          `[fill-divergence] rotation failed (swallowed): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    appendFileSync(logPath, text, 'utf-8');
  } catch (e) {
    debugWrite(
      `[fill-divergence] write failed (swallowed): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
