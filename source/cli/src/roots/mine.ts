/**
 * source/cli/src/roots/mine.ts — spec §9's MDL acceptance chain (R3b): the
 * model-BODY type (`MinedModel`, Appendix D's normative `model.json` body,
 * `v6-spec.md:861-896`, followed key-for-key) and `mine(input)`, which
 * decomposes the prototype's single `mine()` (`prototype-roots2.mjs:176-251`)
 * into named stages (named, NOT an execution order — see each stage's own
 * comment for the real dependency order). Heavy cell-counting/scoring math
 * lives in the sibling `mine-stages.ts` (split purely to stay under the
 * per-file LLM-review prompt ceiling); this file owns per-partition and
 * repo-wide ORCHESTRATION plus `MinedModel` assembly.
 *
 * Read `mine-stages.ts`'s header FIRST — it documents the `Map`-based
 * counting convention (never a plain object) every stage below relies on.
 *
 * AMBIGUOUS ROLE MEMBERS — §8.5's weight-index table (`v6-spec.md:342`),
 * now spec-faithful. `RoleAssignment.assignments` persists an ambiguous
 * scope as the literal `'-1'`, discarding WHICH medoid it was rank-1 closest
 * to; `roles.ts`'s `RoleAssignment.ambiguousRank1` (a small, additive,
 * build-time-only companion map — see its own doc) recovers exactly that,
 * keyed identically to `assignments`. Every stage below that touches a role
 * cell reads BOTH maps together (`assignments[skeyR] === '-1'` ⇒ look up
 * `ambiguousRank1[skeyR]` for the scope's real rank-1 role): `buildPartitionCells`
 * admits an ambiguous member into its OWN rank-1 role's cell at HALF weight
 * (`w(s,q)·0.5`, raw 1, conform-set recorded — mirrors
 * `prototype-roots2.mjs:190`'s `w * (ri.amb.has(i) ? 0.5 : 1)` exactly),
 * `injectSeeds` targets that same rank-1 role cell for an ambiguous scope's
 * own seeds, and `computeRoleLiftForPartition`'s `nEff(r)` sums `w_base`
 * over EVERY rank-1 member of `r` INCLUDING ambiguous ones, at FULL weight —
 * no discount (§8.10's own "n_eff(r) = Σ over members(r) of w_base(s)" is a
 * single per-role divisor, a different quantity from the half-weighted
 * role-CELL counts above; an ambiguous scope IS a member of its rank-1 role
 * until that role is DEMOTED, exactly like `roles.ts`'s own
 * `RoleInfo.size`/`ambiguityRate` already count it). `_all` is unaffected —
 * it was always unconditional over every scope regardless of ambiguity.
 */

import type { ScopeUnit, ScopeKind } from './extract.js';
import { dirnameOf } from './extract.js';
import type { FeatureBag, DomainMap, RootsVocabularies } from './enumerate.js';
import { overlapGroupForSurface } from './enumerate.js';
import type { PartitionMap } from './partitions.js';
import type { RoleAssignment, WeightFn, RoleLiftSurfaceInput } from './roles.js';
import { roleLift as computeRoleLift, isDecorativeRole } from './roles.js';
import type { RootsConfig, SeedEntry } from './model.js';
import {
  ancestorDirsOf,
  isBooleanSurface,
  surfaceClassOf,
  formatCanonicalDecimal,
  emptyCellCounts,
  addCount,
  sumMapValues,
  countRealInstancesIntoCell,
  scoreCandidate,
  indexCostBits,
  isFireable,
  tauFor,
  isFallbackBucket,
  isPlacementSurface,
  allCellId,
  roleCellId,
  dirCellId,
  CELL_KINDS,
  type CellRecord,
} from './mine-stages.js';

// ---------------------------------------------------------------------------
// The R3/R4 age seam. Absent = FAIL-CLOSED (no instance survives), never a
// permissive default — the prototype's own `ageFn ? ageFn(s) >= freshDays :
// true` (`prototype-roots2.mjs:190`) is the fail-OPEN shape this MUST NOT
// port as-is (AGENTS.md's own "Fail-closed survived-raw" global constraint).
// ---------------------------------------------------------------------------

/** Returns a scope's `age_days` (spec §9.1). Absent ⇒ every instance is unsurvived (§9.4c's fail-closed default; R4 supplies a real implementation from git history). */
export type AgeFn = (unit: ScopeUnit) => number;

export interface MineInput {
  units: readonly ScopeUnit[];
  bags: readonly FeatureBag[];
  domains: DomainMap;
  vocab: ReadonlyMap<string, RootsVocabularies>;
  partitions: PartitionMap;
  roles: RoleAssignment;
  seeds: readonly SeedEntry[];
  config: RootsConfig;
  /** `w_base` — per-SCOPE base weight (D7). Still what `induceRoles`/§8.9b and `role_lift`'s divisor read; never the ledger-capped per-surface value. */
  weightFn: WeightFn;
  ageFn?: AgeFn;
  /**
   * `w(s,q)` — per-(scope, surface) weight (R4 Task 8, D7): the ledger cap
   * applied LAST, keyed on (stable_id, surface) — `weights.ts`'s own
   * `makeWeightFns(...).surfaceWeight`. Absent ⇒ every real-instance cell
   * count falls back to `weightFn` (the R1-R3 degraded default, where every
   * instance weighed the same constant regardless of surface, so falling
   * back to the per-scope function changes nothing observable).
   */
  surfaceWeightFn?: (unit: ScopeUnit, surface: string) => number;
  /**
   * Whether `unit`'s (stable_id, surface) carries an unreleased ledger mark —
   * `weights.ts`'s own `makeWeightFns(...).isHookShaped`. Folds into
   * `survivedOf` (§9.4c: an unreleased mark excludes the instance from the
   * survived-raw population) and into `MinedFact.hookShapedConform` (a real
   * count once this is supplied). Absent ⇒ no scope is ever hook-shaped
   * (matching the R1-R3 default, where no ledger existed at all).
   */
  hookShapedFn?: (unit: ScopeUnit, surface: string) => boolean;
}

export interface MineResult {
  body: MinedModel;
  candidateCountLog2: number;
}

// ---------------------------------------------------------------------------
// MinedModel — Appendix D's body, key-for-key, per the plan's three-bucket
// accounting (each bucket named at its own field group below).
// ---------------------------------------------------------------------------

export interface MinedFact {
  // POPULATED — §9.4-computable.
  factKey: string; // `${roleKey}|${surface}` — Appendix D's own literal format, `<roleKey|_all>` (a directory cell's identity, `d[<dir>]`, rides the same slot — see `roleKey`'s own doc).
  /** `'_all'`, a role's `roleKey` hash, or `d[<dir>]` for a directory context — Appendix D's `roleKey` field only names the first two forms explicitly ("…|_all"); the third is this file's stated extension, carrying §9.4i's third cell class through the same slot rather than inventing an undocumented new field. */
  roleKey: string;
  surface: string;
  appliesKind: ScopeKind | 'module';
  expected: string;
  /** Weighted n_v (post-seed), canonical decimal strings — Appendix D `"true":"24.2"`. */
  counts: Record<string, string>;
  alphabet: string[];
  /** The SURVIVED raw population of §9.4c (Appendix D `:881`/`:886`) — what a hook/status surface displays, not the full raw count. */
  nConformRaw: number;
  nTotalRaw: number;
  share: number;
  bitsPerInstance: number;
  bitsSaved: number;
  nSurfaces: number;
  tau: number;
  absence: boolean;
  hookEligible: boolean;
  seeded: boolean;
  /** §9.4i: the enclosing partition's (`_all`) own argmax for this surface — `null` for an `_all` fact itself (nothing wider encloses it). */
  parentExp: string | null;
  deviantsN: number;

  // HONEST DEGENERATE — the key is real, the value is this increment's true,
  // knowable answer given what has not been built yet (never computed over
  // accepted facts — that would be exactly the acceptance/eligibility
  // conflation this increment exists to fix).
  /** Count of this fact's raw CONFORMING instances (value === expected) that carry an unreleased ledger mark on this fact's own surface — 0 when `hookShapedFn` is absent (no ledger join, matching R1-R4's own history-free default) or when none of the conforming members is marked. */
  hookShapedConform: number;
  /** No R6 calibration exists yet to make anything DENY-eligible. */
  denyEligible: false;
  suppressedValue: null;

  // STRUCTURALLY ABSENT (keys omitted entirely, not nulled — see each's own
  // reason): `calib` (§14, R6), `trend`/`cohorts` (§9.5, R6), `exemplars`
  // (§9.11), `stabilityDays` (§9.4g — trend windows are a later package; "no
  // trends ⇒ no value to store" is this increment's own stated reading of
  // the spec's "absent trends ⇒ omitted from messages" rule, extended to the
  // snapshot).
}

export interface MinedRole {
  roleKey: string;
  label: string;
  size: number;
  medoidFeatures: readonly string[];
  definingFeatureGroups: readonly string[];
  roleLift: number;
  ambiguityRate: number;
}

export interface MinedSeed {
  seedId: string;
  surfaces: string[];
  /** Appendix D shows this as an explicit null — tension is calibration-fed (R6); the key stays, the value is honest. */
  tension: null;
}

export interface MinedPartition {
  id: string;
  vocab: RootsVocabularies;
  /** Categorical surfaces only (§9.3: booleans are a closed {true,false} alphabet, never carried here). */
  alphabets: Record<string, string[]>;
  roles: MinedRole[];
  assignments: Record<string, string>;
  facts: MinedFact[];
  moduleOfFile: Record<string, string>;
  seeds: MinedSeed[];
  /**
   * Appendix G.3's per-file/per-module coupling percentile (`v6-spec.md:892`),
   * projected from the repo-global co-change cut down to THIS partition's own
   * file/module set — co-change itself is computed once, repo-wide (`:622`);
   * only the percentiles riding beside `moduleOfFile` here are per-partition.
   * ABSENT (both keys) in every degraded-mode build (R4-I4: no history join),
   * never an empty object — an empty `{}` would read as "computed, nothing
   * coupled" rather than "not computed at all".
   */
  couplingByFile?: Record<string, number>;
  couplingByModule?: Record<string, number>;
  // §16.2's coverage/debt keys (`coverageRole`, `coverageAll`, `debtBits`,
  // `debtPerInstance`) are STRUCTURALLY ABSENT here, not defaulted to 0 (D9):
  // §16.2 defines them over HOOK-ELIGIBLE facts, which R4 can produce, but
  // their own definition additionally needs §9.10's specificity governance —
  // R5's. A written `0` would assert a false "no coverage debt" reading the
  // moment eligibility can be true; `report` (R7) computes and reintroduces
  // these four keys once that governance exists.
}

/**
 * The model.json BODY (header excluded — `stores.ts` owns that seam).
 * `historyStats` (D4's five history-derived integers), `cochange` (Appendix
 * D's `{a,b,sup,conf}` cut-set rows, sorted), and `aliases` (the sorted,
 * compressed rename closure — `integration-design.md:130`, `:456`) are all
 * OPTIONAL — present and history-fed once a history join exists, ABSENT
 * (never defaulted/zeroed) in every degraded-mode build (R4-I4: no git, a
 * shallow clone, or a walk failure). `agentShare` is the one exception:
 * §18.4's own "n/a" reads as `null` here and is ALWAYS present, degraded or
 * not — a genuinely history-fed `0` (a non-empty, agent-free population) must
 * stay distinguishable from "no history at all" (also `null`), so the field
 * itself can never be structurally absent the way the other three are.
 * `couplingByFile`/`couplingByModule` live per-`partitions[]` entry instead
 * (Appendix D `:892`), beside `moduleOfFile` — see that field's own doc.
 */
export interface MinedModel {
  partitions: MinedPartition[];
  historyStats?: { commits: number; events: number; blobs: number; parsed: number; mb: number };
  cochange?: Array<{ a: string; b: string; sup: number; conf: number }>;
  agentShare: number | null;
  aliases?: Array<[string, string]>;
}

/** Narrowing guard for `stores.ts`'s `readModel`, whose body comes back `unknown`. Structural, not exhaustive — enough for a caller (Task 8's `status`) to trust `.partitions`, `.roles`, and `.seeds` are all walkable (every one of those three arrays is read by `status`'s field/fact/role/seed counts — a guard that checked only `facts` let a partition missing `roles`/`seeds` degrade `status`'s specific "malformed model" message into its generic catch-all instead). */
export function isMinedModel(value: unknown): value is MinedModel {
  if (typeof value !== 'object' || value === null) return false;
  const partitions = (value as { partitions?: unknown }).partitions;
  if (!Array.isArray(partitions)) return false;
  return partitions.every(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as { id?: unknown }).id === 'string' &&
      Array.isArray((p as { facts?: unknown }).facts) &&
      Array.isArray((p as { roles?: unknown }).roles) &&
      Array.isArray((p as { seeds?: unknown }).seeds),
  );
}

// ---------------------------------------------------------------------------
// Stage: per-partition cell construction (real instances) — `_all`, role,
// and directory-context cells, plus the candidate-surface universe and the
// partition-observed categorical alphabets. Seeds are injected AFTER this
// (a separate named stage below), still before scoring/`C` — spec's own
// "seeds join cell counts before scoring and before C" (prototype `:196-202`).
// ---------------------------------------------------------------------------

interface PartitionCellSet {
  cells: CellRecord[];
  candidateSurfacesByKind: Map<string, string[]>;
  /** Partition-observed categorical alphabets, computed from `_all` cells' REAL (pre-seed) raw counts — §9.3's own "never inferred from a role cell's counts." */
  alphabets: Map<string, string[]>;
  /** Partition-wide raw `'true'` count per BOOLEAN surface, summed across EVERY kind's `_all` cell — the §9.4d vacuous filter's own population (a cross-kind surface like `auto.deco:`/`auto.extends:` can be true in one kind and never-true in another; the filter's "zero raw instances in the partition" is genuinely partition-wide, not this-cell's-own-kind — see `scorePartitionFacts`' own use). */
  trueRawBySurface: Map<string, number>;
}

function buildPartitionCells(
  partitionId: string,
  partitionUnits: readonly ScopeUnit[],
  bagOf: (stableId: string) => FeatureBag,
  domains: DomainMap,
  rolesForPartition: readonly { roleKey: string }[],
  config: RootsConfig,
  surfaceWeightOf: (stableId: string, surface: string) => number,
  survivedOf: (stableId: string, surface: string) => boolean,
  assignments: Readonly<Record<string, string>>,
  ambiguousRank1: Readonly<Record<string, string>>,
): PartitionCellSet {
  const unitsByKind = new Map<string, ScopeUnit[]>();
  for (const u of partitionUnits) {
    const bucket = unitsByKind.get(u.kind);
    if (bucket) bucket.push(u);
    else unitsByKind.set(u.kind, [u]);
  }

  // Candidate-surface universe per kind — TWO different recoveries, because
  // bool/cat storage is asymmetric (`mine-stages.ts`'s own header): a
  // CATEGORICAL surface is dense within its domain (`enumerate.ts`'s
  // `emitCat` always sets a value for every domain member of the RIGHT
  // kind), so scanning this kind's own bag keys recovers its full candidate
  // set correctly. A BOOLEAN surface is sparse TRUE-ONLY — a surface that is
  // never true for THIS kind (but true for another kind sharing its domain,
  // e.g. `auto.deco:`/`auto.extends:` span method+type) would never appear
  // as a bag key here at all, silently dropping it from this kind's
  // candidate universe even though the surface plainly APPLIES to this
  // kind's scopes (its domain says so) — making the surface's absence fact
  // for this kind unminable and §9.4d's vacuous filter dead code for it
  // (verified on a real corpus). The correct test for a boolean surface is
  // domain intersection: it is a candidate for kind K whenever `domain(surface)`
  // contains at least one of K's own members, regardless of whether any of
  // them happen to be true.
  const candidateSurfacesByKind = new Map<string, string[]>();
  for (const kind of CELL_KINDS) {
    const kindMemberIds = new Set((unitsByKind.get(kind) ?? []).map((u) => u.stableId));
    const seen = new Set<string>();
    for (const [surface, domainSet] of domains) {
      if (!isBooleanSurface(surface)) continue;
      const [smaller, larger] = domainSet.size <= kindMemberIds.size ? [domainSet, kindMemberIds] : [kindMemberIds, domainSet];
      for (const id of smaller) {
        if (larger.has(id)) {
          seen.add(surface);
          break;
        }
      }
    }
    for (const u of unitsByKind.get(kind) ?? []) {
      const bag = bagOf(u.stableId);
      for (const s of Object.keys(bag.surfaces)) {
        if (!isBooleanSurface(s)) seen.add(s); // categoricals: observed-value recovery, dense within domain
      }
    }
    candidateSurfacesByKind.set(kind, [...seen].sort());
  }

  const cells: CellRecord[] = [];
  const allCellByKind = new Map<string, CellRecord>();

  // `_all` cells first — role/dir scoring baselines read them.
  for (const kind of CELL_KINDS) {
    const members = unitsByKind.get(kind) ?? [];
    if (members.length === 0) continue;
    const counts = emptyCellCounts();
    const memberIds = new Set(members.map((u) => u.stableId));
    countRealInstancesIntoCell(counts, memberIds, candidateSurfacesByKind.get(kind) ?? [], domains, bagOf, surfaceWeightOf, survivedOf);
    const record: CellRecord = { cellId: allCellId(kind), cellClass: 'all', kind, counts };
    cells.push(record);
    allCellByKind.set(kind, record);
  }

  // Partition-wide true-raw population per boolean surface, for the §9.4d
  // vacuous filter — see `PartitionCellSet.trueRawBySurface`'s own doc.
  const trueRawBySurface = new Map<string, number>();
  for (const record of allCellByKind.values()) {
    for (const [surface, byValue] of record.counts.raw) {
      if (!isBooleanSurface(surface)) continue;
      const t = byValue.get('true') ?? 0;
      if (t === 0) continue;
      trueRawBySurface.set(surface, (trueRawBySurface.get(surface) ?? 0) + t);
    }
  }

  // Role cells — method/type only (roles.ts's own eligibility gate never
  // assigns a file/module scope a role). §8.5's weight-index table: a
  // CONFIDENT member joins at full weight; an AMBIGUOUS member (`assignments`
  // records `'-1'`) joins its OWN rank-1 role's cell too, at HALF weight
  // (`w(s,q)·0.5`), raw 1, its conform-set membership recorded exactly like
  // a confident member (prototype-roots2.mjs:190's own reference: `w *
  // (ri.amb.has(i) ? 0.5 : 1)`, `rw` unchanged at 1) — `roles.ts`'s
  // `ambiguousRank1` map is what makes "own rank-1 role" recoverable at all,
  // since `assignments`' `'-1'` alone discards it.
  for (const kind of ['method', 'type'] as const) {
    const members = unitsByKind.get(kind) ?? [];
    if (members.length === 0) continue;
    for (const role of rolesForPartition) {
      const confidentMembers = members.filter((u) => assignments[u.skeyR] === role.roleKey);
      const ambiguousMembers = members.filter((u) => assignments[u.skeyR] === '-1' && ambiguousRank1[u.skeyR] === role.roleKey);
      const roleMembers = [...confidentMembers, ...ambiguousMembers];
      if (roleMembers.length === 0) continue;
      const ambiguousIds = new Set(ambiguousMembers.map((u) => u.stableId));
      const roleWeightOf = (stableId: string, surface: string): number => surfaceWeightOf(stableId, surface) * (ambiguousIds.has(stableId) ? 0.5 : 1);
      const counts = emptyCellCounts();
      const memberIds = new Set(roleMembers.map((u) => u.stableId));
      countRealInstancesIntoCell(counts, memberIds, candidateSurfacesByKind.get(kind) ?? [], domains, bagOf, roleWeightOf, survivedOf);
      cells.push({ cellId: roleCellId(role.roleKey, kind), cellClass: 'role', kind, roleKey: role.roleKey, counts });
    }
  }

  // Directory contexts (§9.4i): every ancestor dir holding >= dirContextMinScopes
  // scopes of a kind and STRICTLY FEWER than the whole partition's population
  // of that kind.
  const dirMembersByKindDir = new Map<string, ScopeUnit[]>(); // `${kind}\u0001${dir}` -> members
  for (const kind of CELL_KINDS) {
    for (const u of unitsByKind.get(kind) ?? []) {
      for (const dir of ancestorDirsOf(u.relPath)) {
        const key = `${kind}\u0001${dir}`;
        const bucket = dirMembersByKindDir.get(key);
        if (bucket) bucket.push(u);
        else dirMembersByKindDir.set(key, [u]);
      }
    }
  }
  for (const kind of CELL_KINDS) {
    const kindTotal = (unitsByKind.get(kind) ?? []).length;
    for (const [key, members] of dirMembersByKindDir) {
      if (!key.startsWith(`${kind}\u0001`)) continue;
      if (members.length < config.mdl.dirContextMinScopes || members.length >= kindTotal) continue;
      const dir = key.slice(kind.length + 1);
      const counts = emptyCellCounts();
      const memberIds = new Set(members.map((u) => u.stableId));
      countRealInstancesIntoCell(counts, memberIds, candidateSurfacesByKind.get(kind) ?? [], domains, bagOf, surfaceWeightOf, survivedOf);
      cells.push({ cellId: dirCellId(dir, kind), cellClass: 'dir', kind, dir, counts });
    }
  }

  // Categorical alphabets: partition-observed values, from the `_all` cells'
  // REAL raw counts (pre-seed — computed here, before the seed-injection
  // stage runs). A categorical surface CAN span multiple kinds (e.g.
  // `auto.nameshape` spans method+type) — its alphabet is the UNION of every
  // kind's own observed values, never one kind overwriting another's: a
  // per-kind `.set()` here silently discarded every earlier kind's values
  // (`CELL_KINDS` order decided which kind's alphabet survived), which on a
  // real corpus zeroed the LOSING kind's `nEff` for that surface and
  // annihilated its facts entirely (verified). Collected into `Set`s first,
  // sorted once at the end.
  const alphabetSets = new Map<string, Set<string>>();
  for (const [kind, record] of allCellByKind) {
    for (const surface of candidateSurfacesByKind.get(kind) ?? []) {
      if (isBooleanSurface(surface)) continue;
      const byValue = record.counts.raw.get(surface);
      if (!byValue) continue;
      let set = alphabetSets.get(surface);
      if (!set) {
        set = new Set();
        alphabetSets.set(surface, set);
      }
      for (const v of byValue.keys()) set.add(v);
    }
  }
  const alphabets = new Map<string, string[]>();
  for (const [surface, set] of alphabetSets) alphabets.set(surface, [...set].sort());

  return { cells, candidateSurfacesByKind, alphabets, trueRawBySurface };
}

// ---------------------------------------------------------------------------
// Stage: seed injection (§9.2). Runs AFTER real-instance counting, BEFORE
// scoring/`C` (real counts, which alone drive `C`'s `minInstancesRaw` gate,
// are already final by this point — seeds carry raw weight 0, so their
// ORDER relative to `C` is numerically inert; this stage still runs before
// it, matching the plan's named-stage ordering literally).
// ---------------------------------------------------------------------------

function injectSeeds(
  cellsByCellId: ReadonlyMap<string, CellRecord>,
  partitionUnits: readonly ScopeUnit[],
  seeds: readonly SeedEntry[],
  bagOf: (stableId: string) => FeatureBag,
  assignments: Readonly<Record<string, string>>,
  ambiguousRank1: Readonly<Record<string, string>>,
  seedCapFraction: number,
  seededKeys: Set<string>,
): void {
  for (const seed of seeds) {
    const unit = partitionUnits.find((u) => u.relPath === seed.scopeRef.path && u.qualifiedName === seed.scopeRef.qualifiedName);
    if (!unit) continue;
    const bag = bagOf(unit.stableId);
    // The seed's OWN scope's rank-1 role cell — an ambiguous scope's
    // `assignments` entry is `'-1'`, so its rank-1 role (now that role cells
    // admit ambiguous members too, at half weight — see `buildPartitionCells`)
    // is recovered from `ambiguousRank1` instead.
    const assignedRoleKey = assignments[unit.skeyR];
    const roleKey = assignedRoleKey === '-1' ? ambiguousRank1[unit.skeyR] : assignedRoleKey;
    const targetCellIds = [allCellId(unit.kind), ...(roleKey !== undefined ? [roleCellId(roleKey, unit.kind)] : [])];
    for (const surface of seed.surfaces) {
      // `Object.hasOwn` guard: `surface` is SEED-supplied (config/graph
      // input, not this file's own vocabulary), and a seed naming the
      // literal string `'constructor'` would otherwise read
      // `Object.prototype.constructor` (a function) off a plain-object bag
      // via bracket access — never `undefined`, so the guard below would
      // wrongly treat it as a real, present value and inject a bogus count.
      const value = Object.hasOwn(bag.surfaces, surface) ? bag.surfaces[surface] : undefined;
      if (value === undefined) continue; // this seed's surface never applied to its own scope — nothing to nudge
      for (const cellId of targetCellIds) {
        const cell = cellsByCellId.get(cellId);
        if (!cell) continue;
        const neffReal = sumMapValues(cell.counts.weighted.get(surface));
        // An empty cell (no real instances at all for this surface) stays
        // empty — seeds nudge, they cannot conjure (spec §9.2's own words):
        // `0.5 * neffReal` caps at 0 when `neffReal` is 0.
        const weight = Math.min(seed.weight, seedCapFraction * neffReal);
        if (weight <= 0) continue;
        addCount(cell.counts, surface, value, weight, 0, false, null);
        seededKeys.add(`${cellId}\u0001${surface}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stage: role_lift (§8.10) + decorative demotion. Invokes `roles.ts`'s pure
// `roleLift` from THIS pass's own real+seeded counts ("one pass," §8.10's own
// words) — never a second implementation of the posterior math. MUST be
// filtered to BEHAVIOR-class surfaces first (§7.3/§8.10's held-out
// exclusion) — an identity surface trivially "predicts" its own cluster.
// ---------------------------------------------------------------------------

function computeRoleLiftForPartition(
  partitionId: string,
  rolesForPartition: readonly { roleKey: string; definingFeatureGroups: readonly string[] }[],
  cellsByCellId: ReadonlyMap<string, CellRecord>,
  candidateSurfacesByKind: ReadonlyMap<string, string[]>,
  alphabets: ReadonlyMap<string, string[]>,
  partitionUnits: readonly ScopeUnit[],
  assignments: Readonly<Record<string, string>>,
  ambiguousRank1: Readonly<Record<string, string>>,
  weightOf: (stableId: string) => number,
): Map<string, number> {
  const liftByRoleKey = new Map<string, number>();
  for (const role of rolesForPartition) {
    const surfaceInputs: RoleLiftSurfaceInput[] = [];
    for (const kind of ['method', 'type'] as const) {
      const roleCell = cellsByCellId.get(roleCellId(role.roleKey, kind));
      const allCell = cellsByCellId.get(allCellId(kind));
      if (!roleCell || !allCell) continue;
      for (const surface of candidateSurfacesByKind.get(kind) ?? []) {
        if (surfaceClassOf(surface) !== 'behavior') continue; // §7.3/§8.10 held-out set is behavior-class only
        const bool = isBooleanSurface(surface);
        const alphabet = bool ? [] : (alphabets.get(surface) ?? []);
        const roleCounts = Object.fromEntries((roleCell.counts.weighted.get(surface) ?? new Map()).entries());
        const partitionCounts = Object.fromEntries((allCell.counts.weighted.get(surface) ?? new Map()).entries());
        surfaceInputs.push({ surface, overlapGroup: overlapGroupForSurface(surface), isBoolean: bool, alphabet, roleCounts, partitionCounts });
      }
    }
    // §8.10's own n_eff(r) = Σ over members(r) of w_base(s) — the role's
    // RANK-1 membership set, at FULL base weight, no ambiguous discount
    // (that discount is §8.5's role-CELL-counts rule, a different quantity
    // from this single per-role divisor). `members(r)` therefore includes
    // ambiguous scopes too: an ambiguous scope only falls back to `_all`
    // when its role is DEMOTED (role_lift <= 0) — until that verdict is
    // known it IS a member of its rank-1 role, exactly like a confident one
    // (`roles.ts`'s own `RoleInfo.size`/`ambiguityRate` count it the same
    // way). `assignments`' `'-1'` alone cannot answer "is this scope's
    // rank-1 role THIS role" for an ambiguous scope — `ambiguousRank1`
    // supplies it.
    let nEff = 0;
    for (const u of partitionUnits) {
      if (u.kind !== 'method' && u.kind !== 'type') continue;
      const assignedRoleKey = assignments[u.skeyR];
      const rank1Key = assignedRoleKey === '-1' ? ambiguousRank1[u.skeyR] : assignedRoleKey;
      if (rank1Key !== role.roleKey) continue;
      nEff += weightOf(u.stableId);
    }
    liftByRoleKey.set(role.roleKey, computeRoleLift(surfaceInputs, role.definingFeatureGroups, nEff));
  }
  void partitionId;
  return liftByRoleKey;
}

// ---------------------------------------------------------------------------
// Stage: repo-wide candidate count `C` (§9.4a) — the §7.3 tautology skip
// applies here (role cells only; `_all`/directory cells are exempt), and `C`
// is what the tautology skip's own absence would mis-size: "candidates
// surviving appliesKind ∧ overlap-tautology ∧ minInstancesRaw, counted once,
// repo-wide, before any scoring, never recomputed within a build." Decorative
// roles' candidates ARE counted here — demotion is an OUTPUT filter applied
// after scoring (its own stage below), never a retroactive resize of `C`.
// ---------------------------------------------------------------------------

function isTautological(cell: CellRecord, surface: string, definingFeatureGroupsByRoleKey: ReadonlyMap<string, readonly string[]>): boolean {
  if (cell.cellClass !== 'role') return false; // `_all` and directory cells are exempt (§7.3's own words)
  const groups = definingFeatureGroupsByRoleKey.get(cell.roleKey as string) ?? [];
  const group = overlapGroupForSurface(surface);
  return group !== undefined && groups.includes(group);
}

function countCandidatesRepoWide(
  allPartitionCells: readonly { cellId: string; record: CellRecord }[],
  definingFeatureGroupsByRoleKey: ReadonlyMap<string, readonly string[]>,
  minInstancesRaw: number,
): number {
  let c = 0;
  for (const { record } of allPartitionCells) {
    for (const [surface, byValue] of record.counts.raw) {
      if (isTautological(record, surface, definingFeatureGroupsByRoleKey)) continue;
      if (sumMapValues(byValue) < minInstancesRaw) continue;
      c++;
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Stage: score every non-tautological, non-decorative-role candidate into a
// `MinedFact` — §9.4a ACCEPTANCE (bits_saved/n_raw/n_eff only), the §9.4d
// vacuous filter (a real REMOVAL, unlike eligibility), then §9.4c HOOK
// ELIGIBILITY as FLAG-SETTERS (facts stay accepted either way — the
// prototype's continue-drops on all four gates do NOT port).
// ---------------------------------------------------------------------------

interface ScoredFact extends MinedFact {
  /** Internal-only: this fact's cell, for the pruning/dedup stages below (never serialized). */
  _cellId: string;
}

function scorePartitionFacts(
  partitionCells: readonly CellRecord[],
  candidateSurfacesByKind: ReadonlyMap<string, string[]>,
  alphabets: ReadonlyMap<string, string[]>,
  definingFeatureGroupsByRoleKey: ReadonlyMap<string, readonly string[]>,
  decorativeRoleKeys: ReadonlySet<string>,
  seededKeys: ReadonlySet<string>,
  trueRawBySurface: ReadonlyMap<string, number>,
  idxCost: number,
  config: RootsConfig,
  isHookShapedOf: (stableId: string, surface: string) => boolean,
): { facts: ScoredFact[]; parentExpByKindSurface: Map<string, string | null> } {
  const cellsByCellId = new Map(partitionCells.map((c) => [c.cellId, c]));
  const parentExpByKindSurface = new Map<string, string | null>();

  // `_all`'s own expected value per (kind, surface) — needed as both a real
  // fact candidate AND every role/dir fact's `parentExp`, so it is scored
  // exactly once per surface here.
  for (const cell of partitionCells) {
    if (cell.cellClass !== 'all') continue;
    for (const surface of candidateSurfacesByKind.get(cell.kind) ?? []) {
      const bool = isBooleanSurface(surface);
      const alphabetValues = bool ? ['true', 'false'] : (alphabets.get(surface) ?? []);
      if (alphabetValues.length === 0) continue;
      const weighted = cell.counts.weighted.get(surface) ?? new Map<string, number>();
      const scored = scoreCandidate(weighted, alphabetValues, bool ? 2 : alphabetValues.length + 1, true, null, 0, idxCost);
      parentExpByKindSurface.set(`${cell.kind}\u0001${surface}`, scored.nEff > 0 ? scored.expected : null);
    }
  }

  const facts: ScoredFact[] = [];
  for (const cell of partitionCells) {
    if (cell.cellClass === 'role' && decorativeRoleKeys.has(cell.roleKey as string)) continue; // decorative-role demotion
    const allCell = cell.cellClass === 'all' ? undefined : cellsByCellId.get(allCellId(cell.kind));
    for (const surface of candidateSurfacesByKind.get(cell.kind) ?? []) {
      if (isTautological(cell, surface, definingFeatureGroupsByRoleKey)) continue;
      const nRaw = sumMapValues(cell.counts.raw.get(surface));
      if (nRaw < config.mdl.minInstancesRaw) continue;

      const bool = isBooleanSurface(surface);
      const alphabetValues = bool ? ['true', 'false'] : (alphabets.get(surface) ?? []);
      if (alphabetValues.length === 0) continue;
      const k = bool ? 2 : alphabetValues.length + 1;
      const weighted = cell.counts.weighted.get(surface) ?? new Map<string, number>();

      const isAllCell = cell.cellClass === 'all';
      const baseline = isAllCell ? null : (allCell?.counts.weighted.get(surface) ?? new Map<string, number>());
      const baselineNEff = isAllCell ? 0 : sumMapValues(allCell?.counts.weighted.get(surface));
      const scored = scoreCandidate(weighted, alphabetValues, k, isAllCell, baseline, baselineNEff, idxCost);

      if (scored.nEff < config.mdl.minInstancesEff) continue;
      if (scored.bitsSaved < config.mdl.acceptMarginBits) continue;

      // §9.4d vacuous filter: `_all`-only, boolean, expected=false, and the
      // COMPLEMENT (true) has zero raw REAL instances ANYWHERE IN THE
      // PARTITION (spec's own words, `v6-spec.md:419`) — genuinely
      // partition-wide, summed across EVERY kind, not just this cell's own
      // kind: a cross-kind surface (`auto.deco:`/`auto.extends:`, whose
      // domain spans method+type) can be true on one kind and never-true on
      // another, and the OTHER kind's own true instances are exactly what
      // makes "methods here never use @X" a real, mineable local absence
      // rather than a vocabulary artifact — checking only THIS cell's own
      // kind would (wrongly) call that vacuous. `trueRawBySurface` is
      // pre-summed across every kind's `_all` cell for exactly this check.
      if (isAllCell && bool && scored.expected === 'false') {
        const trueRaw = trueRawBySurface.get(surface) ?? 0;
        if (trueRaw === 0) continue;
      }

      const survivedRaw = cell.counts.survivedRaw.get(surface) ?? new Map<string, number>();
      const nTotalRaw = sumMapValues(survivedRaw);
      const nConformRaw = survivedRaw.get(scored.expected) ?? 0;

      const { tau, absence } = tauFor(surface, bool, scored.expected, config.thresholds);
      const gate1 = !isFallbackBucket(scored.expected);
      const gate2 = !isPlacementSurface(surface) || cell.cellClass === 'role';
      const gate3 = isFireable(scored.nExpectedWeighted, scored.nRunnerUpWeighted, tau);
      const gate4 = nTotalRaw >= config.mdl.minInstancesRaw && nConformRaw / nTotalRaw >= config.thresholds.eligibilityMinRawShare;
      const hookEligible = gate1 && gate2 && gate3 && gate4;

      const roleKeyField = cell.cellClass === 'all' ? '_all' : cell.cellClass === 'role' ? (cell.roleKey as string) : dirIdentity(cell.dir as string);
      const parentExp = isAllCell ? null : (parentExpByKindSurface.get(`${cell.kind}\u0001${surface}`) ?? null);
      const share = scored.nEff > 0 ? scored.nExpectedWeighted / scored.nEff : 0;
      // Built via `Map` + `Object.fromEntries`, never bracket-assignment on a
      // plain object: `v` is a mined VALUE (a real repository token), which
      // can legitimately equal `'__proto__'` — `countsRecord[v] = ...` on a
      // plain `{}` would silently be swallowed as a prototype-chain write
      // instead of an own property (verified), dropping that value from the
      // serialized `counts` entirely. `Map.set` carries no such hazard
      // (this file's own header/`mine-stages.ts`'s own convention).
      const countsMap = new Map<string, string>();
      for (const v of alphabetValues) countsMap.set(v, formatCanonicalDecimal(weighted.get(v) ?? 0));
      const countsRecord: Record<string, string> = Object.fromEntries(countsMap);

      // §9.4d Appendix D's own worked record (`nConformRaw:10,nTotalRaw:10,
      // deviantsN:1`) proves `deviantsN` is NOT `nTotalRaw - nConformRaw`
      // (that difference is 0 there) — it is the RAW (not survived-only)
      // population: every raw instance whose value differs from `expected`,
      // regardless of survival (prototype-roots2.mjs:246-247's own
      // `deviants` — built from `cell.members[v]`, populated for EVERY real
      // instance passed to `add()` with `surv` tracked separately and never
      // gating membership).
      const rawByValue = cell.counts.raw.get(surface) ?? new Map<string, number>();
      const nTotalRawAll = sumMapValues(rawByValue);
      const nConformRawAll = rawByValue.get(scored.expected) ?? 0;

      // Real count (R4 Task 8): among this fact's own raw CONFORMING members
      // (value === expected — the same population `nConformRawAll` sums),
      // how many carry an unreleased ledger mark on THIS fact's own surface.
      // `cell.counts.members` records every REAL (non-seed) instance
      // regardless of survival (`addCount`'s own contract), so this reads
      // the identical membership `nConformRawAll`/`deviantsN` already read —
      // never a second, differently-scoped population.
      const conformMembers = cell.counts.members.get(surface)?.get(scored.expected) ?? [];
      let hookShapedConform = 0;
      for (const stableId of conformMembers) {
        if (isHookShapedOf(stableId, surface)) hookShapedConform++;
      }

      facts.push({
        _cellId: cell.cellId,
        factKey: `${roleKeyField}|${surface}`,
        roleKey: roleKeyField,
        surface,
        appliesKind: cell.kind,
        expected: scored.expected,
        counts: countsRecord,
        alphabet: alphabetValues,
        nConformRaw,
        nTotalRaw,
        share,
        bitsPerInstance: scored.bitsPerInstance,
        bitsSaved: scored.bitsSaved,
        nSurfaces: 1,
        tau,
        absence,
        hookEligible,
        seeded: seededKeys.has(`${cell.cellId}\u0001${surface}`),
        parentExp,
        deviantsN: nTotalRawAll - nConformRawAll,
        hookShapedConform,
        denyEligible: false,
        suppressedValue: null,
      });
    }
  }

  return { facts, parentExpByKindSurface };
}

/** §9.4i's directory-cell identity, riding `MinedFact.roleKey`'s slot — see that field's own doc. */
function dirIdentity(dir: string): string {
  return `d[${dir}]`;
}

// ---------------------------------------------------------------------------
// Stage: §9.4i redundant-refinement pruning (directory facts only, applied
// BEFORE dedup) — a directory fact that merely re-says a wider or shallower
// kept fact is dropped: it removes no information, since the wider/shallower
// fact still governs those scopes.
// ---------------------------------------------------------------------------

function pruneRedundantDirectoryFacts(facts: readonly ScoredFact[]): ScoredFact[] {
  const acceptedAllKeys = new Set<string>();
  for (const f of facts) if (f.roleKey === '_all') acceptedAllKeys.add(`${f.appliesKind}\u0001${f.surface}\u0001${f.expected}`);

  // Rule 1: a directory fact whose own expected equals its parent's AND an
  // accepted `_all` fact already states the same (kind, surface, expected).
  const afterRule1 = facts.filter((f) => {
    if (!f.roleKey.startsWith('d[')) return true;
    if (f.expected !== f.parentExp) return true;
    return !acceptedAllKeys.has(`${f.appliesKind}\u0001${f.surface}\u0001${f.expected}`);
  });

  // Rule 2: a deeper directory restating a (kind, surface, expected) already
  // kept for a SHALLOWER directory — shallowest wins. Process shallowest
  // (fewest '/' segments) first so `kept` only ever holds ancestors already
  // decided.
  const dirDepth = (roleKey: string): number => roleKey.slice(2, -1).split('/').length;
  const sorted = [...afterRule1].sort((a, b) => {
    const da = a.roleKey.startsWith('d[') ? dirDepth(a.roleKey) : -1;
    const db = b.roleKey.startsWith('d[') ? dirDepth(b.roleKey) : -1;
    return da - db;
  });
  const keptDirsByKey = new Map<string, string[]>(); // `${kind}\u0001${surface}\u0001${expected}` -> kept dir paths
  const out: ScoredFact[] = [];
  for (const f of sorted) {
    if (!f.roleKey.startsWith('d[')) {
      out.push(f);
      continue;
    }
    const dir = f.roleKey.slice(2, -1);
    const key = `${f.appliesKind}\u0001${f.surface}\u0001${f.expected}`;
    const kept = keptDirsByKey.get(key) ?? [];
    if (kept.some((kd) => dir.startsWith(`${kd}/`))) continue; // a shallower ancestor already states this — drop
    kept.push(dir);
    keptDirsByKey.set(key, kept);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage: §9.4e correlation dedup, WITHIN THE SAME CELL — iterate accepted
// candidates descending bits-per-instance; assign each to the first existing
// cluster whose LEAD's conform set it Jaccard-matches (>= mdl.dedupJaccard),
// else start a new cluster. The lead (highest bpi, ties surface asc) becomes
// the FACT; the rest are folded into its `nSurfaces` count and dropped from
// the output list (shown only in `explain`, out of this increment's scope).
// ---------------------------------------------------------------------------

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) if (large.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupFacts(facts: readonly ScoredFact[], conformSetOf: (fact: ScoredFact) => ReadonlySet<string>, dedupJaccard: number): ScoredFact[] {
  const sorted = [...facts].sort((a, b) => b.bitsPerInstance - a.bitsPerInstance || (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));
  const clusters: { cellId: string; leadIndex: number; conformSet: ReadonlySet<string>; count: number }[] = [];
  const out: ScoredFact[] = [];
  for (const f of sorted) {
    const set = conformSetOf(f);
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.cellId !== f._cellId) continue;
      if (jaccard(cluster.conformSet, set) >= dedupJaccard) {
        cluster.count++;
        out[cluster.leadIndex].nSurfaces = cluster.count;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ cellId: f._cellId, leadIndex: out.length, conformSet: set, count: 1 });
      out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage: §9.4h cull — top `mdl.factCap` FACTs per partition by bits-per-instance.
// ---------------------------------------------------------------------------

function cullFacts(facts: readonly ScoredFact[], factCap: number): MinedFact[] {
  const sorted = [...facts].sort((a, b) => b.bitsPerInstance - a.bitsPerInstance || (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));
  return sorted.slice(0, factCap).map(({ _cellId, ...rest }) => {
    void _cellId;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Stage: moduleOfFile — recovers each FILE's own module directory from the
// `module`-kind `ScopeUnit`s `finalizeUnits` (`extract.ts`) ALREADY minted
// into `units`, rather than re-deriving the resolution independently.
//
// An earlier version of this stage re-implemented `finalizeUnits`' own
// ≥3-direct-code-files walk from scratch, counting direct files ONLY from
// `partitionUnits` (this ONE partition's own file population). That counted
// a DIFFERENT population than `finalizeUnits` did — `finalizeUnits` counts
// `directFileCountByDir` REPO-WIDE, before partitioning is even consulted
// per-file (`extract.ts:672`) — so a directory whose ≥3-files threshold was
// cleared repo-wide (crossing a partition boundary partway through the
// module-resolution walk, the `_repo`-merge case §6.8 produces) could read
// under-3 from this file's own narrower re-count, silently resolving a
// DIFFERENT module directory than the one `finalizeUnits` actually minted a
// `module` unit for — a `moduleOfFile` entry pointing at a directory with no
// corresponding cell in this same mining pass.
//
// The fix removes the re-derivation entirely: `finalizeUnits`' own walk
// stops at, and mints a `module` unit for, EXACTLY the directory each file
// resolves to (`extract.ts:680-710`, including its own fail-safe fallback to
// the repo root `''` when no ancestor ever matches — that fallback ALSO
// mints a `''`-keyed module unit whenever it fires). So the set of THIS
// partition's own minted module directories is already the complete,
// authoritative answer set; a file's module is simply the NEAREST ancestor
// directory (walking up from its own containing directory) that is a member
// of that set — no file-counting, no threshold, no risk of disagreeing with
// what `finalizeUnits` decided, by construction. Every file's walk is
// guaranteed to terminate inside that set, because `finalizeUnits` visited
// the identical directory chain for the identical file and minted a module
// at whichever directory stopped ITS walk. `moduleDirs.has(dir)` never
// returns false all the way to `''` in practice — the defensive break below
// exists only so a future inconsistency fails soft (the file's entry is
// OMITTED — the honest "no module resolvable" outcome, never a fabricated
// `''`) rather than looping or crashing.
// ---------------------------------------------------------------------------

function computeModuleOfFile(partitionUnits: readonly ScopeUnit[]): Record<string, string> {
  const moduleDirs = new Set<string>();
  for (const u of partitionUnits) if (u.kind === 'module') moduleDirs.add(u.relPath);

  const out = new Map<string, string>();
  for (const u of partitionUnits) {
    if (u.kind !== 'file') continue;
    let dir = dirnameOf(u.relPath);
    for (;;) {
      if (moduleDirs.has(dir)) {
        out.set(u.relPath, dir);
        break;
      }
      const parent = dirnameOf(dir);
      if (parent === dir) break; // '' with no minted module for it — omit rather than fabricate (see this stage's own header)
      dir = parent;
    }
  }
  return Object.fromEntries(out);
}

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

export function mine(input: MineInput): MineResult {
  const { units, bags, domains, vocab, partitions, roles, seeds, config, weightFn, ageFn, surfaceWeightFn, hookShapedFn } = input;

  const bagByStableId = new Map(bags.map((b) => [b.stableId, b]));
  const bagOf = (stableId: string): FeatureBag => bagByStableId.get(stableId) as FeatureBag;
  const unitByStableId = new Map(units.map((u) => [u.stableId, u]));
  // `w_base` — per-SCOPE (D7). Still what `role_lift`'s own divisor
  // (`computeRoleLiftForPartition`) and `induceRoles`/§8.9b read.
  const weightOf = (stableId: string): number => weightFn(unitByStableId.get(stableId) as ScopeUnit);
  // `w(s,q)` — per-(scope, surface) SIBLING of `weightOf` (D7, R4 Task 8):
  // every REAL-instance cell count (`countRealInstancesIntoCell`'s own
  // caller) routes through this one, never through `weightOf` directly.
  // Absent `surfaceWeightFn` falls back to `weightFn` — the R1-R3 degraded
  // default, where every instance weighed the identical constant regardless
  // of surface, so falling back changes nothing observable.
  const surfaceWeightOf = (stableId: string, surface: string): number => {
    const unit = unitByStableId.get(stableId) as ScopeUnit;
    return surfaceWeightFn ? surfaceWeightFn(unit, surface) : weightFn(unit);
  };
  const isHookShapedOf = (stableId: string, surface: string): boolean => {
    if (!hookShapedFn) return false;
    return hookShapedFn(unitByStableId.get(stableId) as ScopeUnit, surface);
  };
  // Fail-closed survived-raw (§9.4c, AGENTS.md's own global constraint): an
  // ABSENT AgeFn means every instance is unsurvived — never the prototype's
  // fail-open `true` default. An unreleased ledger mark on THIS surface
  // additionally excludes the instance from the survived population (R4-I5's
  // own second half, MR-24): roots-shaped code neither appears as evidence
  // nor props up eligibility until the mark releases.
  const survivedOf = (stableId: string, surface: string): boolean => {
    if (!ageFn) return false;
    if (isHookShapedOf(stableId, surface)) return false;
    return ageFn(unitByStableId.get(stableId) as ScopeUnit) >= config.weights.freshPenaltyDays;
  };

  const definingFeatureGroupsByRoleKey = new Map<string, readonly string[]>();
  for (const r of roles.roles) definingFeatureGroupsByRoleKey.set(r.roleKey, r.definingFeatureGroups);

  // Phase A: build every partition's cells (real instances, then seeds).
  interface PartitionWorkingState {
    cellSet: PartitionCellSet;
    partitionUnits: ScopeUnit[];
    rolesForPartition: typeof roles.roles;
    seededKeys: Set<string>;
  }
  const perPartition = new Map<string, PartitionWorkingState>();
  for (const partitionId of partitions.survivingPartitionIds) {
    const partitionUnits = units.filter((u) => u.partitionId === partitionId);
    const rolesForPartition = roles.roles.filter((r) => r.partitionId === partitionId);
    const cellSet = buildPartitionCells(partitionId, partitionUnits, bagOf, domains, rolesForPartition, config, surfaceWeightOf, survivedOf, roles.assignments, roles.ambiguousRank1);
    const cellsByCellId = new Map(cellSet.cells.map((c) => [c.cellId, c]));
    const seededKeys = new Set<string>();
    injectSeeds(cellsByCellId, partitionUnits, seeds, bagOf, roles.assignments, roles.ambiguousRank1, config.weights.seedCapFraction, seededKeys);
    perPartition.set(partitionId, { cellSet, partitionUnits, rolesForPartition, seededKeys });
  }

  // Phase A.5: role_lift + decorative demotion, per partition, from the
  // (now seed-joined) counts.
  const decorativeRoleKeys = new Set<string>();
  const roleLiftByKey = new Map<string, number>();
  for (const [, { cellSet, partitionUnits, rolesForPartition }] of perPartition) {
    const cellsByCellId = new Map(cellSet.cells.map((c) => [c.cellId, c]));
    const liftMap = computeRoleLiftForPartition(
      '',
      rolesForPartition,
      cellsByCellId,
      cellSet.candidateSurfacesByKind,
      cellSet.alphabets,
      partitionUnits,
      roles.assignments,
      roles.ambiguousRank1,
      weightOf,
    );
    for (const [roleKey, lift] of liftMap) {
      roleLiftByKey.set(roleKey, lift);
      if (isDecorativeRole(lift)) decorativeRoleKeys.add(roleKey);
    }
  }

  // Phase B: `C`, repo-wide, once — tautology skip applied, decorative roles
  // still counted (see `countCandidatesRepoWide`'s own header).
  const allCellsFlat: { cellId: string; record: CellRecord }[] = [];
  for (const { cellSet } of perPartition.values()) for (const record of cellSet.cells) allCellsFlat.push({ cellId: record.cellId, record });
  const candidateCount = countCandidatesRepoWide(allCellsFlat, definingFeatureGroupsByRoleKey, config.mdl.minInstancesRaw);
  const idxCost = indexCostBits(candidateCount);
  const candidateCountLog2 = idxCost;

  // Phase C: score, filter, prune, dedup, cull — per partition.
  const outPartitions: MinedPartition[] = [];
  for (const partitionId of [...perPartition.keys()].sort()) {
    const { cellSet, partitionUnits, rolesForPartition, seededKeys } = perPartition.get(partitionId) as PartitionWorkingState;
    const { facts: scored } = scorePartitionFacts(
      cellSet.cells,
      cellSet.candidateSurfacesByKind,
      cellSet.alphabets,
      definingFeatureGroupsByRoleKey,
      decorativeRoleKeys,
      seededKeys,
      cellSet.trueRawBySurface,
      idxCost,
      config,
      isHookShapedOf,
    );
    const pruned = pruneRedundantDirectoryFacts(scored);
    const cellsByCellId = new Map(cellSet.cells.map((c) => [c.cellId, c]));
    const conformSetOf = (f: ScoredFact): ReadonlySet<string> => {
      const cell = cellsByCellId.get(f._cellId);
      const members = cell?.counts.members.get(f.surface)?.get(f.expected);
      return new Set(members ?? []);
    };
    const deduped = dedupFacts(pruned, conformSetOf, config.mdl.dedupJaccard);
    const culled = cullFacts(deduped, config.mdl.factCap);

    const vocabForPartition = vocab.get(partitionId) ?? { nodeType: [], call: [], decorator: [], import: [], supertype: [], shape: [] };
    const roleOut: MinedRole[] = rolesForPartition
      .map((r) => ({
        roleKey: r.roleKey,
        label: r.label,
        size: r.size,
        medoidFeatures: r.medoidFeatures,
        definingFeatureGroups: r.definingFeatureGroups,
        roleLift: roleLiftByKey.get(r.roleKey) ?? 0,
        ambiguityRate: r.ambiguityRate,
      }))
      .sort((a, b) => (a.roleKey < b.roleKey ? -1 : 1));

    const partitionAssignments: Record<string, string> = {};
    for (const u of partitionUnits) {
      const value = roles.assignments[u.skeyR];
      if (value !== undefined) partitionAssignments[u.skeyR] = value;
    }

    const seedsOut: MinedSeed[] = [];
    for (const seed of seeds) {
      const found = partitionUnits.some((u) => u.relPath === seed.scopeRef.path && u.qualifiedName === seed.scopeRef.qualifiedName);
      if (found) seedsOut.push({ seedId: seed.seedId, surfaces: seed.surfaces, tension: null });
    }

    outPartitions.push({
      id: partitionId,
      vocab: vocabForPartition,
      alphabets: Object.fromEntries(cellSet.alphabets),
      roles: roleOut,
      assignments: partitionAssignments,
      facts: culled,
      moduleOfFile: computeModuleOfFile(partitionUnits),
      seeds: seedsOut,
      // couplingByFile/couplingByModule (D9-adjacent absence): projected from
      // the repo-global co-change cut, which `mine()` never sees — wired in
      // by `runRootsIndex`/`buildHistoryJoin` after this returns (Files list:
      // "put any helper that computes any of them in history.ts, not in
      // mine.ts"). Left unset here, never defaulted to `{}`.
    });
  }

  // `agentShare: null` — the honest "no history" default (§18.4's own "n/a",
  // R4-I4). `mine()` itself never joins history (it has no `HistoryJoin` to
  // read); the caller (`runRootsIndex`) overwrites this with the join's real
  // computed value — 0 or a genuine share — only when a join exists.
  return { body: { partitions: outPartitions, agentShare: null }, candidateCountLog2 };
}
