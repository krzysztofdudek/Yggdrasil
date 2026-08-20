import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireBuildLock, releaseBuildLock, BuildLockHeldError } from '../../../src/io/roots-build-lock-store.js';

/** A synthetic Node errno error, for simulating an fs failure without an OS-level trick (root bypasses `chmod`). */
function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// tests/unit/roots/build-lock-store.test.ts — the exclusive `.build.lock`
// (spec §4.4). The clock and the sleep are always injected here — this suite
// never actually waits, not for the 2s default `waitMs` and not for the
// 15-minute staleness threshold (R4-I15).
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshLockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-build-lock-'));
  dirsToCleanup.push(dir);
  return path.join(dir, '.build.lock');
}

/** A fake clock: starts at `startMs`, advances by `stepMs` on every call. */
function fakeClock(startMs: number, stepMs = 0): () => number {
  let t = startMs;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

/** A sleep that never actually waits — just runs the caller-supplied side effect (if any) then resolves. */
function noWaitSleep(onSleep?: () => void): (ms: number) => Promise<void> {
  return async () => {
    onSleep?.();
  };
}

describe('roots-build-lock-store — exclusive acquisition', () => {
  it('acquires a fresh (non-existent) lock immediately', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath, { now: fakeClock(1000), sleep: noWaitSleep() });
    expect(handle.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
  });

  it('release removes the lock file', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath, { now: fakeClock(1000), sleep: noWaitSleep() });
    expect(existsSync(lockPath)).toBe(true);
    releaseBuildLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a second acquire on a held fresh lock retries for the bounded window and then fails, carrying the holder pid', async () => {
    const lockPath = await freshLockPath();
    const clock = fakeClock(0, 200); // advances 200ms on every now() call
    await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() }); // held by "this process"

    let sleepCalls = 0;
    await expect(
      acquireBuildLock(lockPath, { waitMs: 1000, pollMs: 100, now: clock, sleep: noWaitSleep(() => sleepCalls++) }),
    ).rejects.toThrow(BuildLockHeldError);
    expect(sleepCalls).toBeGreaterThan(0); // it actually retried, not an instant refusal
  });

  it('the refusal error carries the holder pid as structured data (what/why/next)', async () => {
    const lockPath = await freshLockPath();
    await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    try {
      await acquireBuildLock(lockPath, { waitMs: 300, pollMs: 100, now: fakeClock(0, 150), sleep: noWaitSleep() });
      expect.unreachable('expected BuildLockHeldError');
    } catch (e) {
      expect(e).toBeInstanceOf(BuildLockHeldError);
      const err = e as BuildLockHeldError;
      expect(err.holderPid).toBe(process.pid);
      expect(err.messageData.what).toContain(String(process.pid));
      expect(err.messageData.why.length).toBeGreaterThan(0);
      expect(err.messageData.next.length).toBeGreaterThan(0);
    }
  });

  it('a holder that releases inside the wait window is acquired rather than refused', async () => {
    const lockPath = await freshLockPath();
    const firstHandle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    const waiterSleep = noWaitSleep(() => {
      // Simulate the holder releasing mid-wait, on the waiter's very next poll.
      releaseBuildLock(firstHandle);
    });
    const waiterHandle = await acquireBuildLock(lockPath, {
      waitMs: 5000,
      pollMs: 100,
      now: fakeClock(0, 100),
      sleep: waiterSleep,
    });
    expect(waiterHandle.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('roots-build-lock-store — staleness (15 minutes, fixed)', () => {
  it('a 15-minute-old lock is broken and acquired without spending any wait budget', async () => {
    const lockPath = await freshLockPath();
    await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    let sleepCalls = 0;
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const handle = await acquireBuildLock(lockPath, {
      waitMs: 2000,
      now: fakeClock(FIFTEEN_MIN_MS),
      sleep: noWaitSleep(() => sleepCalls++),
    });
    expect(handle.path).toBe(lockPath);
    expect(sleepCalls).toBe(0); // stale-break path never waits
  });

  it('a 1-minute-old lock is refused, only after the bounded wait window elapses', async () => {
    const lockPath = await freshLockPath();
    await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    const ONE_MIN_MS = 60 * 1000;
    await expect(
      acquireBuildLock(lockPath, { waitMs: 500, pollMs: 100, now: fakeClock(ONE_MIN_MS, 100), sleep: noWaitSleep() }),
    ).rejects.toThrow(BuildLockHeldError);
  });

  // F1 — a stale lock that CANNOT be unlinked (EPERM from an immutable attribute, a sticky
  // parent directory, EBUSY/EIO, an NFS oddity) must still fall through to the bounded wait
  // and refuse, never busy-loop. Live-reproduced under `chattr +i` (root, Linux) against the
  // pre-fix code: 20,001 calls to the injected clock, 0 sleeps, no refusal, no return — see
  // the FIXER report for that reproduction. Here the same shape is driven through the injected
  // `unlink` seam, which is portable and root-safe (an OS-level `chmod` trick does not bite
  // when the test process runs as root, which this container's commit gate does).
  //
  // The clock uses a NONZERO step deliberately: a frozen (stepMs: 0) clock would make
  // `now() - start >= waitMs` permanently false too, hanging this test instead of failing it
  // (the same hazard flagged for the `>= STALE_LOCK_MS` boundary mutation elsewhere in this
  // suite) — a nonzero step is what lets the wait-budget check ever become true.
  it(
    'a stale lock that cannot be unlinked is refused after the bounded wait — never spins (F1)',
    async () => {
      const lockPath = await freshLockPath();
      await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

      const FIFTEEN_MIN_MS = 15 * 60 * 1000;
      let unlinkCalls = 0;
      let sleepCalls = 0;
      const unbreakableUnlink = (): never => {
        unlinkCalls++;
        throw errnoError('EPERM'); // never ENOENT — a real removal attempt that genuinely fails
      };

      await expect(
        acquireBuildLock(lockPath, {
          waitMs: 1000,
          pollMs: 100,
          now: fakeClock(FIFTEEN_MIN_MS, 100),
          sleep: noWaitSleep(() => sleepCalls++),
          unlink: unbreakableUnlink,
        }),
      ).rejects.toThrow(BuildLockHeldError);

      expect(unlinkCalls).toBeGreaterThan(0); // the stale-break path was genuinely attempted
      expect(unlinkCalls).toBeLessThan(1000); // BOUNDED — not the reviewer's 20,001-iteration spin
      expect(sleepCalls).toBeGreaterThan(0); // it fell through to the bounded wait, not an instant refusal
      expect(existsSync(lockPath)).toBe(true); // the (unbreakable) lock file is still there
    },
    5000,
  );

  // Coverage: a lock file present but containing content that fails to parse as valid lock JSON
  // reads as `holder === undefined` (readLockFileContent's own catch, distinct from F1's
  // unlink-failure branch). Documents CURRENT behavior only — a single bounded acquire call
  // still refuses on schedule, because `tryCreateLockFile` keeps failing EEXIST every
  // iteration regardless of whether the content is parseable. This is not F1's shape (which is
  // about a single call spinning); it is the corrupt-lock question the review filed separately
  // (whether an unparseable lock should be treated as breakable-stale), which is NOT part of
  // this round's fix list and is flagged, not decided, in the fixer report.
  it('a lock file present but containing unparseable content is refused after the bounded wait, holder pid null', async () => {
    const lockPath = await freshLockPath();
    writeFileSync(lockPath, 'not json at all {{{', 'utf-8');

    try {
      await acquireBuildLock(lockPath, { waitMs: 300, pollMs: 100, now: fakeClock(0, 100), sleep: noWaitSleep() });
      expect.unreachable('expected BuildLockHeldError');
    } catch (e) {
      expect(e).toBeInstanceOf(BuildLockHeldError);
      expect((e as BuildLockHeldError).holderPid).toBeNull();
    }
  });
});

describe('roots-build-lock-store — default clock, sleep and unlink (coverage)', () => {
  it('acquires immediately using the real Date.now default when no clock is injected', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath); // no options at all: real Date.now, real sleep, real unlinkSync
    expect(handle.path).toBe(lockPath);
    releaseBuildLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retries using the real setTimeout-based sleep default when a fresh lock is held, and refuses after a short real wait', async () => {
    const lockPath = await freshLockPath();
    await acquireBuildLock(lockPath); // holds it with every default, including the real sleep
    await expect(acquireBuildLock(lockPath, { waitMs: 50, pollMs: 10 })).rejects.toThrow(BuildLockHeldError);
  }, 2000);
});

describe('roots-build-lock-store — release ownership guard', () => {
  it('releaseBuildLock never removes a lock the handle no longer owns (broken-and-reacquired-by-someone-else)', async () => {
    const lockPath = await freshLockPath();
    const oldHandle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    // Simulate the lock going stale and being broken + re-acquired by a different process.
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: oldHandle.pid + 1, createdAtMs: 999_999 }));

    releaseBuildLock(oldHandle);
    expect(existsSync(lockPath)).toBe(true); // the new owner's lock survives
    const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(content.pid).toBe(oldHandle.pid + 1);
  });

  it('releaseBuildLock on an already-gone lock is a silent no-op', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });
    releaseBuildLock(handle);
    expect(() => releaseBuildLock(handle)).not.toThrow();
  });

  // F7 — DECISION 5's ownership guard checks BOTH `pid` and `createdAtMs`. The prior suite only
  // pinned the pid half (`current.pid !== handle.pid`) — a mutation that weakens the guard to
  // pid-only survived all 366 tests (the reviewer's RM-C). This test constructs the shape that
  // half exists for: the SAME pid re-acquires after a stale break (the suite's own fixtures all
  // acquire as `process.pid`, so pid alone can never distinguish an old handle from the new lock
  // a same-process waiter took over the stale one).
  it('releaseBuildLock never removes a lock the handle no longer owns even when the new owner shares this handle\'s pid (F7 — createdAtMs half)', async () => {
    const lockPath = await freshLockPath();
    const oldHandle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });

    // Simulate this SAME process breaking its own stale lock and re-acquiring — same pid,
    // different createdAtMs. A pid-only guard would let `oldHandle` delete the new lock.
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: oldHandle.pid, createdAtMs: oldHandle.createdAtMs + 1 }));

    releaseBuildLock(oldHandle);
    expect(existsSync(lockPath)).toBe(true); // the new (same-pid) lock survives
    const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(content.createdAtMs).toBe(oldHandle.createdAtMs + 1);
  });
});

describe('roots-build-lock-store — release with an injected unlink (coverage)', () => {
  it('releaseBuildLock swallows a non-ENOENT unlink failure with one debugWrite and does not throw', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });
    expect(() =>
      releaseBuildLock(handle, {
        unlink: () => {
          throw errnoError('EPERM');
        },
      }),
    ).not.toThrow();
    expect(existsSync(lockPath)).toBe(true); // the injected unlink never actually removed it
  });

  it('releaseBuildLock treats an ENOENT thrown by unlink itself as a silent no-op (a race with another remover)', async () => {
    const lockPath = await freshLockPath();
    const handle = await acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() });
    expect(() =>
      releaseBuildLock(handle, {
        unlink: () => {
          throw errnoError('ENOENT');
        },
      }),
    ).not.toThrow();
  });
});

describe('roots-build-lock-store — a create failure other than EEXIST is not swallowed (coverage)', () => {
  it('acquireBuildLock rethrows rather than retrying when the exclusive create fails for a reason other than "already exists"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-build-lock-longname-'));
    dirsToCleanup.push(dir);
    // A filename this long fails `openSync(path, 'wx')` with ENAMETOOLONG on every mainstream
    // filesystem — a real, portable, root-safe way to make the exclusive create fail for a
    // reason that is not "the lock already exists", without any OS-level permission trick.
    const lockPath = path.join(dir, `${'x'.repeat(300)}.lock`);
    await expect(acquireBuildLock(lockPath, { now: fakeClock(0), sleep: noWaitSleep() })).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
  });
});
