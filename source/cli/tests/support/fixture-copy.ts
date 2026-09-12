// =============================================================================
// Shared committed-fixture copy helper.
//
// WHY THIS EXISTS
//   The fixture projects under tests/fixtures/ are COMMITTED and SHARED — dozens of
//   suites point the engine at the same directory on disk. As it runs, the engine
//   writes rebuildable caches into that project's own `.yggdrasil/`: `.ast-cache/`,
//   `.type-class-cache/`, and the retired `.symbols-cache/` still left behind in
//   older checkouts. Every one of them is gitignored; none of them is part of the
//   fixture. A committed fixture on disk is therefore a moving target — it carries
//   whatever cache state the last run through it happened to leave.
//
//   Copying that state into a test's temp project is wrong twice over:
//
//     (1) SEMANTICS. A freshly copied fixture must start with a COLD cache. Inherit
//         a warm one and the test silently exercises a different path than the one
//         it names — and only on the machines where the cache happened to be warm,
//         which is the worst way for a test to disagree with itself.
//
//     (2) A RACE. Vitest runs suites in parallel workers. While one worker copies a
//         committed fixture, another worker is writing cache entries into that same
//         directory, and the copy walks into a half-written entry:
//         `ENOENT: no such file or directory ... /.yggdrasil/.ast-cache/...`.
//
//   Skipping the cache directories on the way in settles both at once: the copy no
//   longer reads the one part of the tree a concurrent worker writes, and the temp
//   project starts cold by construction rather than by luck.
//
//   This module imports ONLY Node builtins — never anything under src/** — so e2e
//   suites (which must stay off the CLI's internal surface) can use it freely.
// =============================================================================

import { cpSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';

/**
 * Directory names, relative to a project's `.yggdrasil/`, that hold rebuildable
 * engine state rather than fixture content. Each one is gitignored by the list
 * `yg init` installs; keep the two in step when a new cache is added.
 */
const RUNTIME_CACHE_DIRS: readonly string[] = ['.ast-cache', '.type-class-cache', '.symbols-cache'];

/** True when a path relative to a copy root passes through a runtime-cache directory. */
function isRuntimeCachePath(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => RUNTIME_CACHE_DIRS.includes(segment));
}

/**
 * Recursively copy a committed fixture project — or one of its overlay variants —
 * into a test's own directory, leaving the engine's rebuildable caches behind.
 *
 * Drop-in replacement for `cpSync(src, dest, { recursive: true })` at every site
 * whose source is a committed fixture.
 */
export function copyFixtureTree(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => !isRuntimeCachePath(path.relative(src, from)),
  });
}

/**
 * Promise-returning twin of {@link copyFixtureTree}, for the suites that copy with
 * `cp` from node:fs/promises. Drop-in replacement for
 * `await cp(src, dest, { recursive: true })`.
 */
export async function copyFixtureTreeAsync(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (from) => !isRuntimeCachePath(path.relative(src, from)),
  });
}
