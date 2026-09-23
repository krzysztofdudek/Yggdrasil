import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { debugWrite } from '../utils/debug-log.js';

/** Generic synchronous local-log appender. The debug log and the write-only
 *  telemetry/forensic sidecars all route their raw appends through here. */
export function appendToDebugLog(filePath: string, text: string): void {
  appendFileSync(filePath, text, 'utf-8');
}

/**
 * Append like {@link appendToDebugLog}, but first rotate the file to `<file>.1`
 * (replacing any older `.1`) once it has reached `maxBytes`, so a local log that
 * every run appends to stays bounded at about two generations instead of growing
 * for the life of the checkout. Readers read `.1` before the current file, so
 * the combined stream keeps its order. Best-effort: two processes rotating at
 * the same instant can drop one older generation, never a line of the current one.
 */
export function appendWithRotation(filePath: string, text: string, maxBytes: number): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    // Absent: nothing to rotate.
  }
  if (size >= maxBytes) {
    try {
      renameSync(filePath, `${filePath}.1`);
    } catch (e) {
      debugWrite(`[debug-log-writer] rotation of ${filePath} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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

/** The gitignore line that keeps every run-exclusion file (`.yg-approve.lock`,
 *  `.yg-log.lock`) out of the repository. Written by `yg init` (fresh and
 *  --upgrade) only: the lock holders deliberately do not self-ensure it, since
 *  appending to the tracked `.gitignore` during an approval would make the
 *  approval's own report see a changed input. */
export const RUN_LOCK_GITIGNORE_LINE = '.yg-*.lock';

// ---------------------------------------------------------------------------
// Convergence-sentinel evidence log (C15)
// ---------------------------------------------------------------------------

/** The convergence-sentinel evidence log's filename, relative to the
 *  `.yggdrasil/` graph root. Gitignored — local, best-effort forensic state
 *  written only when the fill detects a 0-fill divergence; never committed. */
export const FILL_DIVERGENCE_FILENAME = '.yg-fill-divergence.log';

/** The gitignore line that covers the evidence log AND its single rotation
 *  (`<name>.1`). A bare filename entry matches only the exact name under
 *  gitignore fnmatch semantics, so the trailing `*` is required to keep the
 *  rotated dump out of the repo too. Callers must pass this exact string to
 *  {@link ensureGitignoreLine} (the idempotency test is an exact match). */
export const FILL_DIVERGENCE_GITIGNORE_LINE = `${FILL_DIVERGENCE_FILENAME}*`;

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
    ensureGitignoreLine(yggRootPath, FILL_DIVERGENCE_GITIGNORE_LINE);
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
