/**
 * Run-level temp-directory guard (vitest globalSetup).
 *
 * Before any worker starts, this points TMPDIR (and TMP / TEMP) at one fresh
 * directory made for this run, so every os.tmpdir() call in a worker, and in
 * every CLI or git process a test spawns, lands inside it. After the run it
 * lists what is still there, removes the whole directory, and fails the run
 * naming what was left: a test that makes a temp directory must remove it
 * (tests/support/tmpdir.ts does that for you).
 *
 * Two effects. The development container's /tmp no longer grows with every
 * run (it reached 14.6 GB in two days), because nothing a run creates outlives
 * it. And a new leak is caught the run it appears, by name, instead of being
 * found weeks later as a full disk. A run started while another one is going
 * on in the same /tmp sees only its own directory, so it never blames the
 * other run's files.
 *
 * It also removes the module cache vitest itself writes for the run (about
 * 47 MB, a directory with a random 21-character name holding `ssr/`). Vitest
 * 5 creates it under the tmpdir of the moment it starts, before this setup
 * runs, and never removes it: that directory, one per run, was most of the
 * volume in /tmp. It is removed by the exact path the vitest instance reports,
 * never by guessing at names, so another run's cache is never touched.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

/** Entries a run may leave that no test creates: Node's own module compile cache. */
const TOLERATED = new Set(['node-compile-cache']);

const ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * The directory vitest keeps its own transformed-module cache in for this run,
 * when the instance reports one under `outerTmp`. Read through an internal
 * field (`_tmpDir`); if a vitest release renames it, this returns undefined and
 * the cache is simply left as before.
 */
function vitestModuleCacheDir(project: TestProject | undefined, outerTmp: string): string | undefined {
  const dir = (project?.vitest as { _tmpDir?: unknown } | undefined)?._tmpDir;
  if (typeof dir !== 'string') return undefined;
  return path.dirname(dir) === outerTmp && /^[A-Za-z0-9_-]{21}$/.test(path.basename(dir)) ? dir : undefined;
}

export default function setup(project?: TestProject): () => void {
  const outerTmp = tmpdir();
  const runDir = mkdtempSync(path.join(outerTmp, 'yg-vitest-run-'));
  const previous = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = runDir;

  return () => {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    let left: string[] = [];
    try {
      left = readdirSync(runDir).filter((name) => !TOLERATED.has(name)).sort();
    } catch {
      // The directory is already gone: nothing was left.
    }
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const moduleCache = vitestModuleCacheDir(project, outerTmp);
    if (moduleCache !== undefined) rmSync(moduleCache, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (left.length > 0) {
      const shown = left.slice(0, 20).join(', ');
      const more = left.length > 20 ? ` and ${left.length - 20} more` : '';
      throw new Error(
        `The test run left ${left.length} temporary ${left.length === 1 ? 'entry' : 'entries'} behind: ${shown}${more}. ` +
          'They were removed with the run directory, but the test that made them does not clean up. ' +
          'Find it by the prefix (grep the tests for it) and create the directory with makeTempDir from tests/support/tmpdir.ts, or remove it in afterEach/afterAll.',
      );
    }
  };
}
