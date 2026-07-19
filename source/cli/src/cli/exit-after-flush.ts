/**
 * Exit after stdout has fully flushed, then let the event loop drain so the
 * process shuts down cleanly. Guards two distinct failure modes:
 *
 * 1. Truncated output. A large report written to a PIPE (an agent capturing
 *    `yg check | grep`, `yg aspect-test` output, `yg impact`, or CI) is buffered;
 *    a bare `process.exit()` terminates before that buffer drains and silently
 *    truncates the output — exactly when it is longest. We wait for the pending
 *    buffer to drain first.
 *
 * 2. Shutdown abort on Windows. The deterministic-check path registers a
 *    node:module customization hook (see ast/loader-hook.ts) so a check.mjs can
 *    import `@chrisdudek/yg/*`. Node runs that hook on a worker thread connected
 *    by a MessagePort — a libuv async handle. Calling `process.exit()` the instant
 *    a command finishes tears the loop down while that handle is still live; on a
 *    Windows debug-assert libuv build (observed on Node 24) that trips
 *    `assert(!(handle->flags & UV_HANDLE_CLOSING))` in src\win\async.c and aborts
 *    with exit 127. Returning to the event loop instead lets Node shut the hook
 *    worker down cleanly and exit on `process.exitCode`.
 *
 * So we set `process.exitCode` and return to the loop rather than forcing the
 * exit. An UNREF'd fallback `process.exit()` preserves the original "never hang
 * on a lingering handle" guarantee: it fires only if some OTHER handle keeps the
 * loop alive past the grace window, and being unref'd it never holds the loop
 * open itself.
 *
 * The returned promise never resolves: callers treat `exitAfterFlush` as terminal
 * — code after `await exitAfterFlush(...)` must not run (e.g. aspect-test.ts relies
 * on it not to fall through into the --files branch). The hung await is harmless;
 * a pending promise is not a libuv handle and does not keep the loop alive.
 *
 * Shared by every command that does a large `process.stdout.write` immediately
 * followed by exit (check, aspect-test, impact). Keep this the single source of
 * the drain-and-exit logic so the fix cannot regress in one command while staying
 * correct in another.
 */

/**
 * Grace window before the unref'd fallback forces exit, for the rare case where
 * some other handle keeps the loop alive. Normal runs exit immediately via loop
 * drain and never reach it.
 */
const FORCE_EXIT_GRACE_MS = 2000;

export async function exitAfterFlush(code: number): Promise<never> {
  // Commit the exit code and arm the fallback BEFORE any await. 'drain' is emitted
  // only after a write returned false, so a sub-highWaterMark buffered write emits
  // none — the await below would then hang, leaving the exit code at its 0 default
  // (a refusal silently exiting green) and the force-exit backstop never scheduled.
  // Ordering these first makes the exit code correct regardless of whether drain
  // ever fires; the loop still exits naturally on `process.exitCode` once stdout
  // flushes, and the unref'd fallback fires only if a lingering handle blocks that.
  process.exitCode = code;
  // Fallback only — unref() so it never keeps the loop alive on its own; fires
  // solely if a genuinely lingering handle blocks the natural exit.
  setTimeout(() => process.exit(code), FORCE_EXIT_GRACE_MS).unref();
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
  // Never resolves: exitAfterFlush is terminal for its callers (see doc comment).
  return new Promise<never>(() => {});
}
