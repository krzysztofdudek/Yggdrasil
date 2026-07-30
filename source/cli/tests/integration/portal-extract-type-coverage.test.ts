/**
 * Portal extraction's count-parity invariant, specifically for a project with
 * coverage.type_level on: `meta.counts.pairsTotal` (and the verified/refused/
 * unverified/advisoryRefused split) must count the SAME universe `yg check`
 * counts — including a file enforced by its architecture type alone, with no
 * owning component. Before this file's fix, extractPortalData computed NO
 * type-coverage classification at all, so runPortalCheck / readAndVerifyLock /
 * computePortalPairs all silently answered about a component-only universe
 * whenever the tier was on — this repo's own portal-extract.test.ts can't catch
 * that (this repo's own coverage.type_level is off), so this is a SEPARATE
 * fixture with the tier genuinely on.
 *
 * Real committed fixture (tests/fixtures/type-level-engine/ merged with its
 * two-covered-files variant, per this suite's own established convention —
 * see tests/unit/core/fill-det.test.ts and tests/e2e/cli-type-coverage-fill.test.ts),
 * copied to a throwaway mkdtemp per test. No fabricated pair data: the oracle
 * below calls the SAME engine functions extractPortalData reuses, directly.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPortalData } from '../../src/portal/extract.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { computeExpectedPairs } from '../../src/core/pairs.js';
import { computeTypeCoverage } from '../../src/core/type-coverage.js';
import { FileContentCache } from '../../src/io/file-content-cache.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { scanUncoveredFiles } from '../../src/core/check.js';
import { FIXTURE_TWO_COVERED_FILES } from '../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

function mergedFixtureCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-typecov-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  return dir;
}

describe('portal extraction — type-level coverage threading', () => {
  it("meta.counts counts componentless file-level pairs too, not a component-only universe", async () => {
    const dir = mergedFixtureCopy();
    try {
      const data = await extractPortalData(dir, { writeEnabled: false });

      // Independent oracle — classify + enumerate directly, mirroring runCheck's
      // own once-per-run classification, never reusing extractPortalData's own
      // internal call.
      const graph = await loadGraph(dir);
      const gitFiles = await walkRepoFiles(dir);
      const uncovered = scanUncoveredFiles(graph, gitFiles);
      const classified = await computeTypeCoverage(graph, uncovered, new FileContentCache());
      const typeCoverage = {
        covered: classified.covered,
        ambiguousPaths: classified.ambiguous.map((a) => a.file),
      };
      const fullUniverse = await computeExpectedPairs(graph, { typeCoverage });
      const componentOnlyUniverse = await computeExpectedPairs(graph);

      // Sanity: this fixture genuinely has componentless pairs (src/leaf/{a,b}.ts
      // via refuses-on-a + llm-leaf-rule, among others) — otherwise the identity
      // below would hold vacuously whether or not threading happened at all.
      expect(fullUniverse.pairs.length).toBeGreaterThan(componentOnlyUniverse.pairs.length);

      expect(data.meta.counts.pairsTotal).toBe(fullUniverse.pairs.length);
      expect(
        data.meta.counts.verified +
          data.meta.counts.refused +
          data.meta.counts.unverified +
          data.meta.counts.advisoryRefused,
      ).toBe(fullUniverse.pairs.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
