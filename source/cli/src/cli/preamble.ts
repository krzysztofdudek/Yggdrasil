import { stat } from 'node:fs/promises';
import { loadGraphOrThrow, GraphLoadError } from '../core/graph-loader.js';
import { LockEnvironmentError, LockInvalidError } from '../io/lock-store.js';
import type { Graph } from '../model/graph.js';
import { fail } from './output.js';

/**
 * Format and emit an unexpected error from a generic catch block, then
 * process.exit(1). Used as the fallback path after specific error
 * classifications have failed. The `context` string describes what was
 * being attempted, so the message reads "Unexpected error while <context>".
 */
export function abortOnUnexpectedError(error: unknown, context: string): never {
  // Recoverable STATE problems carry a fully-formed what/why/next message with
  // concrete recovery steps — render it directly instead of wrapping it as
  // "Unexpected error ... file an issue". The lock-invalid error (garbled /
  // version / conflict-markered lock, fail-closed) is the verdict-lock engine's
  // fail-closed gate for corrupted or unrecognized lock files.
  if (error instanceof LockInvalidError) {
    // The whole what/why/next the lock reader built — its message alone is only
    // the `what`, which left the reader without the recovery steps.
    fail(error.messageData, 'lock-invalid');
    process.exit(1);
  }
  // An ENVIRONMENT problem around the lock — another approval holds it, or the
  // file system refused the write — is not a bug and says what to do about it.
  if (error instanceof LockEnvironmentError) {
    fail(error.messageData, 'lock-environment');
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  fail({
    what: `Unexpected error while ${context}: ${message}`,
    why: 'The CLI encountered an error it does not classify.',
    next: 'This is a bug — please file an issue with the command you ran and the full error output.',
  }, 'internal');
  process.exit(1);
}

/**
 * Load the graph from the given root, or print a uniform what/why/next error
 * and exit(1).
 *
 * The thin CLI wrapper over the engine's throwing loader (`loadGraphOrThrow`,
 * core/graph-loader.ts), which classifies every failure an adopter can fix —
 * a missing graph, a schema version it cannot read, a broken flow file — into a
 * `GraphLoadError`. This helper prints that diagnosis to stderr and calls
 * process.exit(1); it does not return. Any other error is rethrown so the
 * caller can decide. Long-lived callers (the portal server) use the throwing
 * loader directly and never reach this exit.
 */
export async function loadGraphOrAbort(
  rootPath: string,
  options: { tolerateInvalidConfig?: boolean; noSecrets?: boolean } = {},
): Promise<Graph> {
  try {
    return await loadGraphOrThrow(rootPath, options);
  } catch (err) {
    if (err instanceof GraphLoadError) {
      fail(err.issue, err.issue.what.startsWith('No .yggdrasil/') ? 'graph-missing' : 'graph-load-failed');
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Guard for `yg init --upgrade`: exit with bootstrap guidance when no
 * `.yggdrasil/` exists. `init` is the one command that legitimately runs
 * before a graph exists, so its --upgrade path cannot use `loadGraphOrAbort`
 * (which loads the graph — the graph may need the very migration --upgrade is
 * about to run — and emits a generic message). Centralizing the missing-graph
 * guard here keeps the command handler from inlining an ENOENT branch or the
 * missing-graph string itself.
 */
export async function abortUnlessYggdrasilExists(yggRoot: string): Promise<void> {
  try {
    await stat(yggRoot);
  } catch {
    fail({
      what: 'No .yggdrasil/ directory found in the current project.',
      why: '`yg init --upgrade` operates on an existing graph; the bootstrap form (without --upgrade) creates one.',
      next: "Run 'yg init' to bootstrap a fresh graph, then re-run --upgrade.",
    }, 'graph-missing');
    process.exit(1);
  }
}
