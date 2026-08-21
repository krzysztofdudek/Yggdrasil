import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withBuiltGolden, composeMineInputPieces } from '../helpers/roots-golden-fixture.js';
import { withHistoryDeps, historyDepsFor } from '../helpers/roots-history-deps.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { runRootsIndex } from '../../../src/roots/pipeline.js';
import { buildHistoryJoin } from '../../../src/roots/history.js';
import { mine, type AgeFn, type MineInput } from '../../../src/roots/mine.js';
import { isBooleanSurface } from '../../../src/roots/mine-stages.js';
import type { FeatureBag, DomainMap } from '../../../src/roots/enumerate.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import type { RoleAssignment } from '../../../src/roots/roles.js';
import { buildTypeScriptGoldenSpec } from '../../fixtures/roots/golden/typescript/spec.js';
import { buildPythonGoldenSpec } from '../../fixtures/roots/golden/python/spec.js';
import { buildDataGoldenSpec } from '../../fixtures/roots/golden/data/spec.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import type { GoldenRepoSpec } from '../../support/roots-golden.js';
import { runGitFixture, deterministicCommitIndexAt, deterministicCommitDate } from '../../support/git-fixture.js';
import { buildBranchMergeFixture } from '../../support/branch-merge-fixture.js';

/** Throwing wrapper over `runGitFixture` for the shallow-clone control's own ad hoc git plumbing (init/remote/fetch/checkout) — these are one-off setup commands, never part of a deterministic scripted history, so the plain (non-deterministic-env) wrapper is the right one. */
function runGitOrThrow(dir: string, args: string[]): void {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-controls.test.ts — the THREE increment-wide
// controls Task 7's plan names, each with the REAL injection point stated
// there (repeated here since `runRootsIndex` deliberately exposes none of
// them):
//
//   NULL CONTROL — composes the exported stages directly (never
//   `runRootsIndex`, which hardcodes no `AgeFn` and returns no intermediate
//   `bags`), permutes every surface's values across scopes WITHIN THAT
//   SURFACE'S DOMAIN ONLY (domains ride unpermuted), with a deterministic
//   seed, then asserts `mine()` accepts 0 role/locality conventions. Runs
//   against the PYTHON golden specifically (see
//   tests/fixtures/roots/golden/python/spec.ts's own header): it is the one
//   golden this suite builds to produce genuine, non-trivial role-conditioned
//   FACTS BEFORE the shuffle, so "0 after" is a real destruction, not a
//   vacuous restatement of "0 before".
//
//   FAIL-CLOSED CONTROL — two halves: (a) FOUR controls at the real
//   `runRootsIndex` entry point (R4 Task 8, replacing the old degraded-only
//   pipeline check): a no-git control and a shallow-clone control (both
//   degraded — every fact `hookEligible: false`, `historyStats` absent,
//   `agentShare: null`), a positive control on the `history/` golden's real
//   history (>= 1 `hookEligible: true` fact whose `nConformRaw`/`nTotalRaw`
//   are the SURVIVED counts), and a merge-HEAD control pinning the clock
//   half of §13.4 (HEAD is a merge commit ⇒ the join's clock is the MERGE's
//   own committer timestamp, never the walk's last `--no-merges` record);
//   (b) unit-level at `mine()` directly, with a hand-built fixture and a
//   synthetic `AgeFn`: `hookEligible` flips false -> true for the SAME fact,
//   while acceptance (`expected`/`bitsSaved`) is unchanged — proving the
//   branch points the right way, which a "history-stripped golden" could
//   never prove (without any `AgeFn` at all, stripped and unstripped
//   goldens are indistinguishable by construction).
//
//   DETERMINISM CONTROL — double `runRootsIndex` on a real golden ->
//   byte-identical `MinedModel` (`JSON.stringify` equality). The second call
//   now runs against a WARM blob cache (a SHARED `cacheDir` across both
//   calls, R4's blob cache is live from Task 4 on) and still produces
//   byte-identical bodies — R4-I3's cold-versus-warm claim asserted at the
//   pipeline level.
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// Deterministic seeded permutation (spec Appendix H.6's own "seeded
// permutation" requirement) — a tiny mulberry32 PRNG seeded per-surface
// from a string hash, so the same golden always permutes identically on
// every run (this test suite's own determinism discipline, not merely
// spec H.6's).
// -----------------------------------------------------------------------

function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a deterministic RNG — never `Math.random`. */
function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Spec Appendix H.6's shuffled-label null: for EVERY surface independently,
 * collect its domain members (sorted for a reproducible base order), read
 * each member's CURRENT value for that surface (bool: 'true'/'false' by
 * presence; categorical: the recorded value), shuffle those values with a
 * per-surface-seeded deterministic RNG, and reassign — never touching
 * `domains` itself (a value permuted onto an out-of-domain scope would
 * drive `n_false` negative and fake the zero result, Task 7's own stated
 * hazard) and never touching which scopes belong to which role (`roles` is
 * computed upstream, from `ScopeUnit` fields the enumerate-stage bags never
 * carry, and is passed through unpermuted by the caller).
 */
function permuteBagsWithinDomains(bags: readonly FeatureBag[], domains: DomainMap, seed: number): FeatureBag[] {
  const bagByStableId = new Map(bags.map((b) => [b.stableId, b]));
  const cloned = new Map<string, FeatureBag>();
  for (const b of bags) cloned.set(b.stableId, { ...b, surfaces: { ...b.surfaces } });

  for (const surfaceId of [...domains.keys()].sort()) {
    const domainSet = domains.get(surfaceId);
    if (!domainSet) continue;
    const memberIds = [...domainSet].sort();
    const bool = isBooleanSurface(surfaceId);
    const originalValues = memberIds.map((id) => {
      const original = bagByStableId.get(id) as FeatureBag;
      return bool ? (original.surfaces[surfaceId] === 'true' ? 'true' : 'false') : original.surfaces[surfaceId];
    });
    const rng = mulberry32(seedFromString(`${seed}|${surfaceId}`));
    const permutedValues = seededShuffle(originalValues, rng);
    memberIds.forEach((id, idx) => {
      const target = cloned.get(id) as FeatureBag;
      const value = permutedValues[idx];
      if (bool) {
        if (value === 'true') target.surfaces[surfaceId] = 'true';
        else delete target.surfaces[surfaceId];
      } else if (value !== undefined) {
        target.surfaces[surfaceId] = value;
      }
    });
  }
  return [...cloned.values()];
}

describe('NULL CONTROL (spec Appendix H.6, design §13.2) — shuffled-label permutation on the role-rich python golden', () => {
  it('BEFORE the shuffle, the real pipeline mines genuine role-conditioned facts (the null control has something real to destroy)', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      return result.body.partitions.flatMap((p) => p.facts);
    });
    const roleConditioned = facts.filter((f) => f.roleKey !== '_all' && !f.roleKey.startsWith('d['));
    expect(roleConditioned.length).toBeGreaterThan(0);
  });

  it('AFTER a deterministic per-surface, within-domain shuffle of every mined value, 0 role/locality conventions are accepted', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const pieces = await composeMineInputPieces(repoRoot, config);
      const permutedBags = permuteBagsWithinDomains(pieces.bags, pieces.domains, 42);
      const weightFn: MineInput['weightFn'] = () => config.weights.noLifecycleWeight;
      const result = mine({
        units: pieces.units,
        bags: permutedBags,
        domains: pieces.domains,
        vocab: pieces.vocab,
        partitions: pieces.partitions,
        roles: pieces.roles, // UNPERMUTED — role membership never depends on enumerate's bags
        seeds: [],
        config,
        weightFn,
        // no ageFn — irrelevant to this control (role/locality acceptance
        // never depends on hook eligibility, §9.4a vs §9.4c are separate).
      });
      const facts = result.body.partitions.flatMap((p) => p.facts);
      const roleOrLocality = facts.filter((f) => f.roleKey !== '_all');
      expect(roleOrLocality).toEqual([]);
    });
  });

  it('a DIFFERENT deterministic seed also destroys every role/locality convention (the zero result is not a coincidence of one particular shuffle)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const pieces = await composeMineInputPieces(repoRoot, config);
      const permutedBags = permuteBagsWithinDomains(pieces.bags, pieces.domains, 1337);
      const weightFn: MineInput['weightFn'] = () => config.weights.noLifecycleWeight;
      const result = mine({
        units: pieces.units,
        bags: permutedBags,
        domains: pieces.domains,
        vocab: pieces.vocab,
        partitions: pieces.partitions,
        roles: pieces.roles,
        seeds: [],
        config,
        weightFn,
      });
      const facts = result.body.partitions.flatMap((p) => p.facts);
      expect(facts.filter((f) => f.roleKey !== '_all')).toEqual([]);
    });
  });
});

describe('FAIL-CLOSED CONTROL, part (a): the four Step-6 controls at the real runRootsIndex entry point', () => {
  it('NO-GIT control: deleting .git before indexing ⇒ facts exist, every one hookEligible: false, historyStats absent, agentShare: null', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildTypeScriptGoldenSpec(), async (repoRoot) => {
      rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      const facts = result.body.partitions.flatMap((p) => p.facts);
      expect(facts.length).toBeGreaterThan(0); // a golden with zero facts would make this assertion vacuous
      expect(facts.every((f) => f.hookEligible === false)).toBe(true);
      expect(result.body.historyStats).toBeUndefined();
      expect(result.body.agentShare).toBeNull();
    });
  });

  it('SHALLOW control: a --depth 1 clone of a golden ⇒ the SAME degraded shape (not a half-history model computed from one commit)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildTypeScriptGoldenSpec(), async (repoRoot) => {
      const shallowDir = mkdtempSync(path.join(tmpdir(), 'yg-roots-shallow-'));
      try {
        runGitOrThrow(shallowDir, ['init', '-q']);
        runGitOrThrow(shallowDir, ['remote', 'add', 'origin', `file://${repoRoot}`]);
        runGitOrThrow(shallowDir, ['fetch', '-q', '--depth', '1', 'origin', 'main']);
        runGitOrThrow(shallowDir, ['checkout', '-q', 'FETCH_HEAD']);

        const result = await withHistoryDeps((options) => runRootsIndex(shallowDir, config, [], options));
        const facts = result.body.partitions.flatMap((p) => p.facts);
        expect(facts.length).toBeGreaterThan(0);
        expect(facts.every((f) => f.hookEligible === false)).toBe(true);
        expect(result.body.historyStats).toBeUndefined();
        expect(result.body.agentShare).toBeNull();
      } finally {
        rmSync(shallowDir, { recursive: true, force: true });
      }
    });
  });

  it('POSITIVE control: the history/ golden with its real history ⇒ >= 1 hookEligible fact whose nConformRaw/nTotalRaw are the SURVIVED counts', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
      const facts = result.body.partitions.flatMap((p) => p.facts);
      const eligible = facts.filter((f) => f.hookEligible === true);
      expect(eligible.length).toBeGreaterThan(0);
      // Every eligible fact's nTotalRaw is the SURVIVED-raw population — a
      // strict subset of what the fact's own weighted `counts` moved (which
      // reads ALL in-domain instances, survived or not) whenever any
      // in-domain member is too fresh to have survived (§9.4a vs §9.4c).
      for (const f of eligible) {
        expect(f.nTotalRaw).toBeGreaterThan(0);
        expect(f.nConformRaw).toBeLessThanOrEqual(f.nTotalRaw);
      }
    });
  });

  it('MERGE-HEAD control (clock half only): HEAD is a merge commit ⇒ the join indexes with the MERGE commit\'s own committer timestamp, and the merge itself never reaches historyStats.commits', async () => {
    const config = await defaultRootsConfig();
    const fixture = buildBranchMergeFixture({ trailingMainCommit: false });
    const cacheRoot = mkdtempSync(path.join(tmpdir(), 'yg-roots-merge-head-'));
    try {
      const join = await buildHistoryJoin(fixture.dir, config, {
        cacheDir: path.join(cacheRoot, 'blobs'),
        stateDir: path.join(cacheRoot, 'history'),
        ledger: [],
        dirtyPaths: new Set(),
      });
      expect(join).toBeDefined();
      const mergeIndex = deterministicCommitIndexAt(110);
      const mergeTs = Math.floor(Date.parse(deterministicCommitDate(mergeIndex)) / 1000);
      expect(Date.parse((join?.clockIso as string) ?? '')  / 1000).toBe(mergeTs);
      expect(join?.clockTs).toBe(mergeTs);
      // base, side, main1 are the three NON-merge commits this fixture makes
      // (`trailingMainCommit: false` stops right at the merge) — the merge
      // itself is invisible to the `--no-merges` walk, so historyStats.commits
      // is 3, never 4.
      expect(join?.historyStats.commits).toBe(3);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe('FAIL-CLOSED CONTROL, part (b): unit-level at mine() — a synthetic AgeFn flips hookEligible false -> true without moving acceptance', () => {
  function unit(overrides: Partial<ScopeUnit> & { stableId: string; relPath: string; kind: ScopeUnit['kind']; name: string }): ScopeUnit {
    const qualifiedName = overrides.qualifiedName ?? overrides.name;
    return {
      kind: overrides.kind,
      relPath: overrides.relPath,
      name: overrides.name,
      qualifiedName,
      ordinal: 0,
      arity: 0,
      hasParameterList: false,
      startRow: 0,
      supertypes: [],
      decorators: [],
      grammarHasDecoratorTypes: false,
      grammarHasHeritageCandidacy: false,
      grammarNodeTypeVocabulary: [],
      fileImports: [],
      calleeTexts: [],
      nodeTypesSeen: [],
      statementShapes: [],
      localVarNames: [],
      firstStatementType: undefined,
      lastReturnExprType: undefined,
      hasReturnStatement: false,
      bodyStatementCount: 0,
      partitionId: 'p1',
      skeyR: `${overrides.relPath}#${overrides.kind}#${qualifiedName}`,
      stableId: overrides.stableId,
    };
  }

  function trivialPartitions(relPaths: string[]): PartitionMap {
    return {
      partitionOfFile: new Map(relPaths.map((p) => [p, 'p1'])),
      moduleRootDirOfFile: new Map(relPaths.map((p) => [p, ''])),
      packageRoots: [],
      survivingPartitionIds: ['p1'],
      statusOfKey: new Map([['p1', 'own-floor']]),
      silent: false,
    };
  }

  const SURFACE = 'auto.call:established';

  it('flips hookEligible false -> true for the same fact; expected/bitsSaved/share are byte-identical between the two runs', async () => {
    const config = await defaultRootsConfig('mdl:\n    acceptMarginBits: 0.5\n    minInstancesRaw: 1\n    minInstancesEff: 0.1\n    factCap: 400\n    dedupJaccard: 0.9\n    dirContextMinScopes: 25\n');
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    // 19 true / 1 false — a comfortable, easily-accepted presence signal.
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push({ stableId: u.stableId, skeyR: u.skeyR, kind: u.kind, relPath: u.relPath, surfaces: i < 19 ? { [SURFACE]: 'true' } : {} });
    }
    const domains: DomainMap = new Map([[SURFACE, new Set(units.map((u) => u.stableId))]]);
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const roles: RoleAssignment = { roles: [], assignments: {}, ambiguousRank1: {} };
    const weightFn: MineInput['weightFn'] = () => 0.3;

    const withoutAge = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn }); // no ageFn — fail-closed default
    const syntheticAge: AgeFn = () => 9999; // every instance "survived" a very long time
    const withAge = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn, ageFn: syntheticAge });

    const factWithout = withoutAge.body.partitions[0].facts.find((f) => f.surface === SURFACE);
    const factWith = withAge.body.partitions[0].facts.find((f) => f.surface === SURFACE);
    expect(factWithout).toBeDefined();
    expect(factWith).toBeDefined();

    // The branch points the right way: absent AgeFn = ineligible; present = eligible.
    expect(factWithout?.hookEligible).toBe(false);
    expect(factWith?.hookEligible).toBe(true);

    // Acceptance is UNCHANGED — an AgeFn feeds only §9.4c's survived-raw
    // gate, never bits_saved or the instance counts (Task 7's own stated
    // reasoning for why a "history-stripped golden" would prove nothing
    // here: without any AgeFn at all, stripped and unstripped goldens are
    // indistinguishable by construction).
    expect(factWith?.expected).toBe(factWithout?.expected);
    expect(factWith?.bitsSaved).toBeCloseTo(factWithout?.bitsSaved as number, 10);
    expect(factWith?.share).toBeCloseTo(factWithout?.share as number, 10);
    expect(factWith?.nTotalRaw).not.toBe(factWithout?.nTotalRaw); // the SURVIVED population itself does move — that's the point of the gate
  });

  it('a ledger mark on one scope, one surface: hookShapedConform becomes a real count of CONFORMING marked members only, nConformRaw drops by one, the marked fact\'s weighted count drops by base − hookShapedWeight, and a sibling surface on the SAME scope is unaffected (MR-23, MR-24)', async () => {
    // dedupJaccard raised to 0.99 (from the file's own 0.9 default override)
    // so SURFACE's own conform set and OTHER_SURFACE's 19-true conform set
    // stay two DISTINCT facts under §9.4e's own within-cell dedup — needed
    // so this test's "sibling surface" half has its own fact to assert
    // against, while OTHER_SURFACE's 19/20 skew still clears the acceptance
    // margin on its own.
    const config = await defaultRootsConfig(
      'mdl:\n    acceptMarginBits: 0.5\n    minInstancesRaw: 1\n    minInstancesEff: 0.1\n    factCap: 400\n    dedupJaccard: 0.99\n    dirContextMinScopes: 25\n',
    );
    const OTHER_SURFACE = 'auto.call:other';
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      // m18 is the fixture's own NON-conforming member on SURFACE (false,
      // against the majority true) — kept distinct from OTHER_SURFACE's
      // own false member (m19, index 19) so the two surfaces' true-sets
      // still differ enough (18/20 overlap) to stay under dedupJaccard
      // 0.99. Its purpose is `hookShapedConform`'s own fence: it is ALSO
      // marked below, so a member count that flattens over every value
      // (conforming or not) counts it, while the correct count — restricted
      // to the fact's own conform set — does not.
      const surfaceValue = i === 18 ? 'false' : 'true';
      const surfaces: Record<string, string> = { [SURFACE]: surfaceValue };
      if (i !== 19) surfaces[OTHER_SURFACE] = 'true'; // 19/20 true — skewed enough to accept, distinct enough not to dedup
      bags.push({ stableId: u.stableId, skeyR: u.skeyR, kind: u.kind, relPath: u.relPath, surfaces });
    }
    const domains: DomainMap = new Map([
      [SURFACE, new Set(units.map((u) => u.stableId))],
      [OTHER_SURFACE, new Set(units.map((u) => u.stableId))],
    ]);
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const roles: RoleAssignment = { roles: [], assignments: {}, ambiguousRank1: {} };
    const weightFn: MineInput['weightFn'] = () => 0.3; // w_base, uniform
    const ageFn: AgeFn = () => 9999; // every instance survives

    // m0's SURFACE (not OTHER_SURFACE) carries an unreleased mark — the
    // per-(stableId, surface) shape MR-23's own killer case names. m18's
    // SURFACE is ALSO marked, but m18 does not CONFORM on SURFACE (its own
    // value is 'false' against the majority 'true') — the fence this
    // marking is here to test: `hookShapedConform` counts marked members of
    // the fact's own CONFORM set only, never every marked domain member
    // regardless of value.
    const isMarked = (u: ScopeUnit, surface: string): boolean => (u.stableId === 'm0' || u.stableId === 'm18') && surface === SURFACE;
    const surfaceWeightFn = (u: ScopeUnit, surface: string): number =>
      isMarked(u, surface) ? Math.min(weightFn(u), config.weights.hookShapedWeight) : weightFn(u);

    const marked = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn, ageFn, surfaceWeightFn, hookShapedFn: isMarked });
    const unmarked = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn, ageFn }); // no surfaceWeightFn/hookShapedFn at all

    const markedFact = marked.body.partitions[0].facts.find((f) => f.surface === SURFACE);
    const unmarkedFact = unmarked.body.partitions[0].facts.find((f) => f.surface === SURFACE);
    expect(markedFact).toBeDefined();
    expect(unmarkedFact).toBeDefined();

    // Exactly ONE — m0 (conforming, marked). m18 is also marked but does
    // NOT conform (value 'false' against expected 'true'), so it must be
    // excluded: a mutant that flattens `hookShapedConform` over every
    // marked domain member regardless of value would read 2 here.
    expect(markedFact?.hookShapedConform).toBe(1);
    expect(unmarkedFact?.hookShapedConform).toBe(0);
    expect((unmarkedFact?.nConformRaw as number) - (markedFact?.nConformRaw as number)).toBe(1); // the marked CONFORMING instance drops out of the SURVIVED population (MR-24) — m18 was never in the survived-conforming population to begin with

    const markedCount = Number(markedFact?.counts.true);
    const unmarkedCount = Number(unmarkedFact?.counts.true);
    expect(unmarkedCount - markedCount).toBeCloseTo(0.3 - config.weights.hookShapedWeight, 6); // base − hookShapedWeight

    // The sibling half: a DIFFERENT surface on the SAME scope is untouched.
    const markedOther = marked.body.partitions[0].facts.find((f) => f.surface === OTHER_SURFACE);
    const unmarkedOther = unmarked.body.partitions[0].facts.find((f) => f.surface === OTHER_SURFACE);
    expect(markedOther?.hookShapedConform).toBe(0);
    expect(Number(markedOther?.counts.true)).toBeCloseTo(Number(unmarkedOther?.counts.true), 10);
  });
});

describe('DETERMINISM CONTROL — double runRootsIndex over a real golden, byte-identical MinedModel', () => {
  const goldens: [string, GoldenRepoSpec][] = [
    ['typescript', buildTypeScriptGoldenSpec()],
    ['python', buildPythonGoldenSpec()],
    ['data', buildDataGoldenSpec()],
  ];

  for (const [name, spec] of goldens) {
    it(`${name}: two independent runRootsIndex calls over the same repo produce byte-identical serialized MinedModel bodies, the second run against a WARM blob cache (R4-I3's cold-versus-warm claim at the pipeline level)`, async () => {
      const config = await defaultRootsConfig();
      await withBuiltGolden(spec, async (repoRoot) => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'yg-roots-determinism-'));
        try {
          // Deliberately SHARED cacheDir across both calls — the first is
          // cold (writes every blob-cache record), the second is warm (reads
          // through it, parsing nothing) — and the assertion below is that
          // the two runs still produce byte-identical bodies either way.
          const options = historyDepsFor(cacheRoot);
          const first = await runRootsIndex(repoRoot, config, [], options);
          const second = await runRootsIndex(repoRoot, config, [], options);
          expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
          expect(second.bindingSetHash).toBe(first.bindingSetHash);
          expect(second.candidateCountLog2).toBe(first.candidateCountLog2);
        } finally {
          rmSync(cacheRoot, { recursive: true, force: true });
        }
      });
    });
  }
});
