/**
 * source/cli/src/roots/roles.ts — spec §8 role induction: the §8.1
 * catalog-free feature bag, §8.2's Jaccard distance, §8.3's per-partition
 * weighted average-linkage clustering with an incremental-DL MDL cut, §8.4's
 * medoid/nearest-medoid classifier, §8.5's clone-aware ambiguity, §8.6's
 * sticky-role ENABLING half (the persisted `assignments` map — the
 * RESOLUTION path itself belongs to the verdict function that reads a prior
 * snapshot's `assignments` map, out of this file's scope, see
 * `induceRoles`'s own doc), §8.8's content-derived role identity, §8.9's two
 * scope-classification rules (method/type sticky-or-nearest-medoid; file
 * plurality), and §8.10's `role_lift` pure formula.
 *
 * TWO WEIGHT SYSTEMS, kept deliberately apart throughout this file (spec
 * §8.3 vs the §9.1/§8.3-table weight-index):
 *
 *   1. CLUSTERING weight = bucket cardinality (`w = |bucket|`, §8.3
 *      `v6-spec.md:331`) — the count of scopes sharing one exact feature
 *      bag. Used ONLY inside clustering (Lance-Williams linkage, the cluster
 *      DL, weighted medoid selection, `roles.minClusterSize` as a total
 *      member WEIGHT in these units). NEVER the §9.1 instance weight.
 *   2. The `weights: WeightFn` parameter this file's exported `induceRoles`
 *      takes is the per-SCOPE §9.1 BASE weight (`w_base`, BEFORE any hook-
 *      shaped ledger cap not yet landed) — used ONLY by §8.9(b)'s file-role
 *      plurality (the weight-index table at `v6-spec.md:342` binds this:
 *      role-CELL counts use `w(s,q)·(ambiguous?0.5:1)` and `_all` counts use
 *      `w(s,q)` — both the downstream counting pass's concern, computed from
 *      the CAPPED per-(scope,surface) weight — while file-role plurality
 *      uses plain `w_base`, the per-scope base, with no ambiguous discount
 *      and no cap). Today, before any lifecycle-hook weight cap exists, both
 *      quantities evaluate to the same constant (`weights.noLifecycleWeight`,
 *      0.3), which is exactly why the TYPE must already be right: once a
 *      per-scope ledger cap lands, w_base will diverge from w(s,q), and a
 *      plurality computed with the wrong one would silently drift. `induceRoles`
 *      never constructs a default `WeightFn` itself — the surrounding mining
 *      pipeline supplies the constant-0.3 function; this keeps the seam a
 *      pure parameter, no signature change needed once that cap lands.
 *
 * §8.10's `role_lift` is exported as a PURE function over SUPPLIED counts
 * (no scope walking, no weight derivation of its own) — the downstream §9.4
 * counting pass computes the real counts (§8.10's own "computed from the
 * same counts as §9.4 in one pass") and invokes this file's `roleLift`
 * function from them; this file never re-derives §9.4 math. NO REFERENCE
 * IMPLEMENTATION EXISTS for `role_lift` (the prototype's `roleLift` proxy,
 * `prototype-roots2.mjs:252-255`, is explicitly not it — it is a placeholder
 * "any accepted role fact ⇒ lift>0" stub) — implemented fresh from spec
 * §8.10's own formula text. Likewise §8.9(b) (file-scope derived roles) and
 * §8.8's `definingFeatureGroups`/`label`/`role_key` carry no prototype
 * reference at all (the prototype computes none of them) and are
 * implemented fresh from the spec's own words, each documented at its own
 * definition below.
 *
 * CLUSTERING SEMANTICS reference: `induceRoles`/`assignAll`,
 * `prototype-roots2.mjs:135-173` (bucket weights `:142`, the clone guard
 * `:170`) — ported as the spec's own measured mechanism, not re-derived.
 */

import type { ScopeUnit } from './extract.js';
import type { RootsConfig } from '../model/graph.js';
import { hashString } from '../io/hash.js';

// ---------------------------------------------------------------------------
// §8.1 — the catalog-free, directory-free role feature bag F(s).
// ---------------------------------------------------------------------------

/**
 * The four §7.3 overlap groups role features are drawn from — the SAME
 * group-name vocabulary `enumerate.ts`'s `overlapGroupForSurface` returns,
 * reused verbatim (not re-spelled) so the downstream counting pass's
 * per-(role, surface) tautology skip and this file's own
 * `definingFeatureGroups` output can be compared by
 * plain string equality with no translation table.
 */
export type RoleFeatureGroup = 'name-tokens' | 'supertype' | 'decorator' | 'import-segments';

/** A scope's computed §8.1 feature bag: `ordered` preserves construction order (tok*, sup*, dec*, imp*, first-seen-deduped) — §8.8's `label` and `medoidFeatures` read this order directly; `set` is the same features as a `Set` for §8.2 Jaccard. */
export interface RoleFeatureBag {
  ordered: string[];
  set: Set<string>;
  /** §8.1's `_untyped` gate ingredient: `|tok ∪ sup ∪ dec|` distinct — `imp:` is deliberately EXCLUDED (a file-level ingredient, not the scope's own signature; a signature-derived bucket is a total function of every scope and would make the gate inert, spec's own reasoning for why `imp:` cannot be a substitute). */
  ownFeatureCount: number;
}

/**
 * Casing-boundary tokenizer, tokens of length >= 2 (spec §8.1's own words),
 * mirroring `prototype-roots2.mjs`'s `tokenize` exactly: strip non-alnum runs
 * to spaces, split a lower/digit-to-upper boundary and an acronym-to-word
 * boundary (`XMLParser` -> `XML Parser`), lowercase, split on whitespace,
 * drop length-1 tokens.
 */
function tokenizeName(name: string): string[] {
  const spaced = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** First-seen-deduped, order-preserving (a plain `[...new Set(xs)]` — `Set` iteration order is insertion order in JS). */
function dedupeInOrder(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * §8.1's `imp:<seg>` ingredient: the last path segment of up to 5 DISTINCT
 * PACKAGE (non-relative) import specifiers of the containing file, in
 * first-seen order. `ScopeUnit.fileImports` is RAW (unnormalized) —
 * `enumerate.ts`'s E8 normalization (relative specifiers -> repo-rooted
 * `~/`-prefixed paths) is that file's own concern for its own vocabulary;
 * role bags read the raw specifier directly, so "non-relative" here is
 * simply "does not start with `.`" (a relative specifier always starts with
 * `.` or `..` before any normalization ever runs — `enumerate.ts`'s own
 * `normalizeImportSpecifier` only ever transforms specifiers that already
 * start with `.`, so filtering on the raw text is equivalent to filtering on
 * the normalized text's `~/` prefix, without needing that normalization
 * step at all). Mirrors `prototype-roots2.mjs:118`'s
 * `imports.filter(i => !i.startsWith('~/')).map(i => i.split('/').pop())`
 * structurally (that prototype line filters an ALREADY-normalized list; this
 * one filters the raw list to the same effect, per the equivalence above).
 */
function importBagSegments(fileImports: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const spec of fileImports) {
    if (spec.startsWith('.')) continue; // relative specifier — excluded (§8.1, §7.3's own "directory structure cannot leak in" rationale)
    const lastSlash = spec.lastIndexOf('/');
    const segment = lastSlash === -1 ? spec : spec.slice(lastSlash + 1);
    if (seen.has(segment)) continue;
    seen.add(segment);
    out.push(segment);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Spec §8.1's F(s): the union of `tok:<t>` (own-name tokens), `sup:<T>`
 * (declared supertypes, E9 raw — case preserved, NOT vocabulary-pruned),
 * `dec:<D>` (decorations, E6 raw — case preserved, NOT vocabulary-pruned),
 * and `imp:<seg>` (up to 5 distinct package import last-segments of the
 * containing file). `unit.name` (the raw AST name, never `qualifiedName` —
 * the ordinal-qualified form is an IDENTITY artifact, not a naming
 * convention) feeds the tokenizer. Construction order is fixed
 * (tok*, sup*, dec*, imp*) so `ordered` is a stable, reproducible basis for
 * §8.8's `label`/`medoidFeatures`.
 */
export function buildRoleFeatureBag(unit: ScopeUnit): RoleFeatureBag {
  const tok = dedupeInOrder(tokenizeName(unit.name).map((t) => `tok:${t}`));
  const sup = dedupeInOrder(unit.supertypes.map((s) => `sup:${s}`));
  const dec = dedupeInOrder(unit.decorators.map((d) => `dec:${d}`));
  const imp = importBagSegments(unit.fileImports).map((seg) => `imp:${seg}`);
  const ordered = dedupeInOrder([...tok, ...sup, ...dec, ...imp]);
  return { ordered, set: new Set(ordered), ownFeatureCount: tok.length + sup.length + dec.length };
}

/** The §7.3 overlap group for each of the 4 fixed role-bag tag prefixes (`tok:`/`sup:`/`dec:`/`imp:`, all exactly 3 characters before the colon) — a lookup, not a branch chain, since `buildRoleFeatureBag` is the ONLY producer of role-bag features and it EXHAUSTIVELY emits one of these 4 prefixes (own-property guarded so a feature literally named `"constructor"`-prefixed cannot read `Object.prototype.constructor`). */
const ROLE_FEATURE_GROUP_BY_PREFIX: Readonly<Record<string, RoleFeatureGroup>> = {
  tok: 'name-tokens',
  sup: 'supertype',
  dec: 'decorator',
  imp: 'import-segments',
};

/**
 * The §7.3 overlap group a role-bag feature belongs to. Every caller of this
 * function passes a feature drawn from a `RoleFeatureBag.set` — and
 * `buildRoleFeatureBag` (this file's own, only, producer of such features)
 * exhaustively tags every feature it emits with one of the 4 prefixes
 * `ROLE_FEATURE_GROUP_BY_PREFIX` covers, and none of those 4 literal keys
 * (`tok`/`sup`/`dec`/`imp`) can ever collide with an inherited
 * `Object.prototype` property name — so a direct index, no
 * `hasOwnProperty` guard, is exactly as safe as one here (unlike a mined
 * VALUE, which is untrusted repo content and DOES need the guard —
 * `ktPosterior` below is that case). The `as RoleFeatureGroup` documents the
 * "always one of these 4" contract rather than silently mistyping a real
 * miss; it is not standing in for a runtime check this file has already
 * proven unnecessary (this repo's "prove unreachable, then stop guarding
 * it" convention — `extract.ts`'s REWORK F3 is the precedent).
 */
function roleFeatureGroupOf(feature: string): RoleFeatureGroup {
  return ROLE_FEATURE_GROUP_BY_PREFIX[feature.slice(0, 3)] as RoleFeatureGroup;
}

// ---------------------------------------------------------------------------
// §8.2 — Jaccard distance, ties broken by `stable_id` lexicographic order
// (the tie-break is applied by every CALLER that compares equal-distance
// candidates — medoid selection, classification — not by this function
// itself, which has no identity to break a tie with).
// ---------------------------------------------------------------------------

/** Jaccard similarity of two feature sets (spec §8.2). Empty ∩ empty is defined as 0 (no shared signal to report), matching `prototype-roots2.mjs`'s `jac`. */
export function roleJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) if (large.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// §8.3 — per-partition weighted clustering: pre-bucketing, the deterministic
// stride sample, Lance-Williams weighted average linkage over a materialized
// distance matrix, and the incremental-DL MDL cut.
// ---------------------------------------------------------------------------

/**
 * §8.3's deterministic stride sample over DISTINCT feature-bag
 * representatives (never over raw scopes — pre-bucketing already happened
 * before this is called). `reps` MUST already be in a stable, caller-fixed
 * order (this file sorts bucket representatives by their bucket SIGNATURE
 * ascending before calling this — see `inducePartitionRoles`) so the sample
 * is reproducible independent of the input `units` array's own order.
 * Mirrors `prototype-roots2.mjs:141`'s stride exactly. Exported for a
 * direct, precise test of the stride itself (a real repository rarely
 * exceeds `clusterSampleCap`, 700 distinct bags by default — this file's
 * own test suite exercises the over-cap branch directly rather than
 * constructing 701+ distinct fixture bags to reach it through `induceRoles`).
 */
export function sampleRepresentatives<T>(reps: readonly T[], cap: number): readonly T[] {
  if (reps.length <= cap) return reps;
  const stride = reps.length / cap;
  const out: T[] = [];
  for (let k = 0; k < cap; k++) out.push(reps[Math.floor(k * stride)]);
  return out;
}

/**
 * Spec §8.3's cut-selection DL: `Σ_clusters Σ_{features present in the
 * cluster} [n_c·H(p_f) + 0.5·log2(max(n_c,2))] + k·log2(N)`, maintained
 * INCREMENTALLY (only the merged cluster's own term is recomputed per merge
 * — an O(N²) linkage with an O(N·F̄·log N) cut search on top, never a full
 * re-encode per cut). `weights[i]` is the CLUSTERING (bucket-cardinality)
 * weight of representative `i` — never the §9.1 instance weight (this
 * file's own header note). Returns the WINNING cut as arrays of
 * representative indices, one array per surviving cluster.
 *
 * Exported (not just used internally by `inducePartitionRoles`) so the
 * merge-loop's "does this merge actually improve the running cut" branch —
 * unreachable through `induceRoles`' own test fixtures below without an
 * elaborate multi-bucket setup — has a direct, precise test.
 */
export function agglomerativeClusterCut(bags: readonly RoleFeatureBag[], weights: readonly number[]): number[][] {
  const N = bags.length;
  if (N === 0) return [];

  const dist = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = 1 - roleJaccard(bags[i].set, bags[j].set);
      dist[i * N + j] = d;
      dist[j * N + i] = d;
    }
  }

  const active = new Set<number>();
  for (let i = 0; i < N; i++) active.add(i);
  const members: number[][] = Array.from({ length: N }, (_, i) => [i]);
  const size = new Float64Array(N);
  for (let i = 0; i < N; i++) size[i] = weights[i];

  const clusterDL = (m: readonly number[]): number => {
    let nc = 0;
    for (const x of m) nc += weights[x];
    const counts = new Map<string, number>();
    for (const x of m) {
      for (const f of bags[x].set) counts.set(f, (counts.get(f) ?? 0) + weights[x]);
    }
    let dl = 0;
    for (const c of counts.values()) {
      const p = c / nc;
      const h = p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
      dl += nc * h + 0.5 * Math.log2(Math.max(nc, 2));
    }
    return dl;
  };

  const dls = members.map(clusterDL);
  let sum = dls.reduce((a, b) => a + b, 0);
  let bestDL = sum + active.size * Math.log2(N);
  let best: number[][] = [...active].map((i) => [...members[i]]);

  while (active.size > 1) {
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    const arr = [...active];
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const d = dist[arr[x] * N + arr[y]];
        if (d < bd) {
          bd = d;
          bi = arr[x];
          bj = arr[y];
        }
      }
    }
    // Lance-Williams weighted average-linkage update: d(i∪j, k) = (size_i·d(i,k) + size_j·d(j,k)) / (size_i+size_j).
    for (const k of active) {
      if (k === bi || k === bj) continue;
      const merged = (size[bi] * dist[bi * N + k] + size[bj] * dist[bj * N + k]) / (size[bi] + size[bj]);
      dist[bi * N + k] = merged;
      dist[k * N + bi] = merged;
    }
    members[bi] = members[bi].concat(members[bj]);
    size[bi] += size[bj];
    active.delete(bj);

    sum -= dls[bi] + dls[bj];
    dls[bi] = clusterDL(members[bi]);
    sum += dls[bi];

    const total = sum + active.size * Math.log2(N);
    if (total < bestDL) {
      bestDL = total;
      best = [...active].map((i) => [...members[i]]);
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// §8.4/§8.5 — the single own-features-only nearest-medoid classifier, and
// clone-aware ambiguity.
// ---------------------------------------------------------------------------

/** A cluster's medoid, as classification needs it: just the feature set (own-features-only nearest-medoid rule, §8.4) plus the ordered form §8.8's label/medoidFeatures read. */
export interface RoleMedoid {
  set: ReadonlySet<string>;
  ordered: readonly string[];
}

/** One scope's classification outcome against a partition's medoids: `roleIndex` -1 means "no role at all" (§8.4: "a scope whose best membership is 0 receives no role"; also the medoid-less case). */
export interface RoleClassification {
  roleIndex: number;
  ambiguous: boolean;
}

/**
 * Spec §8.4 (own-features-only nearest medoid) + §8.5 (membership/ambiguity,
 * clone-aware runner-up). Exported standalone (not just inlined into
 * `induceRoles`) because it is the one piece of §8 with no dependency on the
 * clustering machinery above it — every clone-guard / ambiguity-gap /
 * min-membership case is exactly, deterministically reproducible from a
 * hand-built `medoids` array and a hand-built scope `bag`, which is what
 * this file's own test suite uses it for. `induceRoles` calls this SAME
 * function for every eligible scope — never a second copy of the rule.
 */
export function classifyAgainstMedoids(
  bag: ReadonlySet<string>,
  medoids: readonly RoleMedoid[],
  cloneMedoidJaccard: number,
  roleAmbiguityGap: number,
  roleMinMembership: number,
): RoleClassification {
  if (medoids.length === 0) return { roleIndex: -1, ambiguous: false };

  let best = -1;
  let m1 = -1;
  medoids.forEach((medoid, k) => {
    const m = roleJaccard(bag, medoid.set);
    if (m > m1) {
      m1 = m;
      best = k;
    }
  });
  if (best < 0 || m1 <= 0) return { roleIndex: -1, ambiguous: false };

  // Clone-aware runner-up (§8.5, binding): a medoid whose OWN feature bag is
  // Jaccard >= cloneMedoidJaccard with the WINNING medoid is a rival READING
  // of the same latent role, not a genuinely different one — it MUST be
  // skipped when searching for m2, or the MDL cut leaving two near-identical
  // surviving clusters would manufacture ambiguity for every member of the
  // role they both represent (§8.5's own measured rationale).
  let m2 = -1;
  medoids.forEach((medoid, k) => {
    if (k === best) return;
    if (roleJaccard(medoids[best].set, medoid.set) >= cloneMedoidJaccard) return;
    const m = roleJaccard(bag, medoid.set);
    if (m > m2) m2 = m;
  });

  const ambiguous = m1 < roleMinMembership || m1 - m2 < roleAmbiguityGap;
  return { roleIndex: best, ambiguous };
}

// ---------------------------------------------------------------------------
// §8.8 — role identity: role_key, label, definingFeatureGroups.
// ---------------------------------------------------------------------------

/**
 * Spec §8.8's `label` (display only): the medoid's first 3
 * `tok:`/`sup:`/`dec:` features (§8.1's construction order — `imp:` never
 * contributes), tag-prefix stripped, joined with `+`; `'group'` when none
 * exist. Exported for a DIRECT test of the `'group'` fallback: every REAL
 * caller (`inducePartitionRoles`, the only call site) only ever passes a
 * medoid's own bag, which — because §8.1's `_untyped` eligibility gate
 * already required >= `minOwnFeatures` (2) `tok:`/`sup:`/`dec:` features
 * before this scope could ever reach clustering at all — is PROVABLY never
 * empty of candidates through that path; the fallback is real spec
 * behavior (§8.8's own "else `'group'`"), just unreachable via the
 * pipeline's own invariants, so it gets its test here rather than through
 * an artificial, invariant-violating `induceRoles` fixture.
 */
export function labelOf(orderedMedoidFeatures: readonly string[]): string {
  const candidates = orderedMedoidFeatures.filter((f) => f.startsWith('tok:') || f.startsWith('sup:') || f.startsWith('dec:')).slice(0, 3);
  if (candidates.length === 0) return 'group';
  return candidates.map((f) => f.slice(4)).join('+');
}

/**
 * Spec §8.8's `role_key = sha256(sorted member stable_ids of the final
 * assignment)[:12]`. "Final assignment" is read here as EVERY scope
 * classified rank-1 to this role — AMBIGUOUS members included: §8.5 states
 * ambiguous scopes are still "counted in role cells at weight w(s,q)·0.5"
 * (they remain role MEMBERS for counting purposes; only their role SPEECH
 * is silenced), so excluding them from the identity hash would make
 * `role_key` — and therefore `size`/`ambiguityRate`, which read the SAME
 * membership set — disagree with what the downstream counting pass actually
 * counts. A decided reading, stated once here.
 */
function roleKeyOf(memberStableIds: readonly string[]): string {
  const sorted = [...memberStableIds].sort();
  return hashString(sorted.join('\n')).slice(0, 12);
}

/**
 * Spec §8.8's `definingFeatureGroups`: "the top-3-lift feature groups of the
 * cluster." NO REFERENCE IMPLEMENTATION EXISTS (the prototype computes no
 * group-lift at all) — implemented fresh from the spec's own words. For
 * every feature `f` present in the role's own members' bags, this computes
 * a presence-lift contribution in the SAME log-ratio shape §8.10's
 * `role_lift` formula uses (`n_c(f)·log2(p_cluster(f)/p_partition(f))`) —
 * UNWEIGHTED here (plain membership counts, never the §9.1 mining weight
 * system this file's header keeps deliberately separate from clustering),
 * summed per §7.3 overlap group. `p_partition(f)` can never divide by zero:
 * every feature counted here comes from a role MEMBER, and a role member is
 * by construction also one of `partitionEligibleBags` (the same eligibility
 * population clustering itself drew from), so `f` occurs at least once
 * partition-wide whenever it occurs at all. Groups with a non-positive total
 * score carry no discriminative signal and are dropped; survivors are
 * ordered by score descending, ties by group name ascending (determinism),
 * and the top 3 kept.
 *
 * NO EMPTY-INPUT GUARD: `memberBags` is never empty (both call sites in
 * `inducePartitionRoles` only invoke this once a role's own membership is
 * already known non-empty — see that function's own "a medoid's own
 * originating bucket always classifies at least one member to itself"
 * proof), and `partitionEligibleBags` is never empty either (a partition
 * with zero eligible units returns from `inducePartitionRoles` before any
 * medoid — hence any call here — can exist at all). A guard for either
 * would be unreachable dead code under this file's own invariants, per the
 * same "prove unreachable, then stop guarding it" convention `extract.ts`'s
 * REWORK F3 established.
 */
function definingFeatureGroupsOf(memberBags: readonly RoleFeatureBag[], partitionEligibleBags: readonly RoleFeatureBag[]): RoleFeatureGroup[] {
  const clusterN = memberBags.length;
  const partitionN = partitionEligibleBags.length;

  const candidateFeatures = new Set<string>();
  for (const bag of memberBags) for (const f of bag.set) candidateFeatures.add(f);

  const groupScore = new Map<RoleFeatureGroup, number>();
  for (const feature of candidateFeatures) {
    // No `roleFeatureGroupOf` miss-guard here either: every feature in
    // `candidateFeatures` comes from a `RoleFeatureBag.set`, and
    // `roleFeatureGroupOf`'s own contract (its doc comment) is total over
    // exactly that domain.
    const group = roleFeatureGroupOf(feature);
    let nc = 0;
    for (const bag of memberBags) if (bag.set.has(feature)) nc++;
    let np = 0;
    for (const bag of partitionEligibleBags) if (bag.set.has(feature)) np++;
    const pCluster = nc / clusterN;
    const pPartition = np / partitionN;
    const contribution = nc * Math.log2(pCluster / pPartition);
    groupScore.set(group, (groupScore.get(group) ?? 0) + contribution);
  }

  // No `scoreA === scoreB` third tie arm: `groupScore` is a `Map`, so
  // `groupA`/`groupB` are always two DISTINCT keys within one sort
  // comparison — `groupA === groupB` can never occur here.
  return [...groupScore.entries()]
    .filter(([, score]) => score > 0)
    .sort(([groupA, scoreA], [groupB, scoreB]) => scoreB - scoreA || (groupA < groupB ? -1 : 1))
    .slice(0, 3)
    .map(([group]) => group);
}

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------

/** A per-scope base weight function, called ONLY by §8.9(b)'s file-role plurality. `induceRoles` never supplies a default — the surrounding mining pipeline passes the constant `() => config.weights.noLifecycleWeight`. */
export type WeightFn = (unit: ScopeUnit) => number;

/**
 * Spec Appendix D's per-role record (`roleKey`, `label`, `size`,
 * `medoidFeatures`, `definingFeatureGroups`, `ambiguityRate` — the dictated
 * field list), plus `partitionId` (an ADDITION beyond that list, not a
 * contradiction of it: Appendix D nests `roles[]` INSIDE each `partitions[]`
 * entry, so no explicit field is needed there — but this file's
 * `induceRoles` returns one FLAT, repo-wide `RoleAssignment`, and the
 * downstream mining pass needs to know which partition a role belongs to in
 * order to re-nest it into `MinedModel.partitions[].roles[]` and to score
 * role-conditioned candidates against the CORRECT partition's `_all`
 * baseline).
 *
 * `partitionId` is a GROUPING DISCRIMINATOR ONLY — an internal join key this
 * file's own caller uses to re-nest a flat role list back under its owning
 * partition. It MUST be stripped before Appendix-D serialization: the
 * snapshot's own `roles[]` record (nested inside a `partitions[]` entry) has
 * no such key, so a `{...role}` spread of this interface straight into that
 * record's body leaks a field the schema does not define. A consumer MUST
 * pick the fields it serializes explicitly, never spread this whole shape.
 *
 * `roleLift` is OMITTED here, not merely left undefined: §8.10 states
 * `role_lift` is "computed from the same counts as §9.4 in one pass" — a
 * counting pass this file never runs (this file's own `roleLift` is exported
 * as a PURE function over SUPPLIED counts, this file's own header explains
 * why). The downstream counting pass attaches `roleLift` to its OWN copy of
 * this role record once it has produced the real counts; `RoleInfo`
 * therefore has no `roleLift` field to leave stale.
 *
 * DECORATIVE-ROLE CONSUMER CONTRACT (spec §8.10, stated here since this is
 * the type every downstream consumer of a role reads): once a role's
 * `roleLift` (computed and attached by the downstream counting pass) is <= 0,
 * the role is DECORATIVE — it contributes NO conventions and NO shadows on
 * any surface, and every one of its members (ambiguous or not) falls back to
 * `_all` exactly like an `_untyped` scope. This file's own `isDecorativeRole`
 * helper is the single source of truth for that `<= 0` test; a consumer
 * MUST use it rather than re-testing the sign inline.
 */
export interface RoleInfo {
  partitionId: string;
  roleKey: string;
  label: string;
  size: number;
  medoidFeatures: readonly string[];
  definingFeatureGroups: readonly string[];
  ambiguityRate: number;
}

/**
 * `induceRoles`'s return: every partition's surviving roles (sorted
 * `partitionId` asc, `roleKey` asc), plus the repo-wide `assignments` map
 * (spec Appendix D `:875-876`) — keyed `relPath#kind#qualifiedName`
 * (`ScopeUnit.skeyR`, which ALREADY folds in the `#k` occurrence ordinal per
 * `extract.ts`'s own `qualifiedName` construction, so no separate ordinal
 * handling is needed here), valued the winning `roleKey`, or the literal
 * string `'-1'` for an ambiguous method/type scope. A scope with NO entry at
 * all (never written, not even as `'-1'`) is untyped, unclassified (best
 * membership 0), belongs to a partition with no surviving roles, or — for a
 * `file`-kind key — has no method/type members carrying a role (§8.9(b):
 * "no members ⇒ no role"); every such absence falls back to `_all`
 * downstream, per §8.7.
 *
 * STICKY ROLES (§8.6): this file lands only the ENABLING half — the
 * persisted `assignments` map itself. The RESOLUTION path ("the verdict
 * function MUST resolve a scope's role from the snapshot's assignments map
 * when the scope is known") belongs to that verdict function itself:
 * `induceRoles` takes no PRIOR snapshot/assignments state as input, because
 * build-time induction is "one pass, final by definition" (§8.4 `:337`) —
 * there is no stickiness to apply or test at build time, only a map to
 * persist for a LATER build (or the hook path) to read stickily. A conscious
 * deferral, not an oversight.
 */
export interface RoleAssignment {
  roles: RoleInfo[];
  assignments: Record<string, string>;
}

/** Spec §8.10's demotion test: `role_lift <= 0` ⇒ decorative. The single source of truth `RoleInfo`'s own doc points consumers at. */
export function isDecorativeRole(roleLiftValue: number): boolean {
  return roleLiftValue <= 0;
}

// ---------------------------------------------------------------------------
// §8.10 — role_lift, a PURE function over supplied counts (no reference
// implementation; see this file's header for why).
// ---------------------------------------------------------------------------

/**
 * One held-out (or excluded) behavior surface's role-vs-partition counts, as
 * the downstream §9.4 counting pass supplies them — `roleLift` never derives
 * these itself. `overlapGroup` is the surface's §7.3 overlap group (from
 * `enumerate.ts`'s `overlapGroupForSurface`), or `undefined` for a surface
 * that belongs to no group (never excluded from the held-out set).
 *
 * SURFACES SUPPLIED HERE MUST BE BEHAVIOR-CLASS ONLY (§7.3's identity/
 * behavior split — identity surfaces are E1, E2, E7, E12). `role_lift` is a
 * discrimination-quality metric: an identity surface (one whose whole point
 * is to correlate with cluster membership, since clustering itself was built
 * from name/supertype/decorator features) will trivially "predict" its own
 * role and inflate the lift score, silently suppressing the §8.10 decorative
 * demotion for a role that is otherwise unconvincing. This file exports no
 * identity/behavior class map — the caller owns filtering `RoleLiftSurfaceInput[]`
 * down to behavior-class surfaces before calling `roleLift`.
 */
export interface RoleLiftSurfaceInput {
  surface: string;
  overlapGroup?: string;
  /** `true` for a closed {true,false} boolean surface (K=2, §9.3); `false` for a categorical surface (K = alphabet.length + 1, the §9.3 escape slot). */
  isBoolean: boolean;
  /** The partition-observed value alphabet (§9.3) — read for categorical K; ignored (K fixed at 2) when `isBoolean`. */
  alphabet: readonly string[];
  /** Weighted n_v role-conditioned counts (this role's own members only), keyed by observed value. */
  roleCounts: Readonly<Record<string, number>>;
  /** Weighted n_v partition-wide counts (the whole-partition population of the same kind), keyed by observed value. */
  partitionCounts: Readonly<Record<string, number>>;
}

/** §9.3's KT-smoothed posterior: `p̂(x) = (n_x + 1/2) / (n_eff + K/2)`. `hasOwnProperty`-guarded — a mined value literally named `"constructor"` must read 0, not `Object.prototype.constructor` (the established convention `prototype-roots2.mjs`'s own `kt` helper states, ported here for the same reason). */
function ktPosterior(counts: Readonly<Record<string, number>>, value: string, nEff: number, k: number): number {
  const nx = Object.prototype.hasOwnProperty.call(counts, value) ? counts[value] : 0;
  return (nx + 0.5) / (nEff + k / 2);
}

function sumCounts(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const key of Object.keys(counts)) total += counts[key];
  return total;
}

/**
 * Spec §8.10: `role_lift(r) = Σ_q [DL_partition(q on members(r)) −
 * DL_role(q on members(r))] / n_eff(r)`, held-out set = behavior surfaces
 * EXCLUDING those whose overlap group is among the role's own
 * `definingFeatureGroups` (§7.3's exclusion, re-applied here since it
 * directly DEFINES role_lift's held-out set rather than merely being
 * referenced by it — "without this exclusion, decorator/supertype surfaces
 * that mirror clustering features inflate the metric", §8.10's own words).
 *
 * Per surface, `DL_partition(q on members(r)) − DL_role(q on members(r))` is
 * algebraically `Σ_v n_v·log2(p̂_role(v)/p̂_partition(v))` — exactly §9.4a's
 * `data_term` shape (role posterior vs the partition-posterior baseline,
 * over the role's OWN weighted counts for that surface) — so this loop
 * mirrors that line, minus the accept/reject decision §9.4a itself attaches
 * (role_lift only sums the bits, never gates on them).
 *
 * `nEff` is the role's own TOTAL effective member weight —
 * n_eff(r) = Σ over members(r) of w_base(s), the per-scope §9.1 BASE weight
 * (NOT §9.4a's per-cell n_eff, which is computed per (scope, surface) after
 * a surface's own applicability-domain exclusions) — a SINGLE denominator
 * for the WHOLE sum (§8.10's own "/ n_eff(r)": one divisor, not one per
 * surface), supplied by the caller (the downstream counting pass, from the
 * real §9.1 weights) rather than re-derived here, because different surfaces
 * can have different PER-SURFACE n_eff (a surface's own applicability domain
 * can exclude some role members, Appendix B's `domain` column) while §8.10's
 * denominator is the role's overall size, not any one surface's cell.
 * `nEff <= 0` returns 0 (no instances, nothing to normalize by — an honest
 * zero rather than a division producing `Infinity`/`NaN`).
 */
export function roleLift(surfaces: readonly RoleLiftSurfaceInput[], definingFeatureGroups: readonly string[], nEff: number): number {
  if (nEff <= 0) return 0;
  const excluded = new Set(definingFeatureGroups);

  let total = 0;
  for (const surface of surfaces) {
    if (surface.overlapGroup !== undefined && excluded.has(surface.overlapGroup)) continue; // §7.3/§8.10 held-out exclusion

    const k = surface.isBoolean ? 2 : surface.alphabet.length + 1;
    const roleN = sumCounts(surface.roleCounts);
    const partitionN = sumCounts(surface.partitionCounts);
    const values = surface.isBoolean ? ['true', 'false'] : surface.alphabet;

    for (const value of values) {
      const nv = Object.prototype.hasOwnProperty.call(surface.roleCounts, value) ? surface.roleCounts[value] : 0;
      if (nv === 0) continue; // a zero-count value contributes 0 regardless of the posteriors — skip the (harmless but pointless) log evaluation
      const pRole = ktPosterior(surface.roleCounts, value, roleN, k);
      const pPartition = ktPosterior(surface.partitionCounts, value, partitionN, k);
      total += nv * Math.log2(pRole / pPartition);
    }
  }

  return total / nEff;
}

// ---------------------------------------------------------------------------
// §8.9(b) — file-scope derived roles: plurality of method/type members,
// weighted by w_base, ties by ascending lexicographic role_key.
// ---------------------------------------------------------------------------

/**
 * Spec §8.9(b): "a file scope's role = plurality role of its method/type
 * members ... ties broken by ascending lexicographic role_key; no members ⇒
 * no role. File scopes are never role-ambiguous." NO REFERENCE
 * IMPLEMENTATION EXISTS (design §12 lists this as "specified but never
 * built") — implemented fresh from the spec text.
 *
 * The vote: every method/type scope's RANK-1 role (from
 * `classifyAgainstMedoids`), REGARDLESS of that scope's OWN ambiguity flag,
 * weighted by `w_base` (`weights(unit)`) — the weight-index table (§8.3
 * `v6-spec.md:342`) scopes the ambiguous-half-weight discount to ROLE-CELL
 * counts specifically ("role-cell counts use w(s,q)·(ambiguous?0.5:1)");
 * file-role plurality is its OWN row in that same table ("file-role
 * plurality (§8.9b) uses w_base") with no discount named for it at all — a
 * decided reading of the more specific table over §8.9(b)'s own prose
 * ("plurality role of its ... members", unweighted on its face), stated once
 * here since the spec text itself calls this exact tension out and resolves
 * it the same way. A member with no role at all (untyped, or best
 * membership 0) casts no vote. Winner = highest weighted tally; ties by
 * ascending lexicographic `role_key`, implemented by scanning ROLE-KEY-
 * SORTED tally entries and keeping the first one whose weight is not beaten
 * (a later, larger key can only WIN on strictly greater weight, never tie
 * its way past an earlier one).
 */
function deriveFileRoleAssignments(
  partitionUnits: readonly ScopeUnit[],
  eligible: readonly { unit: ScopeUnit; bag: RoleFeatureBag }[],
  rank1RoleIndex: ReadonlyMap<string, number>,
  roleKeyByIndex: ReadonlyMap<number, string>,
  weights: WeightFn,
  outAssignments: Record<string, string>,
): void {
  // No `roleKey === undefined` guard: `roleKeyByIndex` is total over every
  // surviving medoid index (`inducePartitionRoles`' own proof, at its
  // `roleKeyByIndex` population loop), and `rank1RoleIndex`'s values are
  // always indices in that same range.
  const votesByFile = new Map<string, Map<string, number>>(); // relPath -> roleKey -> weighted vote total
  for (const item of eligible) {
    const idx = rank1RoleIndex.get(item.unit.stableId);
    if (idx === undefined) continue;
    const roleKey = roleKeyByIndex.get(idx) as string;
    let tally = votesByFile.get(item.unit.relPath);
    if (!tally) {
      tally = new Map<string, number>();
      votesByFile.set(item.unit.relPath, tally);
    }
    tally.set(roleKey, (tally.get(roleKey) ?? 0) + weights(item.unit));
  }

  for (const unit of partitionUnits) {
    if (unit.kind !== 'file') continue;
    // `!tally` alone is the whole test — "no members ⇒ no role" (§8.9b): a
    // STORED `tally` is never empty (it is created and immediately given
    // its first `.set()` in the SAME operation in the loop above, never
    // left as a bare empty Map), so `tally.size === 0` can never be true
    // for a truthy `tally`.
    const tally = votesByFile.get(unit.relPath);
    if (!tally) continue;

    // `winner` is provably assigned by the end of this loop: `tally` has at
    // least one entry (immediately above), weights are non-negative
    // (§4.5's w_base range), and `winnerWeight` starts at `-Infinity`, so
    // the FIRST entry always satisfies `weight > winnerWeight` regardless
    // of scan order — hence the `as string` below, not a runtime guard.
    let winner: string | undefined;
    let winnerWeight = -Infinity;
    const sortedEntries = [...tally.entries()].sort(([a], [b]) => (a < b ? -1 : 1)); // roleKeys of DIFFERENT roles are always distinct — see this file's `roles.sort` doc
    for (const [roleKey, weight] of sortedEntries) {
      if (weight > winnerWeight) {
        winnerWeight = weight;
        winner = roleKey;
      }
    }
    outAssignments[unit.skeyR] = winner as string; // files are never ambiguous — never '-1' (§8.9b)
  }
}

// ---------------------------------------------------------------------------
// §8.3-§8.9(a) — one partition's induction: eligibility, pre-bucketing,
// sampling, clustering, medoid selection, classification, role identity.
// ---------------------------------------------------------------------------

interface EligibleUnit {
  unit: ScopeUnit;
  bag: RoleFeatureBag;
}

interface FeatureBagBucket {
  signature: string;
  members: EligibleUnit[];
  weight: number; // §8.3's bucket-cardinality clustering weight — NEVER the §9.1 instance weight
  bag: RoleFeatureBag; // shared by every member of this bucket, by construction (identical feature bag = the bucketing key)
  minStableId: string; // deterministic tie-break identity for this bucket (this file's own decision — see medoid selection below)
}

function inducePartitionRoles(
  partitionId: string,
  partitionUnits: readonly ScopeUnit[],
  weights: WeightFn,
  config: RootsConfig,
  outRoles: RoleInfo[],
  outAssignments: Record<string, string>,
): void {
  const rolesCfg = config.roles;
  const thresholds = config.thresholds;

  // §8.1 eligibility: kinds method/type only, and the `_untyped` gate
  // (fewer than `minOwnFeatures` discriminative own features excludes a
  // scope from clustering AND from role-conditioned conventions entirely —
  // it never enters `eligible` at all, so it gets no assignments-map entry).
  const eligible: EligibleUnit[] = [];
  for (const unit of partitionUnits) {
    if (unit.kind !== 'method' && unit.kind !== 'type') continue;
    const bag = buildRoleFeatureBag(unit);
    if (bag.ownFeatureCount < rolesCfg.minOwnFeatures) continue;
    eligible.push({ unit, bag });
  }
  if (eligible.length === 0) return; // nothing to cluster in this partition — no roles, no assignments
  // No equal-stableId tie arm: `stable_id` (spec §6.4) is
  // `sha256hex(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ arity)` — two
  // DIFFERENT scopes in `eligible` (all drawn from ONE partition here)
  // could only collide via an actual SHA-256 collision, the same accepted
  // risk `extract.ts`'s own `stableIdOf` and `roleKeyOf`/`compareRoles`
  // above already carry.
  eligible.sort((a, b) => (a.unit.stableId < b.unit.stableId ? -1 : 1));

  // §8.3 pre-bucketing: identical feature bags collapse to ONE weighted
  // representative (w = |bucket|) BEFORE any sampling — the sample cap must
  // apply to distinct bags, never to scopes, or a stride sample over raw
  // scopes can destroy a role outright by admitting only some of a set of
  // identical classes (§8.3's own measured rationale). Buckets are sorted by
  // their SIGNATURE (the bag's own sorted, ` `-joined feature list) —
  // a canonical order that depends on nothing but the bags themselves, so
  // sampling is reproducible independent of `units`' own input order (this
  // file's own determinism decision — spec names only "deterministic
  // stride sample," not a specific representative order).
  const bucketsBySignature = new Map<string, EligibleUnit[]>();
  for (const item of eligible) {
    const signature = [...item.bag.set].sort().join(' ');
    let bucket = bucketsBySignature.get(signature);
    if (!bucket) {
      bucket = [];
      bucketsBySignature.set(signature, bucket);
    }
    bucket.push(item);
  }
  // `minStableId` is `members[0]`'s own stable_id, NOT a min-reduce over the
  // bucket: `eligible` was already sorted ascending by `stableId` above
  // (before bucketing), and bucketing only ever APPENDS to a bucket in that
  // same traversal order — so every bucket's own `members` array is itself
  // already non-decreasing by `stableId`, making `members[0]` provably the
  // minimum without a second pass.
  const buckets: FeatureBagBucket[] = [...bucketsBySignature.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([signature, members]) => ({
      signature,
      members,
      weight: members.length,
      bag: members[0].bag,
      minStableId: members[0].unit.stableId,
    }));

  const sampled = sampleRepresentatives(buckets, rolesCfg.clusterSampleCap);
  const clusters = agglomerativeClusterCut(
    sampled.map((b) => b.bag),
    sampled.map((b) => b.weight),
  );

  // §8.3's minClusterSize floor (a TOTAL MEMBER WEIGHT, not a representative
  // count) + §8.4's weighted medoid (the member minimizing the WEIGHT-SUMMED
  // distance within the cluster, using the ORIGINAL pairwise distances — not
  // the linkage matrix, which has been mutated by merges by this point —
  // ties by `stable_id`, read here as the bucket's own minimum member
  // stable_id, the deterministic identity a multi-scope bucket needs for a
  // tie-break that spec's own text writes in terms of a single scope).
  const medoids: RoleMedoid[] = [];
  for (const cluster of clusters) {
    const totalWeight = cluster.reduce((sum, idx) => sum + sampled[idx].weight, 0);
    if (totalWeight < rolesCfg.minClusterSize) continue; // §8.3: dropped, members fall back to `_all`

    let bestIdx = cluster[0];
    let bestSum = Infinity;
    let bestTieId = sampled[cluster[0]].minStableId;
    for (const idx of cluster) {
      let weightedSum = 0;
      for (const other of cluster) {
        weightedSum += sampled[other].weight * (1 - roleJaccard(sampled[idx].bag.set, sampled[other].bag.set));
      }
      const tieId = sampled[idx].minStableId;
      if (weightedSum < bestSum || (weightedSum === bestSum && tieId < bestTieId)) {
        bestSum = weightedSum;
        bestIdx = idx;
        bestTieId = tieId;
      }
    }
    medoids.push({ set: sampled[bestIdx].bag.set, ordered: sampled[bestIdx].bag.ordered });
  }

  // §8.4/§8.5 classification runs over EVERY eligible unit — never just the
  // sampled representatives (sampling is a clustering-time-only reduction,
  // spec §8.3's own scope for it).
  const rank1RoleIndex = new Map<string, number>(); // stableId -> medoid index (both ambiguous and confident members)
  const ambiguousStableIds = new Set<string>();
  for (const item of eligible) {
    const result = classifyAgainstMedoids(item.bag.set, medoids, rolesCfg.cloneMedoidJaccard, thresholds.roleAmbiguityGap, thresholds.roleMinMembership);
    if (result.roleIndex < 0) continue; // no role — no assignments-map entry at all (falls back to `_all`)
    rank1RoleIndex.set(item.unit.stableId, result.roleIndex);
    if (result.ambiguous) ambiguousStableIds.add(item.unit.stableId);
  }

  const membersByIndex = new Map<number, EligibleUnit[]>();
  for (const item of eligible) {
    const idx = rank1RoleIndex.get(item.unit.stableId);
    if (idx === undefined) continue;
    let bucket = membersByIndex.get(idx);
    if (!bucket) {
      bucket = [];
      membersByIndex.set(idx, bucket);
    }
    bucket.push(item);
  }

  const partitionEligibleBags = eligible.map((e) => e.bag);
  const roleKeyByIndex = new Map<number, string>();

  // NO "empty membership" GUARD HERE (an earlier revision carried one,
  // removed after proving it unreachable): `medoids[idx]`'s `.set` is
  // ALWAYS exactly one bucket's own bag (`medoids.push` above only ever
  // pushes `sampled[bestIdx].bag.set`, and `sampled` entries are themselves
  // exact pre-bucketed representative bags), and every ORIGINAL member of
  // that same bucket shares that EXACT bag by construction (bucketing
  // groups by exact-signature equality). So for that bucket's own members,
  // `roleJaccard(item.bag.set, medoids[idx].set) === 1` — the unique
  // maximum possible value — and no OTHER medoid can tie or beat 1.0
  // without sharing the identical bag, which pre-bucketing already forbids
  // across DIFFERENT buckets. `classifyAgainstMedoids`' strict `>` scan
  // therefore ALWAYS selects `idx` for at least that bucket's own members:
  // `membersByIndex.get(idx)` can never be empty for an `idx` that reached
  // this loop. This is this file's own instance of the "prove unreachable,
  // then stop guarding it" convention `extract.ts`'s REWORK F3 established.
  for (let idx = 0; idx < medoids.length; idx++) {
    const members = membersByIndex.get(idx) as EligibleUnit[];
    const roleKey = roleKeyOf(members.map((m) => m.unit.stableId));
    roleKeyByIndex.set(idx, roleKey);
    const ambiguousCount = members.filter((m) => ambiguousStableIds.has(m.unit.stableId)).length;

    outRoles.push({
      partitionId,
      roleKey,
      label: labelOf(medoids[idx].ordered),
      size: members.length,
      medoidFeatures: medoids[idx].ordered,
      definingFeatureGroups: definingFeatureGroupsOf(
        members.map((m) => m.bag),
        partitionEligibleBags,
      ),
      ambiguityRate: ambiguousCount / members.length,
    });
  }

  // §8.6's ENABLING half: persist the assignments map — roleKey for a
  // confident member, `'-1'` for an ambiguous one (Appendix D `:875-876`).
  // No `roleKey === undefined` guard: `roleKeyByIndex` is TOTAL over every
  // `idx` in `[0, medoids.length)` (the loop above proves this — see its
  // own comment), and `rank1RoleIndex`'s values are always indices
  // `classifyAgainstMedoids` returned, which are always in that same range.
  for (const item of eligible) {
    const idx = rank1RoleIndex.get(item.unit.stableId);
    if (idx === undefined) continue;
    const roleKey = roleKeyByIndex.get(idx) as string;
    outAssignments[item.unit.skeyR] = ambiguousStableIds.has(item.unit.stableId) ? '-1' : roleKey;
  }

  deriveFileRoleAssignments(partitionUnits, eligible, rank1RoleIndex, roleKeyByIndex, weights, outAssignments);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Spec §8's role induction entry point. Clustering, medoid selection,
 * and classification run PER PARTITION (§8.3 `v6-spec.md:331`: group by each
 * `ScopeUnit.partitionId`; the repo is NEVER clustered flat — two
 * partitions' identical feature bags never merge into one role, because
 * each partition's eligible units are gathered, bucketed, sampled, and cut
 * entirely independently of every other partition's). Partitions are
 * visited in sorted-id order and each partition's roles are appended in
 * medoid order, then the WHOLE `roles` array is re-sorted
 * (`partitionId` asc, `roleKey` asc) so the return value's order never
 * depends on `units`' own input order (this repo's own sorted-iteration
 * discipline, AGENTS.md's "every iteration over mined maps is sorted").
 *
 * `weights` is the per-scope BASE weight (`WeightFn`, this file's header
 * explains the two-weight-system split) — consumed ONLY by §8.9(b)'s
 * file-role plurality; clustering itself never reads it.
 */
export function induceRoles(units: readonly ScopeUnit[], weights: WeightFn, config: RootsConfig): RoleAssignment {
  const byPartition = new Map<string, ScopeUnit[]>();
  for (const unit of units) {
    let bucket = byPartition.get(unit.partitionId);
    if (!bucket) {
      bucket = [];
      byPartition.set(unit.partitionId, bucket);
    }
    bucket.push(unit);
  }

  const roles: RoleInfo[] = [];
  const assignments: Record<string, string> = {};

  for (const partitionId of [...byPartition.keys()].sort()) {
    inducePartitionRoles(partitionId, byPartition.get(partitionId) as ScopeUnit[], weights, config, roles, assignments);
  }

  roles.sort(compareRoles);
  return { roles, assignments };
}

/**
 * `induceRoles`' final ordering: `partitionId` asc, then `roleKey` asc.
 * Exported standalone (not just inlined at the one `.sort()` call site)
 * because `induceRoles` itself always builds `roles` in ALREADY-sorted
 * order internally (partitions are visited via `[...byPartition.keys()].sort()`,
 * and each partition's own roles are appended as it finishes) — the final
 * `.sort()` call therefore never sees the comparator invoked on a
 * genuinely out-of-order pair through the public API alone, and this
 * function gives the ordering RULE itself a direct test independent of
 * that internal invariant.
 *
 * No `roleKey === roleKey` tie arm: once `partitionId` matches (the only
 * way execution reaches the second line), `a` and `b` are two DIFFERENT
 * roles from the SAME partition — and `inducePartitionRoles`' own
 * membership proof (see its `roleKeyByIndex` population loop) means two
 * roles in one partition can never share a member set, so their
 * `role_key` hashes can never collide (short of an actual SHA-256
 * collision, which this file does not guard against, matching every other
 * `stable_id`/`role_key` consumer in this codebase).
 */
export function compareRoles(a: RoleInfo, b: RoleInfo): number {
  if (a.partitionId !== b.partitionId) return a.partitionId < b.partitionId ? -1 : 1;
  return a.roleKey < b.roleKey ? -1 : 1;
}
