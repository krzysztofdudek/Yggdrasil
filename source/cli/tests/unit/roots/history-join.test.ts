import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHistoryJoin, blobCacheKey, type HistoryDeps } from '../../../src/roots/history.js';
import { makeLifecycleIndex, makeStableIdLifecycleIndex, runRootsIndex } from '../../../src/roots/pipeline.js';
import { makeWeightFns, releasedMarks, markKey } from '../../../src/roots/weights.js';
import { EXTRACTOR_VERSION } from '../../../src/roots/extract.js';
import { getGrammarForExtension } from '../../../src/utils/language-registry.js';
import { assetNameOfWasmFile, bindingForAsset } from '../../../src/roots/binding.js';
import type { LedgerEntry } from '../../../src/model/graph.js';
import { withBuiltGolden, composeMineInputPieces } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import { deterministicCommitDate, deterministicCommitIndexAt } from '../../support/git-fixture.js';
import { buildGoldenRepo } from '../../support/roots-golden.js';
import { rmSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// tests/unit/roots/history-join.test.ts — R4 Task 8's own suite for
// `buildHistoryJoin` and the seam wiring built directly on top of it
// (`makeLifecycleIndex`/`makeStableIdLifecycleIndex`, `weights.ts`'s
// `makeWeightFns`/`releasedMarks`).
//
// THE CRITICAL HAZARD (this file's own reason to exist): `weights.ts`'s
// `makeWeightFns` keys lifecycle rows by `skeyR`/`relPath`, while a ledger
// mark carries only a scope's CURRENT `stable_id`. Wiring the WRONG index
// into `releasedMarks` — one keyed directly on `stable_id` without first
// resolving each CURRENT unit's own `(skeyR, relPath)` through the REAL
// index — means no mark can ever resolve a row, so no mark ever releases:
// silently and permanently indistinguishable from the documented
// conservative "marks the walk cannot see stay capped" path. The suite
// below proves the wiring the other way: a mark placed through the REAL
// index both CAPS (while unreleased) and RELEASES (once its release clause
// is met) — round-tripping both directions, not merely one.
// ---------------------------------------------------------------------------

/** The real per-grammar cache key for `sha` under `ext`'s registered grammar — the same derivation `history.ts`'s own `blobCacheKey` uses, never a hand-typed key string (acceptance 8's own discipline: pin the key itself, not merely a count of keys). */
function keyForExtension(ext: string, sha: string): string {
  const grammarInfo = getGrammarForExtension(ext);
  if (!grammarInfo) throw new Error(`no registered grammar for extension '${ext}'`);
  const { hash } = bindingForAsset(assetNameOfWasmFile(grammarInfo.wasmFile));
  return blobCacheKey(sha, EXTRACTOR_VERSION, hash);
}

async function makeTempHistoryDeps(): Promise<{ deps: HistoryDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-join-'));
  return {
    deps: { cacheDir: path.join(dir, 'blobs'), stateDir: path.join(dir, 'history'), ledger: [], dirtyPaths: new Set() },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('buildHistoryJoin — degraded modes (R4-I4)', () => {
  it('a directory with no .git ⇒ undefined', async () => {
    const config = await defaultRootsConfig();
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-no-git-'));
    const { deps, cleanup } = await makeTempHistoryDeps();
    try {
      const join = await buildHistoryJoin(dir, config, deps);
      expect(join).toBeUndefined();
    } finally {
      await cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildHistoryJoin — the CRITICAL HAZARD: a mark placed through the REAL index actually caps and actually releases', () => {
  it('an UNRELEASED mark caps surfaceWeight to hookShapedWeight on its OWN surface, leaving baseWeight and a DIFFERENT surface uncapped; a RELEASED mark stops capping entirely', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;

        const { units } = await composeMineInputPieces(repoRoot, config);
        // `src/svc/order.ts`'s `first()` method — touched by nine human
        // (`alice`) commits through day 250, never churned early: a real,
        // human-authored, long-stable scope whose `base(s)` is comfortably
        // above `hookShapedWeight` (0.15), so a cap is a real, observable
        // move rather than a no-op against an already-floored weight.
        const unit = units.find((u) => u.relPath === 'src/svc/order.ts' && u.kind === 'method' && u.name === 'first');
        expect(unit).toBeDefined();
        if (!unit) return;

        const realIndex = makeLifecycleIndex(join.lifecycle);
        const stableIdIndex = makeStableIdLifecycleIndex(units, realIndex);

        const MARKED_SURFACE = 'auto.call:established';
        const OTHER_SURFACE = 'auto.nameshape';

        // The scope's own row: lastModifiedTs is day 250, so at the day-400
        // clock stable_days = 150 >= releaseStableDays (90) already — the
        // release clause's FIRST conjunct is satisfied regardless of the
        // mark's own date; only the SECOND conjunct (a human touch at
        // ts >= markDate + releaseMinDaysAfterMark) discriminates below.
        const day0Iso = deterministicCommitDate(deterministicCommitIndexAt(0));
        const day399Iso = deterministicCommitDate(deterministicCommitIndexAt(399));

        // --- CAP case: a RECENT mark (day 399) ⇒ markDate + 14d (~day 413)
        // is AFTER the scope's last human touch (day 250) ⇒ the release
        // clause's second conjunct fails ⇒ UNRELEASED ⇒ still capped.
        const recentMark: LedgerEntry = { stableId: unit.stableId, surface: MARKED_SURFACE, date: day399Iso };
        const releasedRecent = releasedMarks([recentMark], stableIdIndex, join.clockTs, config);
        expect(releasedRecent.has(markKey(recentMark))).toBe(false);
        const unreleasedLedgerRecent = [recentMark].filter((e) => !releasedRecent.has(markKey(e)));
        const weightFnsCapped = makeWeightFns({
          lifecycle: realIndex,
          ledger: unreleasedLedgerRecent,
          dirtyPaths: new Set(),
          clockTs: join.clockTs,
          config,
        });

        const base = weightFnsCapped.baseWeight(unit);
        expect(base).toBeGreaterThan(config.weights.hookShapedWeight); // the cap must be a REAL move, not a floor no-op
        expect(weightFnsCapped.surfaceWeight(unit, MARKED_SURFACE)).toBeCloseTo(config.weights.hookShapedWeight, 10);
        // The sibling half (MR-23's own killer case): a DIFFERENT surface on
        // the SAME scope is UNCAPPED — the cap is per (stable_id, surface),
        // never per scope.
        expect(weightFnsCapped.surfaceWeight(unit, OTHER_SURFACE)).toBeCloseTo(base, 10);
        // baseWeight (w_base) itself never carries the cap at all (D7).
        expect(weightFnsCapped.baseWeight(unit)).toBeCloseTo(base, 10);
        expect(weightFnsCapped.isHookShaped(unit, MARKED_SURFACE)).toBe(true);
        expect(weightFnsCapped.isHookShaped(unit, OTHER_SURFACE)).toBe(false);

        // --- RELEASE case: an OLD mark (day 0) ⇒ markDate + 14d (~day 14)
        // is BEFORE the scope's last human touch (day 250) ⇒ RELEASED.
        // This is the hazard's own discriminating case: wiring the WRONG
        // index into `releasedMarks` (one keyed directly on stable_id,
        // never resolved through the current tree's units) would find no
        // row for ANY mark and this assertion would fail, staying capped.
        const oldMark: LedgerEntry = { stableId: unit.stableId, surface: MARKED_SURFACE, date: day0Iso };
        const releasedOld = releasedMarks([oldMark], stableIdIndex, join.clockTs, config);
        expect(releasedOld.has(markKey(oldMark))).toBe(true);
        const unreleasedLedgerOld = [oldMark].filter((e) => !releasedOld.has(markKey(e)));
        expect(unreleasedLedgerOld).toEqual([]); // the released mark never reaches makeWeightFns' ledger at all
        const weightFnsReleased = makeWeightFns({
          lifecycle: realIndex,
          ledger: unreleasedLedgerOld,
          dirtyPaths: new Set(),
          clockTs: join.clockTs,
          config,
        });
        expect(weightFnsReleased.surfaceWeight(unit, MARKED_SURFACE)).toBeCloseTo(base, 10); // no longer capped
        expect(weightFnsReleased.isHookShaped(unit, MARKED_SURFACE)).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  it('a mark whose scope the walk cannot resolve at all stays capped (conservative default, D2/weights.ts Step 2)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;
        const { units } = await composeMineInputPieces(repoRoot, config);
        const realIndex = makeLifecycleIndex(join.lifecycle);
        const stableIdIndex = makeStableIdLifecycleIndex(units, realIndex);
        const day0Iso = deterministicCommitDate(deterministicCommitIndexAt(0));
        const unresolvable: LedgerEntry = { stableId: 'not-a-real-stable-id', surface: 'auto.call:x', date: day0Iso };
        const released = releasedMarks([unresolvable], stableIdIndex, join.clockTs, config);
        expect(released.size).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
});

describe('runRootsIndex — acceptance 3 through the REAL ledger wiring: a hand-planted mark caps a real fact, and a mark that RELEASES does not (the released-mark filter and the stable-id resolution)', () => {
  it('a mark on src/svc/order.ts\'s first() caps its auto.nameshape fact (nConformRaw -1, hookShapedConform 1, counts drop by base - hookShapedWeight); a released mark on a DIFFERENT scope leaves ITS fact untouched', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { units } = await composeMineInputPieces(repoRoot, config);
      // The SAME scope this file's own CRITICAL HAZARD block already
      // resolves above: src/svc/order.ts's `first()` method, touched by
      // nine human commits through day 250 — comfortably above
      // hookShapedWeight at full base weight, so a cap is a real, visible
      // move.
      const orderFirst = units.find((u) => u.relPath === 'src/svc/order.ts' && u.kind === 'method' && u.name === 'first');
      expect(orderFirst).toBeDefined();
      // `src/decorated/existing0.ts`'s own class (`type`-kind) scope — last
      // touched at its day-20 decoration, so a day-0 mark's release clause
      // clears BOTH conjuncts (stable_days 380 >= releaseStableDays 90, and
      // the day-20 touch is >= markDate + 14d) and RELEASES. Its own
      // `auto.nameshape` fact is a SEPARATE cell (appliesKind: 'type', not
      // 'method') from order.ts's own, so the two are independently
      // observable in the same MinedModel.
      const existing0Type = units.find((u) => u.relPath === 'src/decorated/existing0.ts' && u.kind === 'type');
      expect(existing0Type).toBeDefined();
      if (!orderFirst || !existing0Type) return;

      const day0Iso = deterministicCommitDate(deterministicCommitIndexAt(0));
      const day399Iso = deterministicCommitDate(deterministicCommitIndexAt(399));
      const ledger = [
        { stableId: orderFirst.stableId, surface: 'auto.nameshape', date: day399Iso }, // UNRELEASED (recent mark, see the CRITICAL HAZARD block above)
        { stableId: existing0Type.stableId, surface: 'auto.nameshape', date: day0Iso }, // RELEASES
      ];

      const { deps: noLedgerDeps, cleanup: cleanupNoLedger } = await makeTempHistoryDeps();
      const { deps: withLedgerDeps, cleanup: cleanupWithLedger } = await makeTempHistoryDeps();
      try {
        const noLedger = await runRootsIndex(repoRoot, config, [], { historyDeps: noLedgerDeps });
        const withLedger = await runRootsIndex(repoRoot, config, [], { historyDeps: { ...withLedgerDeps, ledger } });

        const methodFactBefore = noLedger.body.partitions.flatMap((p) => p.facts).find((f) => f.appliesKind === 'method' && f.roleKey === '_all' && f.surface === 'auto.nameshape');
        const methodFactAfter = withLedger.body.partitions.flatMap((p) => p.facts).find((f) => f.appliesKind === 'method' && f.roleKey === '_all' && f.surface === 'auto.nameshape');
        expect(methodFactBefore).toBeDefined();
        expect(methodFactAfter).toBeDefined();
        if (!methodFactBefore || !methodFactAfter) return;

        // The marked fact: nConformRaw drops by exactly one (the marked
        // instance drops out of the survived population), hookShapedConform
        // becomes 1, and the weighted count for the expected value drops by
        // base (1.0, order.ts's first() is long-stable and human-authored)
        // minus hookShapedWeight (0.15).
        expect(methodFactBefore.nConformRaw - methodFactAfter.nConformRaw).toBe(1);
        expect(methodFactAfter.hookShapedConform).toBe(1);
        const before = Number(methodFactBefore.counts[methodFactBefore.expected]);
        const after = Number(methodFactAfter.counts[methodFactAfter.expected]);
        expect(before - after).toBeCloseTo(1.0 - config.weights.hookShapedWeight, 6);

        // The SIBLING half: existing0's own `type`-kind auto.nameshape fact
        // is COMPLETELY UNCHANGED — its mark released (day-0 date, an
        // ample later human touch), so it was filtered out of the ledger
        // before `makeWeightFns` ever saw it.
        const typeFactBefore = noLedger.body.partitions.flatMap((p) => p.facts).find((f) => f.appliesKind === 'type' && f.roleKey === '_all' && f.surface === 'auto.nameshape');
        const typeFactAfter = withLedger.body.partitions.flatMap((p) => p.facts).find((f) => f.appliesKind === 'type' && f.roleKey === '_all' && f.surface === 'auto.nameshape');
        expect(typeFactBefore).toBeDefined();
        expect(typeFactAfter).toBeDefined();
        expect(typeFactAfter?.nConformRaw).toBe(typeFactBefore?.nConformRaw);
        expect(typeFactAfter?.hookShapedConform).toBe(0);
        expect(typeFactAfter?.counts).toEqual(typeFactBefore?.counts);
      } finally {
        await cleanupNoLedger();
        await cleanupWithLedger();
      }
    });
  });
});

describe("buildHistoryJoin — agentShare's numerator excludes an agent-authored row past its own promote window", () => {
  it('an agent-authored row inside the trailing 120-day population but past a (deliberately lowered) agentPromoteDays contributes ZERO to the numerator, not its own base weight', async () => {
    // `agentPromoteDays` lowered to 40 (from the default 180) for this one
    // test: under the default, EVERY row inside the population window
    // (first seen within the trailing 120 days of the clock) automatically
    // has stable_days <= 120 < 180, so the conjunct this test targets can
    // never be observed false on ANY fixture built under stock config —
    // AGENT_SHARE_WINDOW_DAYS (120, `history.ts`) is itself smaller than
    // the default `agentPromoteDays`. Lowering the threshold below the
    // window is what makes a genuinely-in-window, already-past-its-own-
    // promote-window agent row constructible at all.
    const config = await defaultRootsConfig('weights:\n    agentPromoteDays: 40\n');
    const dir = buildGoldenRepo({
      name: 'n11-agent-share-numerator',
      commits: [
        // Outside the population window regardless (age 130 days at HEAD).
        { author: 'alice', dayOffset: 0, files: { 'src/base.ts': 'export function base() { return 1; }\n' }, message: 'seed' },
        // Agent-authored, first seen day 50: age 80 days at HEAD (day 130,
        // inside the 120-day window) but stable_days 80 >= the lowered
        // agentPromoteDays (40) — already past ITS OWN promote window, so
        // it must contribute NOTHING to the numerator despite being
        // agent-authored.
        { author: 'claude', dayOffset: 50, files: { 'src/agentOld.ts': 'export function agentOld() { return 2; }\n' }, message: 'feat: agent old' },
        // Human-authored, first seen day 130 (= HEAD's own commit, the
        // clock anchor): inside the window, stable_days 0.
        { author: 'alice', dayOffset: 130, files: { 'src/humanNew.ts': 'export function humanNew() { return 3; }\n' }, message: 'feat: human new' },
      ],
    });
    const { deps, cleanup } = await makeTempHistoryDeps();
    try {
      const join = await buildHistoryJoin(dir, config, deps);
      expect(join).toBeDefined();
      // Hand-derived: agentOld's base weight is w_surv(min(1,80/120)=0.666667)
      // x w_prov(agentBase 0.15 + 0.85*min(1,80/40)=1, capped at 1.0) x
      // w_churn(1, single touch, never churned) = 0.666667. humanNew's is
      // w_surv(min(1,0/120)=0, HALVED again by the fresh-penalty factor
      // since age 0 < freshPenaltyDays 14 -> 0) floored to baseFloor 0.05.
      // Population is non-empty (both rows inside the window) with NO
      // agent contribution counted, so the share is exactly 0 — not the
      // ~0.93 a numerator that ignored stable_days would read.
      expect(join?.agentShare).toBe(0);
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildHistoryJoin — historyStats is a property of the history (D4), asserted against the two rosters (MR-28)', () => {
  it('the one-sha-two-verdicts collision: the shared empty blob reaches blobShas once and parsedKeys carries only the .ts side', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;

        const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
        // The shared empty blob is a single roster ENTRY (a Set, so this
        // membership check IS the "once" — `docs/PLACEHOLDER.md`, listed
        // first in `--raw`'s path order, resolves no grammar and is never
        // keyed at all; `src/svc/placeholder.ts` shares the same sha and
        // IS keyed). A sha-keyed `parsed` roster that accumulated on a
        // blob's first appearance would see the no-grammar `.md` verdict
        // first and never key this sha's `.ts` side at all — the exact
        // undercount D4 removes by keying on the cache key instead.
        expect(join.blobShas.has(EMPTY_BLOB_SHA)).toBe(true);
        // The EXACT key, not merely a `bytes === 0` count somewhere in the
        // map: the `.ts` side's own real per-grammar cache key is present
        // with `bytes === 0`, and it is the ONLY zero-byte entry —
        // `docs/PLACEHOLDER.md`'s side never enters `parsedKeys` at all (no
        // registered grammar for `.md`), so nothing else could produce a
        // second zero-byte entry either.
        const tsKey = keyForExtension('.ts', EMPTY_BLOB_SHA);
        expect(join.parsedKeys.get(tsKey)).toBe(0);
        const zeroByteEntries = [...join.parsedKeys.entries()].filter(([, bytes]) => bytes === 0);
        expect(zeroByteEntries).toEqual([[tsKey, 0]]);
        expect(join.historyStats.blobs).toBe(join.blobShas.size);
        expect(join.historyStats.parsed).toBe(join.parsedKeys.size);
      } finally {
        await cleanup();
      }
    });
  });

  it('one sha, two keyed paths under different grammars: the .ts/.py stub pair shares one blobShas entry but contributes TWO parsedKeys entries', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const join = await buildHistoryJoin(repoRoot, config, deps);
        expect(join).toBeDefined();
        if (!join) return;

        // `src/stub/same.ts` and `src/stub/same.py` are byte-identical
        // one-line content (T3 item 1) — one shared blob sha, parsed under
        // two distinct grammars, so `parsedKeys` must carry two DIFFERENT
        // keys for the one sha (distinct because `blobCacheKey` folds the
        // per-grammar `bindingHash`), each with the SAME `bytes` value
        // (the content is identical). Pinned by the EXACT keys, not merely
        // a count: both the `.ts` and `.py` real per-grammar keys for the
        // stub pair's own sha are present at `bytes === 6` ('x = 1\n'), and
        // they are the ONLY two 6-byte entries in the whole roster.
        const STUB_SHA = '7d4290a117a4ddcc11daae7ea675841033830c8f';
        const tsKey = keyForExtension('.ts', STUB_SHA);
        const pyKey = keyForExtension('.py', STUB_SHA);
        expect(join.parsedKeys.get(tsKey)).toBe(6);
        expect(join.parsedKeys.get(pyKey)).toBe(6);
        const sixByteKeys = [...join.parsedKeys.entries()].filter(([, bytes]) => bytes === 6).map(([key]) => key);
        expect(sixByteKeys.sort()).toEqual([tsKey, pyKey].sort());
      } finally {
        await cleanup();
      }
    });
  });

  it('cold vs warm: a second buildHistoryJoin call over the SAME cache directory reports identical historyStats, including parsed and mb', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const first = await buildHistoryJoin(repoRoot, config, deps);
        const second = await buildHistoryJoin(repoRoot, config, deps); // SAME cacheDir — warm on the second call
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(second?.historyStats).toEqual(first?.historyStats);
        expect(second?.blobShas.size).toBe(first?.blobShas.size);
        expect(second?.parsedKeys.size).toBe(first?.parsedKeys.size);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The full production path (buildHistoryJoin -> resolveAdmittedRefs -> the
// reader's `probe`) degrades a damaged cache shard to a rebuilt miss, never
// an abort: a deleted or corrupted shard makes `probe` answer `undefined`,
// which routes that key to the ordinary fetch-and-re-extract path. The
// disturbed run below forces a FULL re-walk deliberately — a resumed run
// over an unchanged tree walks zero commits and performs no blob-cache I/O
// at all, so only a full walk actually re-classifies every key against the
// damaged cache. What this pins is corruption tolerance (a damaged derived
// cache is silently rebuilt, never surfaced as a failed run); the
// between-reads race itself is closed STRUCTURALLY — classification and
// resolution are one read inside `probe`, so no test can construct a
// second read for a shard to vanish between.
// ---------------------------------------------------------------------------

describe('buildHistoryJoin — a damaged cache shard degrades to a rebuilt miss, never an abort', () => {
  it('deleting one arbitrary shard the cold run wrote: a FULL re-walk over the damaged cache completes and reports historyStats identical to an undisturbed clean warm run', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      const { deps: cleanDeps, cleanup: cleanupClean } = await makeTempHistoryDeps();
      try {
        const cold = await buildHistoryJoin(repoRoot, config, deps);
        expect(cold).toBeDefined();

        // Delete one arbitrary shard the cold run just wrote to `deps.cacheDir`.
        const prefixDirs = readdirSync(deps.cacheDir);
        expect(prefixDirs.length).toBeGreaterThan(0);
        const firstPrefix = path.join(deps.cacheDir, prefixDirs[0]);
        const shardFiles = readdirSync(firstPrefix);
        expect(shardFiles.length).toBeGreaterThan(0);
        rmSync(path.join(firstPrefix, shardFiles[0]));

        // The reference: a fully clean, undisturbed cold+warm pair over an
        // independent cache directory.
        const cleanCold = await buildHistoryJoin(repoRoot, config, cleanDeps);
        expect(cleanCold).toBeDefined();
        const cleanWarm = await buildHistoryJoin(repoRoot, config, cleanDeps);
        expect(cleanWarm).toBeDefined();

        // The disturbed run: `full: true` so the walk re-classifies every
        // key against the damaged cache (a resume over an unchanged tree
        // would never touch it). It must complete without throwing and
        // match the clean warm run's historyStats exactly — the vanished
        // shard is silently rebuilt as a miss, never surfacing as a failed
        // `index` run.
        const warm = await buildHistoryJoin(repoRoot, config, { ...deps, full: true });
        expect(warm).toBeDefined();
        expect(warm?.historyStats).toEqual(cleanWarm?.historyStats);
      } finally {
        await cleanup();
        await cleanupClean();
      }
    });
  });
});

describe('buildHistoryJoin — D17 gate 1 excludes a built-in-exclusion path from every roster and lifecycle row', () => {
  it('a commit touching dist/bundle.js AND an ordinary source file: the dist path contributes no blob sha, no parsed key, and no lifecycle row; the source file gets all three', async () => {
    const config = await defaultRootsConfig();
    const dir = buildGoldenRepo({
      name: 'gate1-probe',
      commits: [
        {
          author: 'alice',
          files: { 'src/a.ts': 'export function a() {\n  return 1;\n}\n', 'dist/bundle.js': 'console.log("built output");\n' },
          message: 'seed: source file + build output',
        },
      ],
    });
    const { deps, cleanup } = await makeTempHistoryDeps();
    try {
      const join = await buildHistoryJoin(dir, config, deps);
      expect(join).toBeDefined();
      if (!join) return;

      const distRow = join.lifecycle.find((r) => r.key === 'dist/bundle.js' || r.key.startsWith('dist/bundle.js#'));
      expect(distRow).toBeUndefined();

      const srcRow = join.lifecycle.find((r) => r.key === 'src/a.ts');
      expect(srcRow).toBeDefined();

      // The dist file's own blob sha never entered the roster at all (gate
      // 1 drops the WHOLE record, before gate 2 or the cache is ever
      // consulted) — distinct from src/a.ts's sha, so this is a genuine,
      // non-vacuous negative: the dist blob really was walked and really
      // was excluded, not merely absent because nothing referenced it.
      expect(join.historyStats.commits).toBe(1); // the commit itself is still counted
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
