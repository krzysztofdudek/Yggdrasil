import { describe, it, expect } from 'vitest';
import { withBuiltGolden, composeMineInputPieces } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { runRootsIndex } from '../../../src/roots/pipeline.js';
import { mine, type AgeFn, type MineInput } from '../../../src/roots/mine.js';
import { isBooleanSurface } from '../../../src/roots/mine-stages.js';
import type { FeatureBag, DomainMap } from '../../../src/roots/enumerate.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import type { RoleAssignment } from '../../../src/roots/roles.js';
import { buildTypeScriptGoldenSpec } from '../../fixtures/roots/golden/typescript/spec.js';
import { buildTsxGoldenSpec } from '../../fixtures/roots/golden/tsx/spec.js';
import { buildJavaScriptGoldenSpec } from '../../fixtures/roots/golden/javascript/spec.js';
import { buildPythonGoldenSpec } from '../../fixtures/roots/golden/python/spec.js';
import { buildJavaGoldenSpec } from '../../fixtures/roots/golden/java/spec.js';
import { buildGoGoldenSpec } from '../../fixtures/roots/golden/go/spec.js';
import { buildDataGoldenSpec } from '../../fixtures/roots/golden/data/spec.js';
import type { GoldenRepoSpec } from '../../support/roots-golden.js';

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
//   FAIL-CLOSED CONTROL — two halves: (a) pipeline-level, every one of the
//   seven goldens' `MinedModel` shows ZERO `hookEligible` facts (still
//   accepted) through the real `runRootsIndex` entry point every adopter
//   actually calls; (b) unit-level at `mine()` directly, with a hand-built
//   fixture and a synthetic `AgeFn`: `hookEligible` flips false -> true for
//   the SAME fact, while acceptance (`expected`/`bitsSaved`) is unchanged —
//   proving the branch points the right way, which a "history-stripped
//   golden" could never prove (without any `AgeFn` at all, stripped and
//   unstripped goldens are indistinguishable by construction).
//
//   DETERMINISM CONTROL — double `runRootsIndex` on a real golden ->
//   byte-identical `MinedModel` (`JSON.stringify` equality). The blob cache
//   is R4 — nothing writes `.cache/` this increment, so cache independence
//   is NOT claimable yet and is not asserted here.
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
      const result = await runRootsIndex(repoRoot, config, []);
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

describe('FAIL-CLOSED CONTROL, part (a): pipeline-level — every golden shows ZERO hookEligible facts through the real runRootsIndex entry point', () => {
  const goldens: [string, GoldenRepoSpec][] = [
    ['typescript', buildTypeScriptGoldenSpec()],
    ['tsx', buildTsxGoldenSpec()],
    ['javascript', buildJavaScriptGoldenSpec()],
    ['python', buildPythonGoldenSpec()],
    ['java', buildJavaGoldenSpec()],
    ['go', buildGoGoldenSpec()],
    ['data', buildDataGoldenSpec()],
  ];

  for (const [name, spec] of goldens) {
    it(`${name}: every accepted fact has hookEligible === false (facts still exist — mines a field, speaks nothing, per J4)`, async () => {
      const config = await defaultRootsConfig();
      await withBuiltGolden(spec, async (repoRoot) => {
        const result = await runRootsIndex(repoRoot, config, []);
        const facts = result.body.partitions.flatMap((p) => p.facts);
        expect(facts.length).toBeGreaterThan(0); // a golden with zero facts would make this assertion vacuous
        expect(facts.every((f) => f.hookEligible === false)).toBe(true);
      });
    });
  }
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
});

describe('DETERMINISM CONTROL — double runRootsIndex over a real golden, byte-identical MinedModel', () => {
  const goldens: [string, GoldenRepoSpec][] = [
    ['typescript', buildTypeScriptGoldenSpec()],
    ['python', buildPythonGoldenSpec()],
    ['data', buildDataGoldenSpec()],
  ];

  for (const [name, spec] of goldens) {
    it(`${name}: two independent runRootsIndex calls over the same repo produce byte-identical serialized MinedModel bodies (no cache-independence claim — R4's blob cache does not exist yet)`, async () => {
      const config = await defaultRootsConfig();
      await withBuiltGolden(spec, async (repoRoot) => {
        const first = await runRootsIndex(repoRoot, config, []);
        const second = await runRootsIndex(repoRoot, config, []);
        expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
        expect(second.bindingSetHash).toBe(first.bindingSetHash);
        expect(second.candidateCountLog2).toBe(first.candidateCountLog2);
      });
    });
  }
});
