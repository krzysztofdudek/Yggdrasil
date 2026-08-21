import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunRootsIndexOptions } from '../../../src/roots/pipeline.js';

// =============================================================================
// tests/unit/helpers/roots-history-deps.ts — the R4 Task 8 golden-suite
// counterpart to roots-config.ts/roots-golden-fixture.ts: builds the
// `historyDeps` a real `runRootsIndex` call needs to take the four-argument
// (history-fed) form, over a fresh per-call temporary cache directory
// (created and removed by the caller's own `finally`, never shared BETWEEN
// tests). An empty `ledger` and an empty `dirtyPaths` — every golden suite
// call site uses both empty, exercising the real weight machinery over a
// real walk without a ledger mark or a dirty working tree to additionally
// account for.
// =============================================================================

/** Build a fresh temp `historyDeps` root, run `fn` with the resulting `RunRootsIndexOptions`, then remove the temp directory regardless of outcome. */
export async function withHistoryDeps<T>(fn: (options: RunRootsIndexOptions) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-deps-'));
  try {
    return await fn({
      historyDeps: {
        cacheDir: path.join(dir, 'blobs'),
        stateDir: path.join(dir, 'history'),
        ledger: [],
        dirtyPaths: new Set(),
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The bare `RunRootsIndexOptions` for a SHARED cache directory across more than one `runRootsIndex` call — the determinism control's own cold-then-warm pair (`golden-controls.test.ts`), which needs the second call to see the first's cache writes. The caller owns the temp directory's lifecycle (create before, remove after both calls). */
export function historyDepsFor(dir: string): RunRootsIndexOptions {
  return {
    historyDeps: {
      cacheDir: path.join(dir, 'blobs'),
      stateDir: path.join(dir, 'history'),
      ledger: [],
      dirtyPaths: new Set(),
    },
  };
}
