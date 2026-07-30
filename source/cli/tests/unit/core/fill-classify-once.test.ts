/**
 * runFill classifies the type-level coverage lattice (coverage.type_level) at
 * most ONCE per run. Before this fix, runFill computed the classification once
 * for its own pair-classification steps (validate/verifyLock/GC), then its own
 * final re-check (runCheck) computed it AGAIN from scratch — every uncovered
 * file's content was read twice for one `--approve`. runCheck now accepts an
 * already-computed result (RunCheckOptions.precomputedTypeCoverage) and skips
 * its own classify when one is supplied, instead of always classifying fresh.
 *
 * Isolated into its own file because it mocks core/type-coverage.js (a
 * pass-through counting wrapper — the real implementation still runs, only the
 * call count is observed) — mirroring this suite's own convention of moving a
 * module-mocking test out of a file whose other tests load the same module for
 * real (see type-effective-cascade-guard.test.ts).
 *
 * Real on-disk fixture (tests/fixtures/type-coverage-basic/ — a committed,
 * node-less project authored to exercise this exact classification lattice), a
 * real runFill call. No fixture or verdict data is fabricated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line no-var
var typeCoverageRealFn: (typeof import('../../../src/core/type-coverage.js'))['computeTypeCoverage'] | undefined;
vi.mock('../../../src/core/type-coverage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/type-coverage.js')>();
  typeCoverageRealFn = actual.computeTypeCoverage;
  return {
    ...actual,
    computeTypeCoverage: vi.fn(actual.computeTypeCoverage),
  };
});
import { computeTypeCoverage } from '../../../src/core/type-coverage.js';
const mockComputeTypeCoverage = vi.mocked(computeTypeCoverage);

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');

let tmpDirs: string[] = [];
function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-fill-classify-once-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  mockComputeTypeCoverage.mockClear();
});

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('runFill — classifies coverage.type_level at most once per run', () => {
  it('does not classify a second time for its own final re-check', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);

    await runFill(graph, { coverageVisibleFiles: files, write: () => {} });

    expect(mockComputeTypeCoverage).toHaveBeenCalledTimes(1);
    expect(typeCoverageRealFn).toBeDefined();
  });

  it('--dry-run also classifies only once (the prune preview and the report share it)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);

    await runFill(graph, { coverageVisibleFiles: files, dryRun: true, write: () => {} });

    expect(mockComputeTypeCoverage).toHaveBeenCalledTimes(1);
  });

  it('classifies fresh (once) when coverage.type_level is off — the flag-off path is unaffected', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    graph.config.coverage!.typeLevel = false;

    await runFill(graph, { coverageVisibleFiles: files, write: () => {} });

    expect(mockComputeTypeCoverage).not.toHaveBeenCalled();
  });
});
