import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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
