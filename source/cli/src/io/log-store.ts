import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { IssueMessage } from '../model/validation.js';
import { atomicWriteFile, tryAcquireExclusiveFile } from './atomic-write.js';
import { readFileOrDefault } from './read-or-default.js';
import { debugWrite } from '../utils/debug-log.js';

export async function readLogSafe(logPath: string): Promise<string> {
  return await readFileOrDefault(logPath, '', '[log-store] readLogSafe');
}

export interface LogFileStats {
  isSymbolicLink: boolean;
  hardLinkCount: number;
}

export async function statLogFile(logPath: string): Promise<LogFileStats | null> {
  try {
    const st = await lstat(logPath);
    return { isSymbolicLink: st.isSymbolicLink(), hardLinkCount: st.nlink };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      debugWrite(`[log-store] statLogFile: file not found: ${logPath}`);
      return null;
    }
    throw err;
  }
}

export async function writeLogFile(logPath: string, content: string): Promise<void> {
  await atomicWriteFile(logPath, content);
}

/** The file a log writer holds while it reads a log, adds an entry and replaces it. */
export const LOG_WRITE_LOCK_FILE_NAME = '.yg-log.lock';

/** How long a log writer waits for another one to finish before it gives up. */
const LOG_LOCK_WAIT_MS = 10_000;
/** A log writer holds the lock for milliseconds; one held this long is abandoned. */
const LOG_LOCK_STALE_MS = 60_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Run `fn` — a read → compose → replace of a log file — while holding the
 * repository's log-write lock, so two writers can never both read the same
 * log and each replace it with only their own entry added (the second rename
 * silently dropping the first entry while both report success). Log writes
 * take milliseconds, so a caller that finds the lock held WAITS its turn, for
 * up to LOG_LOCK_WAIT_MS, and only then gives up with an explicit error — it
 * never proceeds unlocked. A lock left by a writer that died is detected and
 * replaced.
 */
export async function withLogWriteLock<T>(
  yggRootPath: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: IssueMessage }> {
  const lockFile = path.join(yggRootPath, LOG_WRITE_LOCK_FILE_NAME);
  const deadline = Date.now() + LOG_LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const taken = tryAcquireExclusiveFile(lockFile, 'yg log add', Date.now(), LOG_LOCK_STALE_MS);
    if (taken.ok) {
      try {
        return { ok: true, value: await fn() };
      } finally {
        taken.release();
      }
    }
    if (Date.now() >= deadline) {
      const who = taken.holder ? `process ${taken.holder.pid} on ${taken.holder.host}, since ${taken.holder.startedAt}` : 'another process';
      return {
        ok: false,
        error: {
          what: `Could not add the log entry: another log write in this repository (${who}) did not finish within ${LOG_LOCK_WAIT_MS / 1000} s.`,
          why: 'A log entry is added by reading the log, appending to it and replacing the file; two writers at once would each drop the other\'s entry, so this one waited its turn and gave up rather than write unguarded. Nothing was written.',
          next: `Re-run the same command. If no other yg process is running, delete .yggdrasil/${LOG_WRITE_LOCK_FILE_NAME} first.`,
        },
      };
    }
    // Short, jittered back-off: holders finish in milliseconds.
    await pause(10 + ((attempt * 7) % 20));
  }
}
