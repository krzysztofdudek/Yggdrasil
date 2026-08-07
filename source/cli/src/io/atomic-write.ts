import { writeFile, rename, mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { debugWrite } from '../utils/debug-log.js';

// Process-local monotonic counter so two concurrent writes from the SAME process
// (or worker thread, which shares the pid) never collide on a temp name either.
let tmpCounter = 0;

/**
 * Write `content` to `filePath` atomically via a UNIQUE temp file + rename.
 * Creates the parent directory recursively if missing.
 *
 * The temp name is unique per writer (`pid-counter-random`), not a fixed
 * `<filePath>.tmp`. A fixed temp raced whenever two writers targeted the same
 * file — e.g. parallel test workers, or two CLI runs, writing the same shared
 * `.ast-cache/` shard or lock: one writer's rm/rename pulled the temp out from
 * under the other, surfacing as `ENOENT` on rename. With a private temp per
 * write, only the final `rename` onto the shared target is contended, and rename
 * is atomic — a reader always sees a complete old or new file, never a partial
 * one. Every caller here writes content that is either content-deterministic
 * (the AST-fact cache) or single-owner (locks/logs), so last-write-wins on the
 * target is correct.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  tmpCounter = (tmpCounter + 1) >>> 0;
  const tmpPath = `${filePath}.${process.pid}-${tmpCounter}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    // Never leave our own temp behind on failure (the target is untouched — the
    // rename either fully succeeded or never happened).
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * How old an orphaned temp must be before the sweep will remove it. Long enough
 * that a temp belonging to a CONCURRENT writer — another `yg` process, a
 * parallel test worker — is never in range, since such a temp lives only for the
 * moment between its write and its rename. A temp older than this was left by a
 * run that is no longer going to rename it.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/** Matches the temp names `atomicWriteFile` above produces: `<target>.<pid>-<counter>-<hex>.tmp`. */
const TEMP_NAME_PATTERN = /\.\d+-\d+-[0-9a-f]{8}\.tmp$/;

/**
 * Delete stale temp files left in `dir` by an atomic write that never completed.
 *
 * `atomicWriteFile`'s own cleanup handles the case it can: a thrown error, where
 * the `catch` runs. Nothing runs when the process is killed outright — an
 * out-of-memory abort, a SIGKILL, a machine losing power — and the temp then
 * survives beside the file it was going to become. On a lock directory that
 * means a repository accumulates one stray file per crash, each looking to a
 * reader like something the tool meant to leave there.
 *
 * Deliberately narrow, so it can never delete anything that is not ours:
 *   - only `dir` itself, never a subdirectory;
 *   - only names matching this module's own temp pattern (a hand-written
 *     `notes.tmp` does not match, needing the pid/counter/random triple);
 *   - only entries older than `STALE_TEMP_AGE_MS`, so a temp another process is
 *     mid-write on is out of range;
 *   - only regular files.
 *
 * Best-effort and silent: every failure is swallowed to the debug log. A sweep
 * that cannot read the directory, or loses a race to another sweeper, must never
 * turn into an error on a command that was doing something else entirely.
 *
 * `now` is injected so the age comparison is testable and so this reads no clock
 * of its own.
 */
export async function sweepStaleTempFiles(dir: string, now: () => number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    debugWrite(`[atomic-write] temp sweep skipped for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const cutoff = now() - STALE_TEMP_AGE_MS;
  for (const name of entries) {
    if (!TEMP_NAME_PATTERN.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await rm(full, { force: true });
      debugWrite(`[atomic-write] removed stale temp ${full}`);
    } catch (e) {
      // Lost a race with another sweeper, or no permission — either way, leave it.
      debugWrite(`[atomic-write] could not remove ${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
