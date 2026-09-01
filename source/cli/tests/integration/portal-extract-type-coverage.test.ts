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
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const NEEDS_NODE_CONTEXT = path.join(BASE_FIXTURE, 'variants', 'needs-node-context');
// Two independent deterministic aspects (no-todo, no-fixme) on ONE classifying type, no
// node of its own — src/leaf.ts ships a TODO but no FIXME, so no-todo genuinely refuses it
// while no-fixme genuinely verifies it: a real multi-pair fold, not a fabricated one.
const PORTAL_TWO_PAIRS = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-two-pairs');
// The one committed fixture with coverage.type_level on that also carries a type (`lib`)
// with zero aspects at all — its one type-covered file (src/lib/util.ts) is the ABSENT-
// pairState case: enforced === false, so `pairState` must never be computed for it.
const PORTAL_TYPE_COVERAGE = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-type-coverage');

function mergedFixtureCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-typecov-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  return dir;
}

function needsNodeContextCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-typecov-unverified-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(NEEDS_NODE_CONTEXT, dir, { recursive: true });
  return dir;
}

function portalTwoPairsCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-two-pairs-'));
  cpSync(PORTAL_TWO_PAIRS, dir, { recursive: true });
  return dir;
}

function portalTypeCoverageCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-typecov-unenforced-'));
  cpSync(PORTAL_TYPE_COVERAGE, dir, { recursive: true });
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

  // F2: `residue.typeCovered[].enforced` names architecture-level status,
  // never a recorded verdict — the portal's own residue ledger must carry
  // the same lock-derived "no recorded verdict" fact `yg check`, `yg owner
  // --file`, and `yg context --file` already carry for the identical pair.
  it('residue.typeCovered marks a nodeless pair with no recorded lock entry as unverified, on a cold, never-filled project', async () => {
    const dir = needsNodeContextCopy();
    try {
      const data = await extractPortalData(dir, { writeEnabled: false });
      const crashy = data.residue.typeCovered.find((f) => f.path === 'src/crashy/a.ts');
      expect(crashy).toBeDefined();
      expect(crashy!.enforced).toBe(true);
      expect(crashy!.pairState).toBe('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the unverified caveat disappears once a real fill writes a verdict, but stays for a pair that fails closed on every attempt', async () => {
    const dir = needsNodeContextCopy();
    try {
      const before = await extractPortalData(dir, { writeEnabled: false });
      const leafBefore = before.residue.typeCovered.find((f) => f.path === 'src/leaf/a.ts');
      expect(leafBefore).toBeDefined();
      expect(leafBefore!.enforced).toBe(true);
      expect(leafBefore!.pairState).toBe('unverified');

      const binPath = path.join(CLI_ROOT, 'dist', 'bin.js');
      spawnSync('node', [binPath, 'check', '--approve', '--only-deterministic'], { cwd: dir, encoding: 'utf-8' });

      const after = await extractPortalData(dir, { writeEnabled: false });
      // src/crashy/a.ts fails closed every attempt (needs-node-context's own
      // check.mjs reads ctx.node unconditionally) — no verdict is EVER
      // written for it, so it stays unverified after a real fill attempt.
      const crashyAfter = after.residue.typeCovered.find((f) => f.path === 'src/crashy/a.ts');
      expect(crashyAfter!.pairState).toBe('unverified');
      // src/leaf/a.ts's own-file-rule genuinely fills — the caveat disappears
      // once the lock actually holds a recorded verdict for it.
      const leafAfter = after.residue.typeCovered.find((f) => f.path === 'src/leaf/a.ts');
      expect(leafAfter!.pairState).toBe('verified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The ledger must call a STALE recorded verdict unverified too, not only a
  // missing one: a source edit after the fill above invalidates the stored
  // hash without touching the lock. `yg check` re-verifies the current file
  // against the stored hash and would call this pair unverified again on the
  // identical edit; the portal's ledger — which already runs that same full
  // verification for every other count it reports — must agree, not keep
  // reporting the pre-edit "verdict on record" state from presence alone.
  it('the unverified flag reappears after a real source edit invalidates an already-recorded verdict', async () => {
    const dir = needsNodeContextCopy();
    try {
      const binPath = path.join(CLI_ROOT, 'dist', 'bin.js');
      spawnSync('node', [binPath, 'check', '--approve', '--only-deterministic'], { cwd: dir, encoding: 'utf-8' });

      const filled = await extractPortalData(dir, { writeEnabled: false });
      const leafFilled = filled.residue.typeCovered.find((f) => f.path === 'src/leaf/a.ts');
      expect(leafFilled!.pairState).toBe('verified');

      const leafPath = path.join(dir, 'src', 'leaf', 'a.ts');
      writeFileSync(leafPath, readFileSync(leafPath, 'utf-8') + '\n// a later, unapproved edit\n');

      const stale = await extractPortalData(dir, { writeEnabled: false });
      const leafStale = stale.residue.typeCovered.find((f) => f.path === 'src/leaf/a.ts');
      expect(leafStale!.pairState).toBe('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE TRAP: `worstPairState`'s reduce seeds at 'verified', so folding an EMPTY pair-state
  // list for a file would silently return 'verified' — fabricated green. A single type-covered
  // file with TWO independent pairs (one refused, one verified) is the real-world shape that
  // exercises the non-empty fold; `pairState` must read the WORST of the two, not the seed and
  // not whichever pair happened to be indexed last.
  it('a multi-pair type-covered file folds worst-state-wins and carries reasons', async () => {
    const dir = portalTwoPairsCopy();
    try {
      const binPath = path.join(CLI_ROOT, 'dist', 'bin.js');
      spawnSync('node', [binPath, 'check', '--approve', '--only-deterministic'], { cwd: dir, encoding: 'utf-8' });

      const data = await extractPortalData(dir, { writeEnabled: false });
      // `computeExpectedPairs` sorts pairs by (aspectId, unitKey) — 'no-fixme' sorts before
      // 'no-todo'. For src/leaf.ts that puts its refused pair (no-todo) LAST in iteration
      // order; for src/leaf2.ts (FIXME, no TODO) it puts its refused pair (no-fixme) FIRST.
      // Asserting both files pins the fold as genuine worst-state-wins: a naive "last write
      // wins" implementation would still pass on src/leaf.ts alone (refused happens to be
      // last there) but would wrongly read 'verified' on src/leaf2.ts (refused is first,
      // verified is last there).
      const leaf = data.residue.typeCovered.find((f) => f.path === 'src/leaf.ts');
      expect(leaf).toBeDefined();
      expect(leaf!.enforced).toBe(true);
      expect(leaf!.pairState).toBe('refused'); // refused (no-todo, iterated LAST) beats the sibling verified (no-fixme)
      expect(leaf!.reasons?.some((r) => r.includes('TODO'))).toBe(true);

      const leaf2 = data.residue.typeCovered.find((f) => f.path === 'src/leaf2.ts');
      expect(leaf2).toBeDefined();
      expect(leaf2!.enforced).toBe(true);
      expect(leaf2!.pairState).toBe('refused'); // refused (no-fixme, iterated FIRST) beats the sibling verified (no-todo)
      expect(leaf2!.reasons?.some((r) => r.includes('FIXME'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE GUARD's other half: an UNENFORCED type-covered file (matched a type, but that type's
  // cascade carries no aspect at all — zero nodeless pairs by construction) must never reach
  // `worstPairState` at all. `pairState` is ABSENT for it, not a computed 'verified' from an
  // empty fold and not a stale 'unverified' either — there is no pair to have an opinion about.
  it('an unenforced type-covered file has NO pairState', async () => {
    const dir = portalTypeCoverageCopy();
    try {
      const data = await extractPortalData(dir, { writeEnabled: false });
      const util = data.residue.typeCovered.find((f) => f.path === 'src/lib/util.ts');
      expect(util).toBeDefined();
      expect(util!.enforced).toBe(false);
      expect(util!.pairState).toBeUndefined();
      expect(util!.reasons).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
