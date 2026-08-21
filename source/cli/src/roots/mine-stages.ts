/**
 * source/cli/src/roots/mine-stages.ts — the cell-building and pure-scoring
 * half of spec §9's MDL acceptance chain, split out of `mine.ts` purely to
 * stay comfortably under the reviewer's `max_prompt_chars` ceiling (repo-check's
 * headroom step; the plan's own "split stages into a second engine file"
 * allowance). `mine.ts` owns the per-partition/per-repo ORCHESTRATION (which
 * cells exist, in what order the named stages run, how `MinedModel` is
 * assembled); this file owns the MATH each stage calls: cell counting from
 * `enumerate.ts`'s sparse bags + domains (never `|cell| - n_true` — always
 * `|domain ∩ members| - n_true`, computed by iterating the domain-restricted
 * member set directly, spec §5), and §9.3's KT-smoothed §9.4a/b scoring.
 *
 * COUNTS LIVE IN `Map<string, number>`, NEVER a plain object, throughout this
 * file — a mined VALUE (a real repository token: a directory segment, a call
 * name, a decorator name, …) can legitimately equal the literal string
 * `"constructor"` (or `"toString"`, `"__proto__"`, …), and `Map.get`/`.set`
 * carry no `Object.prototype` collision risk the way bracket access on a
 * plain object would (AGENTS.md's "null-prototype/own-property reads on
 * every mined-value map" — using `Map` satisfies that by construction rather
 * than needing a `hasOwnProperty` guard at every read, this repo's OTHER
 * established pattern for the same hazard, e.g. `roles.ts`'s `ktPosterior`).
 * Only at the very end, assembling the SERIALIZED `MinedFact.counts` (a plain
 * `Record<string,string>` per Appendix D's JSON shape), does a `Map` convert
 * to an object — via `Object.fromEntries`, which never reads a pre-existing
 * key, so no guard is needed there either.
 */

import type { ScopeKind } from './extract.js';
import type { FeatureBag, DomainMap } from './enumerate.js';

// ---------------------------------------------------------------------------
// Small pure helpers shared by every stage.
// ---------------------------------------------------------------------------

/** Spec §6.8-style ancestor-directory chain of a relPath's own containing directory, root-to-leaf, EXCLUDING the repo root itself (a root-level file yields `[]`) — mirrors `prototype-roots2.mjs`'s `dirsOf`, the §9.4i directory-context ancestor walk. */
export function ancestorDirsOf(relPath: string): string[] {
  const segments = relPath.split('/').slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) out.push(segments.slice(0, i).join('/'));
  return out;
}

/**
 * Spec §5's closed-alphabet boolean surfaces are exactly the six vocabulary-
 * bearing prefixes `enumerate.ts`'s `emitBool` ever calls (`auto.has:`,
 * `auto.call:`, `auto.deco:`, `auto.extends:`, `auto.imp:`, `auto.stshape:`) —
 * every OTHER surface id `enumerate.ts` ever emits goes through `emitCat`, so
 * this fixed prefix set is the complete, exhaustive boolean/categorical split
 * (mirrors `prototype-roots2.mjs`'s own `isBool` regex).
 */
const BOOLEAN_SURFACE_RE = /^auto\.(has|call|deco|extends|imp|stshape):/;
export function isBooleanSurface(surfaceId: string): boolean {
  return BOOLEAN_SURFACE_RE.test(surfaceId);
}

/** Spec §9.4f's structural-absence tier applies to exactly `auto.has:<t>` and `auto.stshape:<shape>` (the two grammar-shape surfaces); every other boolean surface uses the vocabulary-absence tier. */
const STRUCTURAL_ABSENCE_RE = /^auto\.(has|stshape):/;
export function isStructuralAbsenceSurface(surfaceId: string): boolean {
  return STRUCTURAL_ABSENCE_RE.test(surfaceId);
}

/**
 * The §7.3 identity/behavior split. No export of this classification exists
 * anywhere upstream in `src/roots/**`, so it is built fresh here, directly
 * from the spec's own words: "Every surface is `identity` (what/where the
 * scope is: E1, E2, E7, E12) or `behavior` (how it is written: E3-E6,
 * E8-E11)" (`v6-spec.md:306`). E1 = `auto.nameshape` / `auto.filenameshape`;
 * E2 = `auto.arity`; E7 = `auto.dir<N>`; E12 (wholesale — every module-level
 * surface) = `auto.moddirshape` / `auto.modsize` / `auto.modfileshape`.
 * Every other surface this repo's twelve enumerators emit is behavior-class.
 * MUST be applied BEFORE calling `roles.ts`'s `roleLift`: an identity
 * surface trivially "predicts" its own cluster (clustering itself was built
 * from name/supertype/decorator/import features), which would inflate lift
 * and silently suppress decorative demotion for an otherwise-unconvincing
 * role — the exact failure mode a held-out set exists to prevent.
 */
const IDENTITY_SURFACE_RULES: readonly RegExp[] = [
  /^auto\.nameshape$/,
  /^auto\.filenameshape$/,
  /^auto\.arity$/,
  /^auto\.dir\d+$/,
  /^auto\.moddirshape$/,
  /^auto\.modsize$/,
  /^auto\.modfileshape$/,
];
export type SurfaceClass = 'identity' | 'behavior';
export function surfaceClassOf(surfaceId: string): SurfaceClass {
  return IDENTITY_SURFACE_RULES.some((re) => re.test(surfaceId)) ? 'identity' : 'behavior';
}

/**
 * Appendix D's `counts` field is CANONICAL DECIMAL STRINGS (`"true":"24.2"`),
 * a determinism-relevant encoding the byte-identity control depends on —
 * floating weighted sums (every instance weighs a fraction like 0.3) pick up
 * IEEE-754 noise (`2.0999999999999996`) that must round to the SAME string on
 * every build. Fixed to 6 decimal places (comfortably past this product's
 * weight/share precision, never itself displayed) then trailing zeros (and a
 * bare trailing `.`) trimmed, so an exact integer prints unpadded (`"24"`,
 * never `"24.0"`) — matching this repo's own canonical-JSON convention
 * (`stores.ts`), which never pads either.
 */
export function formatCanonicalDecimal(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const fixed = n.toFixed(6);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Cell counting — one (cell, surface) accumulator per candidate.
// ---------------------------------------------------------------------------

/** Per-surface, per-value accumulators for one cell (`_all:<kind>`, `<roleKey>:<kind>`, or `d[<dir>]:<kind>`). Every map is `surface -> value -> number` (or `-> stableId[]` for `members`). */
export interface CellCounts {
  /** Weighted n_v, REAL instances plus any seed contribution (§9.2 — seeds join before scoring). This is what §9.4's `data_term`/posteriors read. */
  weighted: Map<string, Map<string, number>>;
  /** Raw (unweighted, rw=1) n_v, REAL instances only — seeds excluded (§9.4a's own "n_raw = real instances, seeds excluded"). Drives `C`'s `minInstancesRaw` gate and `nTotalRaw`/`nConformRaw`'s denominator alongside the survived-only map below. */
  raw: Map<string, Map<string, number>>;
  /** Raw n_v among REAL, SURVIVED instances only (§9.4c.4's displayed population) — a strict subset of `raw`. */
  survivedRaw: Map<string, Map<string, number>>;
  /** REAL (non-seed) member stableIds per (surface, value) — the §9.4e dedup "conform set" is `members.get(surface).get(expected)`. */
  members: Map<string, Map<string, string[]>>;
}

export function emptyCellCounts(): CellCounts {
  return { weighted: new Map(), raw: new Map(), survivedRaw: new Map(), members: new Map() };
}

function bumpMap(byValue: Map<string, number>, value: string, amount: number): void {
  byValue.set(value, (byValue.get(value) ?? 0) + amount);
}

function ensureSurface(bySurface: Map<string, Map<string, number>>, surface: string): Map<string, number> {
  let byValue = bySurface.get(surface);
  if (!byValue) {
    byValue = new Map();
    bySurface.set(surface, byValue);
  }
  return byValue;
}

/** Adds one instance's contribution to `cell` for `(surface, value)`. `stableId === null` marks a seed pseudo-instance — never recorded in `members` (§9.2: seeds are "excluded from ... raw-count gates", and a seed has no real conform-set membership to contribute — mirrors the prototype's own `gi = -1` seed convention). */
export function addCount(
  cell: CellCounts,
  surface: string,
  value: string,
  weighted: number,
  raw: number,
  survived: boolean,
  stableId: string | null,
): void {
  bumpMap(ensureSurface(cell.weighted, surface), value, weighted);
  bumpMap(ensureSurface(cell.raw, surface), value, raw);
  if (survived) bumpMap(ensureSurface(cell.survivedRaw, surface), value, raw);
  if (stableId !== null) {
    let bySurface = cell.members.get(surface);
    if (!bySurface) {
      bySurface = new Map();
      cell.members.set(surface, bySurface);
    }
    let arr = bySurface.get(value);
    if (!arr) {
      arr = [];
      bySurface.set(value, arr);
    }
    arr.push(stableId);
  }
}

/** Sums a per-value `Map` (helper for total-n_eff / total-n_raw reads). */
export function sumMapValues(byValue: ReadonlyMap<string, number> | undefined): number {
  if (!byValue) return 0;
  let total = 0;
  for (const v of byValue.values()) total += v;
  return total;
}

/**
 * Counts one cell's REAL-instance contribution for every `candidateSurfaces`
 * entry applicable to `kind`, over `memberIds`. For a BOOLEAN surface this is
 * the spec §5 domain-restricted reconstruction: iterate `domain(surface) ∩
 * memberIds` (never `|cell| - n_true` — a scope outside the surface's own
 * applicability domain contributes NOTHING, undecidable ≠ false) and bucket
 * each member into `'true'`/`'false'` by whether the surface key is present
 * in its bag (sparse storage: present ⇒ true). For a CATEGORICAL surface the
 * same domain-restricted iteration reads the member's own recorded value
 * directly (dense within its domain — `enumerate.ts`'s `emitCat` always sets
 * a value for every domain member).
 *
 * `weightOf`/`survivedOf` are PER-(stableId, surface) — R4's own widening
 * (D7): §9.1's `w(s,q)` and §9.4c's survived-raw population are both defined
 * per (scope, surface), because the ledger cap keys on exactly that pair — a
 * scope conforming on two surfaces at once can carry an unreleased mark on
 * only one of them, capping that surface's weight while leaving the other's
 * untouched. The caller decides what "surface-aware" means for a given cell
 * (a role cell's own half-weight-for-ambiguous-members factor is folded in
 * there, not here); this function only ever forwards the surface it is
 * already iterating over.
 */
export function countRealInstancesIntoCell(
  cell: CellCounts,
  memberIds: ReadonlySet<string>,
  candidateSurfaces: readonly string[],
  domains: DomainMap,
  bagOf: (stableId: string) => FeatureBag,
  weightOf: (stableId: string, surface: string) => number,
  survivedOf: (stableId: string, surface: string) => boolean,
): void {
  for (const surface of candidateSurfaces) {
    const domainSet = domains.get(surface);
    if (!domainSet) continue;
    const bool = isBooleanSurface(surface);
    // Iterate the SMALLER of (domain, members) — cells range from `_all`
    // (memberIds = every scope of the kind) down to a small role/dir cell, so
    // scanning `memberIds` and probing `domainSet.has()` is the cheap
    // direction whichever side is smaller in practice for this product's
    // fixture sizes; both sides are already `Set`s, so either order is
    // correct — this one just reads more naturally against "cell members".
    for (const stableId of memberIds) {
      if (!domainSet.has(stableId)) continue;
      const bag = bagOf(stableId);
      const value = bool ? (bag.surfaces[surface] === 'true' ? 'true' : 'false') : bag.surfaces[surface];
      if (value === undefined) continue; // defensive: a categorical surface's domain member always carries a value in practice (enumerate.ts's own contract)
      addCount(cell, surface, value, weightOf(stableId, surface), 1, survivedOf(stableId, surface), stableId);
    }
  }
}

// ---------------------------------------------------------------------------
// §9.3/§9.4a-b scoring — KT-smoothed posteriors, data_term, param_cost.
// ---------------------------------------------------------------------------

/** §9.3's KT-smoothed posterior over a `Map`-shaped count table: `p̂(x) = (n_x + 1/2) / (n_eff + K/2)`. No `hasOwnProperty` guard needed — see this file's header for why `Map` sidesteps the hazard entirely. */
export function ktPosteriorFromMap(counts: ReadonlyMap<string, number>, value: string, nEff: number, k: number): number {
  return ((counts.get(value) ?? 0) + 0.5) / (nEff + k / 2);
}

export interface ScoredCandidate {
  expected: string;
  nExpectedWeighted: number;
  nRunnerUpWeighted: number;
  dataTerm: number;
  paramCost: number;
  bitsSaved: number;
  bitsPerInstance: number;
  nEff: number;
}

/**
 * Spec §9.4a (role/dir-conditioned, `isAllCell = false`, baseline = the
 * partition's own `_all` cell posterior) and §9.4b (`_all` itself,
 * `isAllCell = true`, baseline = uniform over `B = max(|V|, 2)`).
 * `alphabetValues` MUST be in a FIXED order (`['true','false']` for booleans,
 * the sorted partition alphabet for categoricals) — `expected`'s tie-break
 * ("first max wins", mirroring the prototype's own strict-`>` scan) depends
 * on it. `idxCost` is the shared, repo-wide `log2(C₂)` every cell's `bits`
 * subtracts (computed once by the caller from the FULL candidate count, per
 * §9.4a's own "counted once, repo-wide ... never recomputed within a build").
 */
export function scoreCandidate(
  weightedCounts: ReadonlyMap<string, number>,
  alphabetValues: readonly string[],
  k: number,
  isAllCell: boolean,
  baselineCounts: ReadonlyMap<string, number> | null,
  baselineNEff: number,
  idxCost: number,
): ScoredCandidate {
  let nEff = 0;
  for (const v of alphabetValues) nEff += weightedCounts.get(v) ?? 0;

  let data = 0;
  if (isAllCell) {
    const B = Math.max(alphabetValues.length, 2);
    for (const v of alphabetValues) {
      const nv = weightedCounts.get(v) ?? 0;
      if (nv === 0) continue;
      data += nv * Math.log2(ktPosteriorFromMap(weightedCounts, v, nEff, k) * B);
    }
  } else {
    const baseline = baselineCounts as ReadonlyMap<string, number>; // never null when isAllCell is false — the caller's own contract
    for (const v of alphabetValues) {
      const nv = weightedCounts.get(v) ?? 0;
      if (nv === 0) continue;
      data += nv * Math.log2(ktPosteriorFromMap(weightedCounts, v, nEff, k) / ktPosteriorFromMap(baseline, v, baselineNEff, k));
    }
  }

  const paramCost = 0.5 * (k - 1) * Math.log2(Math.max(nEff, 2));
  const bitsSaved = data - paramCost - idxCost;

  let expected = alphabetValues[0];
  let maxCount = -Infinity;
  for (const v of alphabetValues) {
    const c = weightedCounts.get(v) ?? 0;
    if (c > maxCount) {
      maxCount = c;
      expected = v;
    }
  }
  let runnerUp = 0;
  for (const v of alphabetValues) {
    if (v === expected) continue;
    const c = weightedCounts.get(v) ?? 0;
    if (c > runnerUp) runnerUp = c;
  }

  return {
    expected,
    nExpectedWeighted: maxCount === -Infinity ? 0 : maxCount,
    nRunnerUpWeighted: runnerUp,
    dataTerm: data,
    paramCost,
    bitsSaved,
    bitsPerInstance: nEff > 0 ? data / nEff : 0,
    nEff,
  };
}

/** Spec `index_cost = log2(C₂)`, `C₂` = `C` rounded up to the next power of two: `⌈log2(C)⌉`, floored at `C = 2` so a candidate space of 0 or 1 never asks for a negative/zero-width index. */
export function indexCostBits(candidateCount: number): number {
  return Math.ceil(Math.log2(Math.max(candidateCount, 2)));
}

/** §9.4c gate 3, exact at every n: `(n_expected + 1/2) / (n_runnerup + 1/2) >= 2^tau`. */
export function isFireable(nExpectedWeighted: number, nRunnerUpWeighted: number, tau: number): boolean {
  return (nExpectedWeighted + 0.5) / (nRunnerUpWeighted + 0.5) >= 2 ** tau;
}

/** §9.4a/f's τ selection: presence/categorical facts use `thresholds.preferenceGapBits` (2.5); a boolean `false`-expected (absence) fact is raised — `absenceGapBitsStructural` (4.5) for the two grammar-shape surfaces, `absenceGapBits` (3.5) for every other vocabulary-absence surface. */
export function tauFor(
  surface: string,
  isBoolean: boolean,
  expected: string,
  thresholds: { preferenceGapBits: number; absenceGapBits: number; absenceGapBitsStructural: number },
): { tau: number; absence: boolean } {
  const absence = isBoolean && expected === 'false';
  if (!absence) return { tau: thresholds.preferenceGapBits, absence: false };
  return { tau: isStructuralAbsenceSurface(surface) ? thresholds.absenceGapBitsStructural : thresholds.absenceGapBits, absence: true };
}

/** Spec §9.4c gate 1: the fallback-bucket values are never eligible as `expected` — a distributional fact, report-only. */
const FALLBACK_BUCKET_VALUES: ReadonlySet<string> = new Set(['other', 'none', 'mixed', '?']);
export function isFallbackBucket(value: string): boolean {
  return FALLBACK_BUCKET_VALUES.has(value);
}

/** Spec §9.4c gate 2: E7 placement surfaces (`auto.dir<N>`) are eligible ONLY on role cells — never `_all`, never a directory context (the tautology §9.4i names). */
const PLACEMENT_SURFACE_RE = /^auto\.dir\d+$/;
export function isPlacementSurface(surfaceId: string): boolean {
  return PLACEMENT_SURFACE_RE.test(surfaceId);
}

// ---------------------------------------------------------------------------
// Cell identity.
// ---------------------------------------------------------------------------

export type CellClass = 'all' | 'role' | 'dir';

export interface CellRecord {
  cellId: string;
  cellClass: CellClass;
  kind: ScopeKind | 'module';
  /** Set for `cellClass === 'role'`: the owning role's `roleKey`. */
  roleKey?: string;
  /** Set for `cellClass === 'dir'`: the directory this context collects. */
  dir?: string;
  counts: CellCounts;
}

export function allCellId(kind: string): string {
  return `_all:${kind}`;
}
export function roleCellId(roleKey: string, kind: string): string {
  return `${roleKey}:${kind}`;
}
export function dirCellId(dir: string, kind: string): string {
  return `d[${dir}]:${kind}`;
}

/** `ScopeUnit.kind` values a directory/`_all` cell can be built over (role cells are method/type only — `roles.ts`'s own eligibility gate). */
export const CELL_KINDS: readonly (ScopeKind | 'module')[] = ['method', 'type', 'file', 'module'];
