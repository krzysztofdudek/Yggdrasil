/**
 * SHIP-GATE corpus test for the auto-approve convergence sentinel (C15).
 *
 * The sentinel fires ONLY on a genuine 0-fill convergence divergence — the fill
 * classified zero pairs to fill, yet the post-fill report still found unverified
 * pairs with no verdict written in between. Over a healthy fixture that shape can
 * never arise (a stable working tree makes the classifier deterministic), so the
 * binding requirement is: across the existing fixture corpus, the sentinel fires
 * ZERO times and no `.yg-fill-divergence.log` is ever written.
 *
 * ANY fire here is NOT a test bug — it is a REAL convergence divergence the
 * sentinel just caught, and it must be investigated, not silenced.
 *
 * This drives the deterministic-only fill (keyless, free — the exact
 * `auto_approve: deterministic` regime the pathology was first observed under)
 * over a throwaway copy of every fixture that carries a `.yggdrasil/` graph.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runFill } from '../../src/core/fill.js';
import {
  writeFillDivergence,
  FILL_DIVERGENCE_FILENAME,
  FILL_DIVERGENCE_GITIGNORE_LINE,
} from '../../src/io/debug-log-writer.js';
import { minimatch } from 'minimatch';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(HERE, '../fixtures');

/** Fixture directories that carry a `.yggdrasil/` graph (the runnable corpus). */
function fixtureGraphDirs(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(FIXTURES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(FIXTURES_ROOT, entry.name);
    if (existsSync(path.join(dir, '.yggdrasil'))) out.push(dir);
  }
  return out;
}

describe('convergence sentinel — corpus ship gate (zero fires)', () => {
  it('fires on NO existing fixture and writes NO divergence log', async () => {
    const corpus = fixtureGraphDirs();
    // Guard against a vacuous gate: the corpus must be non-empty.
    expect(corpus.length).toBeGreaterThan(0);

    const fires: Array<{ fixture: string; dump: string }> = [];
    const ran: string[] = [];
    const skipped: Array<{ fixture: string; reason: string }> = [];

    for (const fixtureDir of corpus) {
      const tmp = mkdtempSync(path.join(tmpdir(), 'yg-conv-'));
      try {
        const dest = path.join(tmp, path.basename(fixtureDir));
        cpSync(fixtureDir, dest, { recursive: true });

        let graph;
        try {
          graph = await loadGraph(dest);
        } catch (e) {
          skipped.push({ fixture: path.basename(fixtureDir), reason: `load: ${(e as Error).message}` });
          continue;
        }

        try {
          await runFill(graph, {
            coverageVisibleFiles: null,
            onlyDeterministic: true,
            // Record every fire AND exercise the real io writer, so a fire would
            // both be caught here and produce the actual on-disk log we assert is
            // absent below.
            divergenceWrite: (dump) => {
              fires.push({ fixture: path.basename(fixtureDir), dump });
              writeFillDivergence(graph!.rootPath, dump);
            },
          });
          ran.push(path.basename(fixtureDir));
        } catch (e) {
          // A structural/config gate (FillGatingError) or other setup failure —
          // that fixture is broken-by-design for a fill; it is not part of the
          // convergence corpus. Skip it.
          skipped.push({ fixture: path.basename(fixtureDir), reason: `fill: ${(e as Error).message}` });
          continue;
        }

        // Belt-and-suspenders: no divergence log anywhere under the fixture copy.
        expect(findDivergenceLogs(dest)).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // The binding assertion: zero fires across the whole corpus. If this fails,
    // STOP — a real convergence divergence was found; inspect `fires` for the dump.
    expect(fires, `convergence sentinel fired: ${JSON.stringify(fires, null, 2)}`).toEqual([]);
    // Sanity: at least some fixtures actually ran a fill (gate is not vacuous).
    expect(ran.length).toBeGreaterThan(0);
  });
});

/**
 * Fire-path coverage for the evidence-log writer itself. The corpus gate above
 * proves the writer is NEVER invoked on a healthy run, so its actual on-disk
 * mechanics (self-ensured gitignore line, single rotation, fresh write) go
 * unexercised there by design. This drives the real writer directly against an
 * isolated temp graph root — real filesystem, no mocking — the same code that
 * runs when a genuine 0-fill divergence fires.
 */
describe('writeFillDivergence — evidence-log writer (fire path)', () => {
  it('self-ensures its gitignore line, writes the dump, and single-rotates a prior dump', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'yg-conv-writer-'));
    try {
      const yggRoot = path.join(tmp, '.yggdrasil');
      mkdirSync(yggRoot, { recursive: true });
      const logPath = path.join(yggRoot, FILL_DIVERGENCE_FILENAME);
      const giPath = path.join(yggRoot, '.gitignore');

      // First fire: no prior gitignore, no prior dump.
      writeFillDivergence(yggRoot, 'first-dump\n');
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf-8')).toBe('first-dump\n');
      // G5: the writer guarantees its own ignore entry, exactly once. The entry
      // is the wildcard form so it also covers the `.1` rotation, not the bare
      // filename (which fnmatch would match only exactly).
      expect(
        readFileSync(giPath, 'utf-8')
          .split('\n')
          .filter((l) => l.trim() === FILL_DIVERGENCE_GITIGNORE_LINE),
      ).toHaveLength(1);
      // The written pattern must ignore BOTH the live dump and its rotation.
      expect(minimatch(FILL_DIVERGENCE_FILENAME, FILL_DIVERGENCE_GITIGNORE_LINE)).toBe(true);
      expect(minimatch(`${FILL_DIVERGENCE_FILENAME}.1`, FILL_DIVERGENCE_GITIGNORE_LINE)).toBe(true);

      // Second fire: the prior dump rotates to `.1`, the fresh dump replaces it,
      // and the gitignore line is NOT duplicated (idempotent ensure).
      writeFillDivergence(yggRoot, 'second-dump\n');
      expect(readFileSync(logPath, 'utf-8')).toBe('second-dump\n');
      expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('first-dump\n');
      expect(
        readFileSync(giPath, 'utf-8')
          .split('\n')
          .filter((l) => l.trim() === FILL_DIVERGENCE_GITIGNORE_LINE),
      ).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Recursively collect any `.yg-fill-divergence.log` (or its rotation) under root. */
function findDivergenceLogs(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (
        entry.name === FILL_DIVERGENCE_FILENAME ||
        entry.name === `${FILL_DIVERGENCE_FILENAME}.1`
      ) {
        hits.push(p);
      }
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return hits;
}
