/**
 * source/cli/src/io/roots-build-lock-store.ts — the exclusive `.build.lock`
 * every roots cache writer takes (spec §4.4 `v6-spec.md:139`; design
 * `integration-design.md:160-163`; Increment-2's recorded deferral,
 * `2026-08-18-increment-2-roots-core.md:1296-1298`, which R4 now lands).
 *
 * The name is load-bearing on both halves: `*-store.ts` is what
 * `persistence-adapter`'s `when:` predicate matches
 * (`yg-architecture.yaml:183`), and the `roots-build-lock-` prefix keeps this
 * distinct from `io/lock-store.ts`, which is the unrelated graph verdict-lock
 * triad store.
 *
 * Exclusive create with this process's pid (and the acquiring instant) inside
 * the file; stale after 15 minutes (fixed). A held FRESH lock is retried
 * until `waitMs` elapses and only then refused — §4.4 reads "CLI builds
 * **wait briefly, then fail**", not "fail" outright. The refusal
 * (`BuildLockHeldError`) carries the holder's pid as structured data; this
 * file never formats a final message string — `buildIssueMessage` lives on
 * the `formatter` architecture type, off `persistence-adapter`'s `calls`
 * allow-list, so the CLI command layer that surfaces this error to a user is
 * the one that calls it over `messageData`, the same division
 * `io/lock-store.ts`'s own `LockInvalidError` already uses.
 *
 * `atomic-write-contract` bans `writeFile`/`writeFileSync`/`appendFile`/
 * `appendFileSync`/`createWriteStream` imported from `node:fs` in every
 * `src/io/*.ts` file, so the exclusive create is spelled `openSync(path,
 * 'wx')` + `writeSync` + `closeSync` — the aspect-safe form of `O_EXCL`, not
 * `writeFileSync(path, pid, { flag: 'wx' })`.
 *
 * The clock (`now`) and the sleep between polls are both injected, so no test
 * ever waits — not for the 2-second default `waitMs`, and not for the
 * 15-minute staleness threshold. The `unlink` used to break a stale lock is
 * injected too, in the same idiom, so a test can deterministically simulate
 * an un-unlinkable stale lock (EPERM, EBUSY, EIO, an NFS oddity) — an
 * OS-level `chmod` trick does not bite when the test process runs as root,
 * which the commit-gate container does. `acquireBuildLock`'s wait window
 * bounds EVERY path, including that one: an unbreakable stale lock is
 * treated as still held and falls through to the same bounded wait a
 * held-fresh lock uses, rather than retrying the break for free forever (see
 * `breakStaleLock`'s own comment for the busy-loop this replaces).
 */

import path from 'node:path';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { debugWrite } from '../utils/debug-log.js';
import type { IssueMessage } from '../model/validation.js';

/** Fixed by spec §4.4 — a lock older than this is broken and re-acquired regardless of `waitMs`. */
const STALE_LOCK_MS = 15 * 60 * 1000;

interface LockFileContent {
  pid: number;
  createdAtMs: number;
}

export interface AcquireBuildLockOptions {
  /** Total time to retry a held-but-fresh lock before refusing. Default 2000ms. */
  waitMs?: number;
  /** Delay between retries while waiting. Default 100ms. */
  pollMs?: number;
  /** Injectable clock (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Injectable delay. Default a real `setTimeout`-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable exclusive-unlink, used only to break a lock this process has
   * judged stale. Default `unlinkSync`. Exists so a test can simulate an
   * un-unlinkable stale lock (EPERM from an immutable attribute, a sticky
   * parent directory owned by another user, EBUSY/EIO, an NFS oddity)
   * deterministically and portably — an OS-level trick (`chmod`) does not
   * bite when the process runs as root, which the commit-gate container
   * does, so it is not a fit for the killer test this seam exists for. See
   * `breakStaleLock` below for why an unbreakable stale lock must never make
   * this loop skip its own bounded wait.
   */
  unlink?: (path: string) => void;
}

/** An acquired lock. `pid`/`createdAtMs` are this acquisition's own recorded content — `releaseBuildLock` uses them to refuse to remove a lock this handle no longer owns (see below). */
export interface BuildLockHandle {
  path: string;
  pid: number;
  createdAtMs: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | undefined {
  return e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
}

/**
 * Thrown when the bounded wait window elapses with the lock still held by a
 * fresh (non-stale) holder — the single new non-zero exit R4 adds (R4-I9):
 * refusing to write over a concurrent run is a genuine problem, not an
 * advisory verdict. `holderPid` is `null` only in the (rare, racy) case where
 * the lock file could not be read at the moment of refusal.
 */
export class BuildLockHeldError extends Error {
  readonly code = 'build-lock-held';
  readonly lockPath: string;
  readonly holderPid: number | null;
  readonly messageData: IssueMessage;

  constructor(lockPath: string, holderPid: number | null) {
    const what =
      holderPid !== null
        ? `the roots build lock at ${lockPath} is held by process ${holderPid}`
        : `the roots build lock at ${lockPath} is held, but its holder's pid could not be read`;
    const why =
      'another roots build (index, or a future maintenance command) is currently writing the mined state — model.json included, not only the cache; writing over it at the same time would corrupt what gets committed';
    const next =
      'wait for the other build to finish and retry, or if no such process is actually still running, remove the stale lock file and retry';
    super(what);
    this.name = 'BuildLockHeldError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.messageData = { what, why, next };
  }
}

function isLockFileContent(value: unknown): value is LockFileContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).pid === 'number' &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number'
  );
}

/** Best-effort read: absent, unreadable, or unparseable content all read as "cannot verify" (`undefined`), never a throw. */
function readLockFileContent(lockPath: string): LockFileContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isLockFileContent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `openSync(path, 'wx')` — exclusive create, the aspect-safe `O_EXCL` spelling. Returns `false` on EEXIST, throws on any other error. */
function tryCreateLockFile(lockPath: string, content: LockFileContent): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(content));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Remove a lock file judged stale. Best-effort — but the return value is
 * load-bearing, not decorative: a race with another breaker (ENOENT) counts
 * as success (the lock is gone either way); any other failure reports
 * `false` so the caller treats an unbreakable stale lock as still HELD
 * rather than silently retrying the break forever. A prior version of this
 * function returned `void` and let the caller `continue` unconditionally on
 * every stale judgment, which turned an un-unlinkable stale lock (this
 * function's only non-ENOENT failure path) into an unbounded, zero-sleep
 * spin: judge stale → fail to break → judge stale again → fail again, with
 * the wait-budget check below never reached because it sat only on the
 * OTHER branch. Reproduced live under `chattr +i` (root, Linux): 20,001
 * calls to the injected clock, 0 sleeps, no refusal, no return. The fix is
 * this return value plus the caller's fall-through below.
 */
function breakStaleLock(lockPath: string, unlink: (path: string) => void): boolean {
  try {
    unlink(lockPath);
    debugWrite(`[roots-build-lock-store] broke stale lock ${lockPath}`);
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return true;
    debugWrite(`[roots-build-lock-store] failed to break stale lock ${lockPath}: ${errMsg(e)}`);
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the exclusive build lock at `lockPath`. Creates the parent
 * directory if missing. On a held lock: a stale one (older than 15 minutes,
 * by the injected clock) is broken and re-acquired immediately, no
 * wait-budget spent; a fresh one is retried every `pollMs` until `waitMs`
 * elapses, and only then throws `BuildLockHeldError`. A holder that releases
 * (or is broken by another racer) inside the wait window is acquired on the
 * very next poll rather than refused — the killer case MR-2 and this file's
 * own acceptance criterion 2 pin.
 *
 * BOUNDEDNESS holds on every path, including the stale-but-unbreakable one:
 * a successful stale-break retries immediately at no wait-budget cost (the
 * lock is provably gone), but a FAILED stale-break falls through to the same
 * `now() - start >= waitMs` check the held-fresh-lock path uses, rather than
 * looping back to re-judge staleness for free. Without that fall-through, a
 * lock that is stale but can never be unlinked (EPERM from an immutable
 * attribute, a sticky parent directory, EBUSY/EIO, an NFS oddity) makes this
 * loop spin at 100% CPU with zero sleeps and no exit — see `breakStaleLock`.
 */
export async function acquireBuildLock(lockPath: string, options: AcquireBuildLockOptions = {}): Promise<BuildLockHandle> {
  const waitMs = options.waitMs ?? 2000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const unlink = options.unlink ?? unlinkSync;

  mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = now();

  for (;;) {
    const content: LockFileContent = { pid: process.pid, createdAtMs: now() };
    if (tryCreateLockFile(lockPath, content)) {
      return { path: lockPath, pid: content.pid, createdAtMs: content.createdAtMs };
    }

    const holder = readLockFileContent(lockPath);
    if (holder !== undefined && now() - holder.createdAtMs >= STALE_LOCK_MS) {
      if (breakStaleLock(lockPath, unlink)) continue; // a successful break costs no wait-budget
      // An unbreakable stale lock is still a HELD lock as far as this loop's
      // exit conditions go: fall through to the bounded wait below instead
      // of re-judging staleness for free, which is what kept this spinning.
    }

    if (now() - start >= waitMs) {
      debugWrite(`[roots-build-lock-store] ${lockPath} still held after ${waitMs}ms wait`);
      throw new BuildLockHeldError(lockPath, holder?.pid ?? null);
    }
    await sleep(pollMs);
  }
}

export interface ReleaseBuildLockOptions {
  /** Injectable unlink, same rationale as `AcquireBuildLockOptions.unlink`. Default `unlinkSync`. */
  unlink?: (path: string) => void;
}

/**
 * Release a held lock. Verifies the on-disk content still matches this
 * handle's own `(pid, createdAtMs)` before removing it — a handle must never
 * delete a lock it no longer owns. That guard matters precisely because a
 * lock CAN be broken out from under a legitimate long-running holder (the
 * staleness path above): if this process's own hold outlived 15 minutes, a
 * waiter may already have broken it and acquired its own new lock, and a
 * blind `unlinkSync` here would delete that waiter's lock instead of this
 * (now-irrelevant) handle's.
 */
export function releaseBuildLock(handle: BuildLockHandle, options: ReleaseBuildLockOptions = {}): void {
  const unlink = options.unlink ?? unlinkSync;
  const current = readLockFileContent(handle.path);
  if (current === undefined) return; // already gone
  if (current.pid !== handle.pid || current.createdAtMs !== handle.createdAtMs) {
    debugWrite(`[roots-build-lock-store] not releasing ${handle.path}: now held by a different owner`);
    return;
  }
  try {
    unlink(handle.path);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return;
    debugWrite(`[roots-build-lock-store] failed to release ${handle.path}: ${errMsg(e)}`);
  }
}
