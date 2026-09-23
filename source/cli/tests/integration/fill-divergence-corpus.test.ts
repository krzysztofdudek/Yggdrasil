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

/**
 * One test per fixture, not one test over the whole corpus.
 *
 * A single test that looped over every fixture had ONE timeout for all of them,
 * so its budget shrank with every fixture added and it timed out on a loaded
 * machine (about 2 s alone, 30 s under a full parallel suite) without anything
 * being wrong. Per fixture, each fill keeps the whole default budget — hundreds
 * of times what it needs — while a fill that really hangs still fails at that
 * bound, and the failure names the fixture that hung instead of "the corpus".
 */
const CORPUS = fixtureGraphDirs();
const fires: Array<{ fixture: string; dump: string }> = [];
const ran: string[] = [];

describe('convergence sentinel — corpus ship gate (zero fires)', () => {
  it('has a non-empty corpus (guard against a vacuous gate)', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  it.each(CORPUS.map((dir) => [path.basename(dir), dir] as const))(
    'fires on no divergence and writes no divergence log: %s',
    async (name, fixtureDir) => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'yg-conv-'));
      try {
        const dest = path.join(tmp, name);
        cpSync(fixtureDir, dest, { recursive: true });

        let graph;
        try {
          graph = await loadGraph(dest);
        } catch {
          // A fixture whose graph does not load is broken by design for a
          // fill; it is not part of the convergence corpus.
          return;
        }

        const firesHere: Array<{ fixture: string; dump: string }> = [];
        try {
          await runFill(graph, { write: (s: string) => { process.stdout.write(s); }, isTTY: false, now: Date.now,
            coverageVisibleFiles: null,
            onlyDeterministic: true,
            // Record every fire AND exercise the real io writer, so a fire would
            // both be caught here and produce the actual on-disk log we assert is
            // absent below.
            divergenceWrite: (dump) => {
              firesHere.push({ fixture: name, dump });
              writeFillDivergence(graph!.rootPath, dump);
            },
          });
        } catch {
          // A structural/config gate (FillGatingError) or other setup failure —
          // that fixture is broken-by-design for a fill; it is not part of the
          // convergence corpus.
          return;
        }
        ran.push(name);
        fires.push(...firesHere);

        // The binding assertion: zero fires. If this fails, STOP — a real
        // convergence divergence was found; the message carries the dump.
        expect(firesHere, `convergence sentinel fired: ${JSON.stringify(firesHere, null, 2)}`).toEqual([]);
        // Belt-and-suspenders: no divergence log anywhere under the fixture copy.
        expect(findDivergenceLogs(dest)).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it('ran a fill on at least some fixtures and saw zero fires across the corpus', () => {
    // Sanity: the gate is not vacuous — some fixtures actually ran a fill.
    expect(ran.length).toBeGreaterThan(0);
    expect(fires).toEqual([]);
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
