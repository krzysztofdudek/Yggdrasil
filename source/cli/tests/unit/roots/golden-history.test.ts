import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHistoryJoin, type HistoryDeps } from '../../../src/roots/history.js';
import { makeLifecycleIndex } from '../../../src/roots/pipeline.js';
import { makeWeightFns } from '../../../src/roots/weights.js';
import { runRootsIndex } from '../../../src/roots/pipeline.js';
import { withBuiltGolden, composeMineInputPieces } from '../helpers/roots-golden-fixture.js';
import { withHistoryDeps } from '../helpers/roots-history-deps.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import { buildTypeScriptGoldenSpec } from '../../fixtures/roots/golden/typescript/spec.js';
import { buildTsxGoldenSpec } from '../../fixtures/roots/golden/tsx/spec.js';
import { buildJavaScriptGoldenSpec } from '../../fixtures/roots/golden/javascript/spec.js';
import { buildPythonGoldenSpec } from '../../fixtures/roots/golden/python/spec.js';
import { buildJavaGoldenSpec } from '../../fixtures/roots/golden/java/spec.js';
import { buildGoGoldenSpec } from '../../fixtures/roots/golden/go/spec.js';
import { buildDataGoldenSpec } from '../../fixtures/roots/golden/data/spec.js';
import type { GoldenRepoSpec } from '../../support/roots-golden.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-history.test.ts — the R4 Task 8 golden suite for
// the `history/` golden specifically (T3's own time-depth fixture, D8):
// unlike the seven landed goldens (uniform w = 1.0 at the day-400 clock),
// this golden's population spans four distinct weight VALUES by
// construction, so its own expectations are derived case by case rather
// than by a single scaling argument (Step 5).
// ---------------------------------------------------------------------------

async function makeTempHistoryDeps(): Promise<{ deps: HistoryDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-golden-history-'));
  return {
    deps: { cacheDir: path.join(dir, 'blobs'), stateDir: path.join(dir, 'history'), ledger: [], dirtyPaths: new Set() },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('history/ golden — acceptance 1: mines a non-empty field with at least one hookEligible fact', () => {
  it('the real pipeline mines a non-empty field, and at least one fact is hookEligible', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      const facts = result.body.partitions.flatMap((p) => p.facts);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.hookEligible === true)).toBe(true);
    });
  });
});

describe("history/ golden — acceptance 2: nTotalRaw excludes the day-395 cohort, by value, on a named method-kind _all cell", () => {
  it("partition _root, surface auto.nameshape, expected 'a' (the sole method-kind _all/dir cell in this suite): nTotalRaw is 277, and the cohort's own antecedent is pinned through the counts map total", async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      const facts = result.body.partitions.flatMap((p) => p.facts);
      const fact = facts.find((f) => f.appliesKind === 'method' && f.roleKey === '_all' && f.surface === 'auto.nameshape' && f.expected === 'a');
      expect(fact).toBeDefined();
      if (!fact) return;

      // nTotalRaw by value: 280 in-domain survivors minus the day-395
      // cohort's 3 members of this SAME cell, hand-derived from spec.ts's
      // own day offsets —
      //   89 "ordinary" (3-method-class) files alive at HEAD x 3 methods = 267
      //     (85 day-0 survivors [88 seeded minus the 3 day-120 scratch
      //     deletions] + 1 day-300 ship.ts + 3 day-60 agent*.ts)
      //   + 10 day-20 deco-new single-function files (1 method each)
      //   + 3 day-395 refund.ts functions (calculateRefund, logRefund,
      //     isEligibleForRefund)
      //   = 280 in-domain method-kind members with a value for this surface
      // minus the day-395 cohort's own 3 members of THIS cell (5 days old
      // at the day-400 clock, 5 < freshPenaltyDays 14 -> counted, never
      // survived) = 277.
      expect(fact.nTotalRaw).toBe(277);

      // The antecedent, pinned so the criterion cannot pass vacuously: the
      // day-395 cohort reached this fact at all, through its own weighted
      // counts (computed over ALL in-domain instances, survived or not) —
      // each of the 3 refund.ts functions weighs the baseFloor 0.05 (5 days
      // old, w_surv = (5/120) x 0.5 = 0.020833, floored), a 0.15 total
      // contribution split by each function's own nameshape:
      // calculateRefund and logRefund both mine 'aUa' (0.10 combined),
      // isEligibleForRefund mines '(aU)+a' (0.05) — neither equal to this
      // cell's own `expected` ('a'), so the cohort is a NON-conformer on
      // this cell: the antecedent must be phrased against the counts map
      // total (asserting the cohort's own weighted values by name) rather
      // than against `counts[expected]`, which would read 0 for a cohort
      // that never conforms here and so could never pin its presence.
      expect(fact.counts['aUa']).toBe('2.6');
      expect(fact.counts['(aU)+a']).toBe('0.05');
    });
  });
});

describe('history/ golden — acceptance 7: two weights asserted BY VALUE (a wrong clock is invisible everywhere else)', () => {
  it('the ship scopes (born day 300, last touched day 380) weigh w_surv = min(1, 20/120) = 0.166667; the day-395 cohort weighs the baseFloor 0.05', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;
        const { units } = await composeMineInputPieces(repoRoot, config);
        const realIndex = makeLifecycleIndex(join.lifecycle);
        const weightFns = makeWeightFns({ lifecycle: realIndex, ledger: [], dirtyPaths: new Set(), clockTs: join.clockTs, config });

        // `ordinaryFile('Ship')`'s own class scope — one of the ship pair's
        // named-body scopes, born day 300, last touched day 380 (T3's own
        // script: 20/120 stable-day ratio, no fresh penalty at age 100 days).
        const shipUnit = units.find((u) => u.relPath === 'src/svc/ship.ts' && u.kind === 'type');
        expect(shipUnit).toBeDefined();
        if (shipUnit) {
          expect(weightFns.baseWeight(shipUnit)).toBeCloseTo(0.166667, 5);
        }

        // `refund.ts`'s three top-level functions — the day-395 cohort, 5
        // days old at the day-400 clock: w_surv = (5/120) * 0.5 = 0.020833,
        // floored to `baseFloor` (0.05).
        const refundUnit = units.find((u) => u.relPath === 'src/svc/refund.ts' && u.kind === 'method' && u.name === 'calculateRefund');
        expect(refundUnit).toBeDefined();
        if (refundUnit) {
          expect(weightFns.baseWeight(refundUnit)).toBeCloseTo(0.05, 5);
        }
      } finally {
        await cleanup();
      }
    });
  });

  it('the day-20 cohort (churned at day 30) weighs w_surv * w_churn = 1 * 0.25 = 0.25', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;
        const { units } = await composeMineInputPieces(repoRoot, config);
        const realIndex = makeLifecycleIndex(join.lifecycle);
        const weightFns = makeWeightFns({ lifecycle: realIndex, ledger: [], dirtyPaths: new Set(), clockTs: join.clockTs, config });

        // `src/deco-new/new0.ts` — born day 20, rewritten (early-churn) day
        // 30: 30 - 20 = 10 <= churnEarlyDays (14) ⇒ churned_early ⇒
        // w_churn = 0.25; never touched again, so stable_days = 370/120
        // saturates at 1, and age_days = 380 >= freshPenaltyDays.
        const unit = units.find((u) => u.relPath === 'src/deco-new/new0.ts' && u.kind === 'method');
        expect(unit).toBeDefined();
        if (unit) {
          expect(weightFns.baseWeight(unit)).toBeCloseTo(0.25, 5);
        }
      } finally {
        await cleanup();
      }
    });
  });
});

describe('history/ golden — acceptance 9: agentShare distinguishes an empty population from a zero share (MR-29)', () => {
  const sevenLandedGoldens: [string, GoldenRepoSpec][] = [
    ['typescript', buildTypeScriptGoldenSpec()],
    ['tsx', buildTsxGoldenSpec()],
    ['javascript', buildJavaScriptGoldenSpec()],
    ['python', buildPythonGoldenSpec()],
    ['java', buildJavaGoldenSpec()],
    ['go', buildGoGoldenSpec()],
    ['data', buildDataGoldenSpec()],
  ];

  for (const [name, spec] of sevenLandedGoldens) {
    it(`${name}: agentShare is null — nothing is first seen in the clock's trailing 120 days (every scope born day 0, clock at day 400)`, async () => {
      const config = await defaultRootsConfig();
      await withBuiltGolden(spec, async (repoRoot) => {
        const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
        expect(result.body.agentShare).toBeNull();
      });
    });
  }

  it('history: agentShare is exactly 0 — the ship scopes (day 300) and the day-395 cohort put a non-empty population inside the window, and neither is agent-authored', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      expect(result.body.agentShare).toBe(0);
    });
  });

  it('no serialized value is ever NaN (a serialized NaN is indistinguishable from null and would hide a real bug)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      const serialized = JSON.stringify(result.body);
      expect(serialized.includes('NaN')).toBe(false);
      expect(Number.isNaN(result.body.agentShare)).toBe(false);
    });
  });
});
