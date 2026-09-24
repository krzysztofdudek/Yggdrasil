/**
 * source/cli/src/io/run-scope-cache.ts — caches that live for exactly one command
 * run, and only when the command asks for them.
 *
 * A plain `yg check` reads the same directories many times over: the coverage
 * scan, mapping validation, type classification, the relation pass, the pair
 * computation and the suppression audit each expand every node's mapping, and
 * every expansion re-read each directory's `.gitignore` and re-listed it. At
 * 18k files and 2.5k directories that was ~28k `.gitignore` reads and ~9k
 * directory listings per run for an answer that cannot change while the run is
 * in flight — a `yg` run writes no source.
 *
 * The caches here remove that repetition, but only inside {@link withRunScope}:
 * a command that is one read-only run over the repository (`yg check`,
 * `yg context`) wraps its body in it. Outside a scope nothing is cached and
 * every call reads the disk, as before — so a library caller, a test, or a
 * long-lived process (the portal) never sees a listing from before its own
 * edit. The scope is carried by AsyncLocalStorage, so it follows the command's
 * async work and ends with it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunCaches {
  /** Parsed `.gitignore` per absolute directory (see repo-scanner.ts). The value type is owned there. */
  gitignore: Map<string, Promise<unknown>>;
  /** Gitignore-filtered file list per (project root, absolute directory) walk (see io/hash.ts). */
  directoryFiles: Map<string, Promise<string[]>>;
}

const storage = new AsyncLocalStorage<RunCaches>();

/** Run `fn` with a fresh set of run caches; they are dropped when it settles. */
export function withRunScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ gitignore: new Map(), directoryFiles: new Map() }, fn);
}

/** The current run's caches, or undefined outside {@link withRunScope}. */
export function runCaches(): RunCaches | undefined {
  return storage.getStore();
}
