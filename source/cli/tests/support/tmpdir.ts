/**
 * One way for a test to get a temporary directory that is removed for it.
 *
 * `makeTempDir(prefix)` creates the directory under os.tmpdir() and records it;
 * tests/setup.ts registers `cleanupTempDirs()` as an afterAll hook for every
 * test file, so a directory made here is gone when its file finishes, whether
 * or not the test remembered to remove it. A test that wants it gone sooner
 * (per test, to keep a large fixture from piling up) calls `cleanupTempDirs()`
 * itself or removes the directory; removing one twice is harmless.
 *
 * Why it exists: tests that call mkdtempSync and never remove the result filled
 * the development container's /tmp with tens of thousands of directories. The
 * run-level guard (tests/support/global-tmpdir.ts) names any test that still
 * leaves something behind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const created = new Set<string>();

/** Create a fresh directory under os.tmpdir(), removed when the test file finishes. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/** Remove every directory made through makeTempDir in this worker so far. */
export function cleanupTempDirs(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best effort: whatever is left is named by the run-level guard.
    }
  }
  created.clear();
}
