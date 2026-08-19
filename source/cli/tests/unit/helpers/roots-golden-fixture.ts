import { rm } from 'node:fs/promises';
import { buildGoldenRepo, type GoldenRepoSpec } from '../../support/roots-golden.js';
import { parseAndExtractAll } from '../../../src/roots/pipeline.js';
import { derivePartitions } from '../../../src/roots/partitions.js';
import { finalizeUnits, type ScopeUnit } from '../../../src/roots/extract.js';
import { buildVocabularies, enumerate, type FeatureBag, type DomainMap, type RootsVocabularies } from '../../../src/roots/enumerate.js';
import { induceRoles, type RoleAssignment, type WeightFn } from '../../../src/roots/roles.js';
import type { RootsConfig } from '../../../src/model/graph.js';

// =============================================================================
// tests/unit/helpers/roots-golden-fixture.ts — shared plumbing Task 7's
// golden suite (tests/unit/roots/golden*.test.ts) builds on: replaying a
// committed golden's builder spec into a real temp git working tree (never
// the committed `.bundle` directly — a golden is asserted EQUIVALENT to its
// bundle, tested separately; every functional assertion runs against the
// spec-built tree, matching `roots-golden.ts`'s own `buildGoldenRepo`
// contract) and composing the mining engine's PURE stages by hand, exactly
// the prefix `src/roots/pipeline.ts`'s `runRootsIndex` itself runs — up to
// (not including) `mine()` — so a caller can inject its OWN `AgeFn`/permuted
// `bags`, which `runRootsIndex` deliberately does not expose (Task 6's own
// dictated seam: R1-R3's default pipeline hardcodes no `AgeFn` at all).
// Reusing `parseAndExtractAll` (never re-walking/re-filtering independently)
// is what keeps this composition from silently diverging from the real
// pipeline's own filters — the same reasoning Task 6 recorded for exporting
// that function on its own.
// =============================================================================

/** Builds `spec` into a fresh temp git working tree and runs `fn(repoRoot)`, removing the tree afterward regardless of outcome. */
export async function withBuiltGolden<T>(spec: GoldenRepoSpec, fn: (repoRoot: string) => Promise<T> | T): Promise<T> {
  const dir = buildGoldenRepo(spec);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every intermediate the mining engine's pure stages produce between `parseAndExtractAll` and `mine()` — everything a caller needs to hand-build its own `MineInput` (own `AgeFn`, own permuted `bags`) without re-deriving the walk/filter/extract/partition/vocabulary/enumerate/role prefix independently. */
export interface ComposedMineInputPieces {
  units: ScopeUnit[];
  bags: FeatureBag[];
  domains: DomainMap;
  vocab: Map<string, RootsVocabularies>;
  partitions: ReturnType<typeof derivePartitions>;
  roles: RoleAssignment;
}

/**
 * Composes `parseAndExtractAll -> derivePartitions -> finalizeUnits ->
 * buildVocabularies -> enumerate (per surviving partition) -> induceRoles`
 * over a real, already-built repo directory — the identical stage sequence
 * `pipeline.ts`'s `runRootsIndex` runs, stopping one stage short (`mine`) so
 * the caller supplies its own `weightFn`/`ageFn`/`bags` to `mine()` directly.
 * `weightFn` defaults to the SAME R1 constant `runRootsIndex` uses
 * (`config.weights.noLifecycleWeight`) unless the caller overrides it —
 * §8.9(b)'s file-role plurality is the only role-induction consumer of it.
 */
export async function composeMineInputPieces(repoRoot: string, config: RootsConfig, weightFn?: WeightFn): Promise<ComposedMineInputPieces> {
  const { files, rawScopes } = await parseAndExtractAll(repoRoot, config);
  const partitions = derivePartitions(files, rawScopes, config);
  const units = finalizeUnits(rawScopes, partitions);

  const vocab = buildVocabularies(units, partitions, config);
  const byPartition = new Map<string, ScopeUnit[]>();
  for (const unit of units) {
    const bucket = byPartition.get(unit.partitionId);
    if (bucket) bucket.push(unit);
    else byPartition.set(unit.partitionId, [unit]);
  }
  const bags: FeatureBag[] = [];
  const domains: DomainMap = new Map();
  for (const partitionId of partitions.survivingPartitionIds) {
    const partitionUnits = byPartition.get(partitionId) ?? [];
    const partitionVocab: RootsVocabularies = vocab.get(partitionId) ?? {
      nodeType: [],
      call: [],
      decorator: [],
      import: [],
      supertype: [],
      shape: [],
    };
    const result = enumerate(partitionUnits, partitionVocab, config);
    bags.push(...result.bags);
    for (const [surfaceId, members] of result.domains) {
      const existing = domains.get(surfaceId);
      if (existing) for (const m of members) existing.add(m);
      else domains.set(surfaceId, new Set(members));
    }
  }

  const effectiveWeightFn: WeightFn = weightFn ?? (() => config.weights.noLifecycleWeight);
  const roles = induceRoles(units, effectiveWeightFn, config);

  return { units, bags, domains, vocab, partitions, roles };
}
