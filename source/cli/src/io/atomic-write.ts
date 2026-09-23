import { writeFile, rename, mkdir, rm, readdir, stat } from 'node:fs/promises';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { debugWrite } from '../utils/debug-log.js';

// Process-local monotonic counter so two concurrent writes from the SAME process
// (or worker thread, which shares the pid) never collide on a temp name either.
let tmpCounter = 0;

/**
 * Error codes a rename (or the temp write before it) can fail with only for a
 * moment: on Windows an antivirus scanner, an indexer or an editor that holds
 * the target open makes the rename fail with EPERM, EBUSY or EACCES until it
 * lets go, and a directory made briefly read-only surfaces the same way
 * elsewhere. Retrying with a short backoff — the way graceful-fs does — turns
 * those moments into a slower write instead of a lost one. Every other code is
 * a real failure and is thrown at once.
 */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Backoff between attempts of one write, in milliseconds (about 1.6 s in total). */
const WRITE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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
 *
 * A failure with one of {@link TRANSIENT_WRITE_CODES} is retried with backoff
 * before it is thrown; see that constant for why.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await writeOnceViaTemp(filePath, content);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_WRITE_CODES.has(code) || attempt >= WRITE_RETRY_DELAYS_MS.length) throw err;
      debugWrite(`[atomic-write] ${code} writing ${filePath}, retrying (attempt ${attempt + 2})`);
      await sleep(WRITE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function nextTempPath(filePath: string): string {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return `${filePath}.${process.pid}-${tmpCounter}-${randomBytes(4).toString('hex')}.tmp`;
}

async function writeOnceViaTemp(filePath: string, content: string): Promise<void> {
  const tmpPath = nextTempPath(filePath);
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
 * The synchronous twin of {@link atomicWriteFile}, for the one moment an
 * asynchronous write cannot finish: a signal handler that must put the last
 * state on disk before the process goes down. Same temp-then-rename shape, so a
 * reader still sees a whole old or a whole new file; no retry, because nothing
 * may wait there.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = nextTempPath(filePath);
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// ── Exclusive lock files ─────────────────────────────────────────────────────

/** Who holds an exclusive lock file — recorded inside it when it is created. */
export interface ExclusiveFileHolder {
  pid: number;
  host: string;
  /** ISO 8601 UTC time the holder took the lock. */
  startedAt: string;
  /** What the holder is doing, for the message a blocked caller prints. */
  command: string;
  /** Private to the holder: release removes the file only while it still carries it. */
  token: string;
}

export type ExclusiveFileAcquire =
  | { ok: true; release: () => void }
  | { ok: false; holder: ExclusiveFileHolder | null };

/** How long an unreadable lock file may exist before it counts as abandoned: its
 *  creator died between creating it and writing who it is. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

function readRaw(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function parseHolder(raw: string): ExclusiveFileHolder | null {
  try {
    const v = JSON.parse(raw) as Partial<ExclusiveFileHolder>;
    if (typeof v.pid !== 'number' || typeof v.host !== 'string' || typeof v.startedAt !== 'string' || typeof v.token !== 'string') return null;
    return { pid: v.pid, host: v.host, startedAt: v.startedAt, command: typeof v.command === 'string' ? v.command : '', token: v.token };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it just belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A holder is gone when it ran on this machine and its process no longer
 * exists, or when it has held the lock for longer than any run could take (the
 * only test available for a holder on another machine sharing the directory).
 */
function isAbandoned(filePath: string, holder: ExclusiveFileHolder | null, nowMs: number, staleAfterMs: number): boolean {
  if (holder === null) {
    try {
      return nowMs - statSync(filePath).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (holder.host === hostname() && !pidAlive(holder.pid)) return true;
  const started = Date.parse(holder.startedAt);
  return !Number.isNaN(started) && nowMs - started > staleAfterMs;
}

/** Read who holds `filePath` now, or null when nobody does (or it is unreadable). */
export function readExclusiveFileHolder(filePath: string): ExclusiveFileHolder | null {
  const raw = readRaw(filePath);
  return raw === undefined ? null : parseHolder(raw);
}

/**
 * Take an exclusive lock file between PROCESSES: create `filePath` with O_EXCL
 * (`wx`), which the kernel lets exactly one caller win, and record in it who
 * holds it (pid, host, start time, command). A lock left behind by a holder
 * that is gone — its process no longer exists on this machine, or it is older
 * than `staleAfterMs` — is removed and the create retried, so a crashed run
 * never blocks the next one for good.
 *
 * Returns the holder instead of throwing when the lock is held, so each caller
 * decides whether to fail fast or wait. `release` removes the file only while
 * it still carries this caller's token, so a holder that was judged abandoned
 * and replaced never deletes its successor's lock.
 *
 * Known window: two callers that find the SAME abandoned lock at the same
 * instant can both remove it; the content is re-read just before the removal
 * to keep that window as narrow as a single system call.
 */
export function tryAcquireExclusiveFile(
  filePath: string,
  command: string,
  nowMs: number,
  staleAfterMs: number,
): ExclusiveFileAcquire {
  mkdirSync(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(filePath, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const raw = readRaw(filePath);
      if (raw === undefined) continue; // released between our create and our read
      const holder = parseHolder(raw);
      if (!isAbandoned(filePath, holder, nowMs, staleAfterMs)) return { ok: false, holder };
      if (readRaw(filePath) === raw) {
        try { unlinkSync(filePath); } catch { /* another caller removed it first */ }
        debugWrite(`[atomic-write] removed abandoned lock ${filePath} (${raw.trim()})`);
      }
      continue;
    }
    const holder: ExclusiveFileHolder = {
      pid: process.pid,
      host: hostname(),
      startedAt: new Date(nowMs).toISOString(),
      command,
      token: randomBytes(8).toString('hex'),
    };
    try {
      writeSync(fd, `${JSON.stringify(holder)}\n`);
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const current = readExclusiveFileHolder(filePath);
        if (current?.token !== holder.token) return;
        try { unlinkSync(filePath); } catch { /* already gone */ }
      },
    };
  }
  return { ok: false, holder: readExclusiveFileHolder(filePath) };
}

// ── Final writes on interruption ─────────────────────────────────────────────

const interruptCallbacks: Array<() => void> = [];
const INTERRUPT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

function onInterruptSignal(signal: NodeJS.Signals): void {
  const callbacks = interruptCallbacks.splice(0).reverse();
  for (const cb of callbacks) {
    try {
      cb();
    } catch (e) {
      debugWrite(`[atomic-write] interrupt callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const s of INTERRUPT_SIGNALS) process.removeListener(s, onInterruptSignal);
  // Re-raise so the process ends exactly as it would have without us.
  process.kill(process.pid, signal);
}

/**
 * Run `callback` synchronously if the process is interrupted (SIGINT, SIGTERM)
 * before the returned disposer is called — the hook a writer that batches its
 * writes uses to put its last state on disk, and a lock holder uses to release
 * its lock, before the signal takes the process down. Callbacks run newest
 * first, then the signal is re-raised. SIGKILL cannot be caught; what a writer
 * loses to it is bounded by how often it flushes, not by this hook.
 */
export function onProcessInterrupt(callback: () => void): () => void {
  if (interruptCallbacks.length === 0) {
    for (const s of INTERRUPT_SIGNALS) process.on(s, onInterruptSignal);
  }
  interruptCallbacks.push(callback);
  return () => {
    const i = interruptCallbacks.indexOf(callback);
    if (i >= 0) interruptCallbacks.splice(i, 1);
    if (interruptCallbacks.length === 0) {
      for (const s of INTERRUPT_SIGNALS) process.removeListener(s, onInterruptSignal);
    }
  };
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
