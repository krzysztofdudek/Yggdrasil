import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exitAfterFlush } from '../../../src/cli/exit-after-flush.js';

/**
 * exitAfterFlush must NOT call process.exit() synchronously: it sets
 * process.exitCode and returns to the event loop so Node can tear down the
 * node:module hook worker (a MessagePort async handle) cleanly. Forcing the exit
 * the instant a command finishes aborts the process on Windows/Node 24
 * (libuv src\win\async.c UV_HANDLE_CLOSING assertion). These tests lock in that
 * contract so a regression back to an immediate process.exit() is caught.
 *
 * setTimeout is mocked in every test so the real unref'd fallback timer is never
 * scheduled — otherwise it could fire its (mocked) process.exit after the spy is
 * restored and kill the runner.
 */
describe('exitAfterFlush', () => {
  const origExitCode = process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let unrefSpy: ReturnType<typeof vi.fn>;
  let fallback: (() => void) | null;

  beforeEach(() => {
    fallback = null;
    unrefSpy = vi.fn();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fallback = fn; // capture; do NOT schedule a real timer
      return { unref: unrefSpy } as unknown as NodeJS.Timeout;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = origExitCode;
  });

  it('sets process.exitCode and does not force-exit synchronously', async () => {
    void exitAfterFlush(3);
    await Promise.resolve();

    expect(process.exitCode).toBe(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("schedules an unref'd fallback that force-exits with the code only when fired", async () => {
    void exitAfterFlush(2);
    await Promise.resolve();

    // Scheduled and unref'd, so it can never hold the loop open by itself.
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    // Not fired during a normal run.
    expect(exitSpy).not.toHaveBeenCalled();
    // When a lingering handle blocks natural exit, the fallback forces it.
    expect(fallback).toBeTypeOf('function');
    fallback!();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('commits the exit code and arms the fallback even when the buffer never emits drain', async () => {
    // writableLength > 0 but no 'drain' will ever fire — a sub-highWaterMark
    // buffered write emits none. The code and the fallback must be committed
    // BEFORE the drain await, or the await hangs, the exit code stays at its 0
    // default (a refusal exits green), and the force-exit backstop is never armed.
    const wlSpy = vi.spyOn(process.stdout, 'writableLength', 'get').mockReturnValue(1);
    // once('drain', …) that never invokes its listener (drain never arrives).
    const onceSpy = vi
      .spyOn(process.stdout, 'once')
      .mockImplementation(() => process.stdout);
    try {
      void exitAfterFlush(5);
      await Promise.resolve();
      await Promise.resolve();
      expect(process.exitCode).toBe(5);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      wlSpy.mockRestore();
      onceSpy.mockRestore();
    }
  });

  it('returns a promise that never resolves (terminal for callers)', async () => {
    let settled = false;
    void exitAfterFlush(1).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
  });
});
