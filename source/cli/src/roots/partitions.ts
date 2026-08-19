/**
 * source/cli/src/roots/partitions.ts — spec §6.8 field partitions, phase 2 of
 * the roots engine's three-phase extraction split (`extract.ts`'s header
 * comment names the full ordering and why the spec's module rule forces
 * partitioning BETWEEN raw extraction and `finalizeUnits`).
 *
 * Two exports:
 *
 *   `derivePartitions(files, rawScopes, config)` — spec §6.8 in full:
 *   package-root marker detection (nested roots win), the 300-scope floor
 *   evaluated over the PRE-MODULE denominator (named-body + file raw scopes —
 *   `RawScope` never carries a `module` kind, so this is simply "every raw
 *   scope"), the single `_repo` merge bucket, and J4. `files` is the caller's
 *   EXCLUSION-FILTERED listing (this file's `makeRootsFileFilters().forMarkers`
 *   already applied) — NOT the raw walk and NOT the parsed subset: spec §6.6
 *   step 1 enumerates a "filtered" listing, and the marker scan must run
 *   AFTER the exclusion merge (so a committed `dist/package.json` or a
 *   `go.mod` under `vendor/` never becomes a partition root) but BEFORE any
 *   grammar filter (§6.8's own markers — `go.mod`, `pom.xml`, `*.csproj`,
 *   `*.sln`, `setup.cfg` — have no registered grammar and would silently
 *   vanish from a grammar-filtered list, losing every Java/Go/C# partition
 *   root).
 *
 *   PER-PARTITION OUTCOME, exactly matching the prototype's own merge loop
 *   (`prototype-roots2.mjs:432`, quoted in full on `PartitionStatus`'s own
 *   doc below): a partition that clears the floor on its own SURVIVES under
 *   its own id; every other partition's scopes fall into the single `_repo`
 *   bucket, which then EITHER survives whole (every one of its members now
 *   mined as `_repo`) OR — if even the merged bucket stays under the floor —
 *   is DROPPED WHOLE, never mined under any id. `silent` (J4) is true only
 *   when NOTHING survived at all, not merely "a merge happened": a
 *   5000-scope partition survives regardless of what happens to a sibling
 *   10-scope one. `PartitionMap.survivingPartitionIds`/`statusOfKey` make
 *   this explicit rather than leaving a caller to infer it from
 *   `partitionOfFile`'s values.
 *
 *   `makeRootsFileFilters(config)` — the two-flavor exclusion factory the
 *   whole pipeline composes from: `forMarkers` (merged built-in + config
 *   exclusions ONLY — the marker scan's own filter, deliberately blind to
 *   `config.include` so a narrowed include like `["src/**"]` can never hide a
 *   root `go.mod` and silently vanish the partition it roots) and
 *   `forParsing` (`include` ∧ merged exclusions ∧ the mining-only test-file
 *   exclusion — spec §6.8's closing clause: `*.test.*`/`*.spec.*` are excluded
 *   from CONVENTION MINING specifically, "which remain fully counted for
 *   co-change and history" elsewhere, a later-package concern this file does
 *   not touch). Both flavors merge the SAME built-in list with `config.exclude`;
 *   only the mining-only test-pattern clause and the `include` predicate
 *   distinguish them.
 *
 * A DOCUMENTED GAP, stated once here: spec §6.8 says a partition root is a
 * directory containing a "non-empty `package.json`" among the other markers.
 * `derivePartitions` is a PURE function of relPaths (no file content — see its
 * own signature), so it cannot evaluate emptiness; every marker basename is
 * treated as sufficient on EXISTENCE alone. This repo's own `package.json` is
 * never literally empty, and an adopter's build tooling essentially never
 * commits a zero-byte `package.json` either, so the gap is a corner case in
 * practice — but it IS a real deviation from the spec's literal text, and
 * fixing it would need `derivePartitions` to take file content (or a
 * pre-computed non-empty-marker set) as a new parameter, which this
 * function's own dictated signature (`files, rawScopes, config`) does not
 * carry. Recorded as an open item for a future increment.
 */

import type { RootsConfig } from '../model/graph.js';
import { globMatch } from '../utils/mapping-path.js';
import { dirnameOf, basenameOf, type RawScope } from './extract.js';

/** Spec §6.8's fixed 300-scope partition floor (a fixed constant, never config — spec §4.5's own "deliberate non-config" list names it explicitly). */
export const PARTITION_SCOPE_FLOOR = 300;

/**
 * Spec §6.8's built-in exclusion list, quoted EXACTLY from `v6-spec.md:271`
 * (the general clause; the trailing "and test-pattern files ... for
 * convention mining" clause is a SEPARATE, mining-only addition —
 * `TEST_PATTERN_EXCLUSIONS` below, applied only to `forParsing`, never to
 * `forMarkers`).
 */
export const BUILT_IN_EXCLUSIONS: readonly string[] = [
  '**/node_modules/**',
  '**/bin/**',
  '**/obj/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/.yggdrasil/**',
  '**/vendor/**',
  '**/target/**',
  '**/coverage/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/migrations/**',
  '**/fixtures/**',
  '**/benchmarks/**',
  '**/__mocks__/**',
  '**/*.min.*',
  '**/*generated*/**',
  '**/*.d.ts',
];

/** Spec §6.8's "for convention mining" test-pattern exclusion — mining-only, so it belongs to `forParsing` alone. */
const TEST_PATTERN_EXCLUSIONS: readonly string[] = ['**/*.test.*', '**/*.spec.*'];

/** Package-root marker basenames spec §6.8 names verbatim (minus the "non-empty" nuance this file's header comment documents as ungiven data). */
function isPackageMarkerBasename(base: string): boolean {
  if (
    base === 'package.json' ||
    base === 'pyproject.toml' ||
    base === 'go.mod' ||
    base === 'pom.xml' ||
    base === 'Cargo.toml' ||
    base === 'setup.cfg'
  ) {
    return true;
  }
  return base.endsWith('.csproj') || base.endsWith('.sln');
}

export interface RootsFileFilters {
  /** True if `relPath` survives the merged built-in + config exclusions — the package-root marker scan's own filter (no `include` applied — see this file's header). */
  forMarkers: (relPath: string) => boolean;
  /** True if `relPath` survives `include` AND the merged exclusions AND the mining-only test-pattern exclusion — the parse-set filter (a registered-grammar check is layered on top by the caller; this factory has no grammar knowledge). */
  forParsing: (relPath: string) => boolean;
}

/** Spec §6.8's exclusion merge (`v6-spec.md:271`, "Merged with config `exclude`"), packaged as the two filter flavors every roots file-listing site composes from. */
export function makeRootsFileFilters(config: RootsConfig): RootsFileFilters {
  const mergedExclusions = [...BUILT_IN_EXCLUSIONS, ...config.exclude];
  const parseExclusions = [...mergedExclusions, ...TEST_PATTERN_EXCLUSIONS];
  const includes = config.include.length > 0 ? config.include : ['**/*'];

  const matchesAny = (relPath: string, patterns: readonly string[]): boolean => patterns.some((p) => globMatch(relPath, p));

  return {
    forMarkers: (relPath) => !matchesAny(relPath, mergedExclusions),
    forParsing: (relPath) => matchesAny(relPath, includes) && !matchesAny(relPath, parseExclusions),
  };
}

/**
 * A pre-merge partition key's FINAL disposition (spec §6.8's 300-scope
 * floor), mirroring the prototype's own merge loop EXACTLY
 * (`prototype-roots2.mjs:432`: `(ss.length < 300 ? bucket.push(...ss) :
 * merged.set(p, ss))`, then `if (bucket.length >= 300) merged.set('_repo',
 * bucket)` — a still-under-floor `bucket` is simply never added to `merged`
 * at all):
 *
 *   - `'own-floor'`  — this key's own scope count already met the floor; it
 *     survives as its OWN partition id (the key itself).
 *   - `'repo-merged'` — this key's own count was under the floor, it was
 *     folded into the single `_repo` bucket, and that bucket's TOTAL met the
 *     floor: this key's scopes are mined, but AS `_repo`, not under their own
 *     key.
 *   - `'dropped'` — this key's own count was under the floor, it was folded
 *     into `_repo`, and even `_repo`'s total stayed under the floor: this
 *     key's scopes are DROPPED — never mined under any id, matching the
 *     prototype's own drop exactly.
 */
export type PartitionStatus = 'own-floor' | 'repo-merged' | 'dropped';

/**
 * The final, per-file outcome of partitioning: which partition a file's own
 * scopes belong to (post 300-floor merge), and which directory the
 * `finalizeUnits` module-resolution walk should treat as the "partition root"
 * arm of spec §6.3's nearest-of rule (this file's header explains the
 * `_repo`-merge substitution to the repo root).
 */
export interface PartitionMap {
  /**
   * relPath -> final partitionId, for every relPath whose partition SURVIVED
   * (`PartitionStatus` `'own-floor'` or `'repo-merged'`). A relPath whose
   * partition was `'dropped'` has NO entry here at all — `.get()` returns
   * `undefined`, `.has()` returns `false` — by design: a dropped file's
   * scopes are excluded from mining downstream (`finalizeUnits` reads this
   * map's absence to skip them entirely; see that function's own header for
   * why an earlier `?? '_repo'` fallback here was wrong).
   */
  partitionOfFile: Map<string, string>;
  /**
   * relPath -> the directory `finalizeUnits` treats as this file's
   * module-root (spec §6.3's "partition root" arm). Like `partitionOfFile`,
   * has NO entry for a relPath whose partition was dropped — there is no
   * module-resolution question to answer for a scope that is never mined.
   */
  moduleRootDirOfFile: Map<string, string>;
  /** Every detected package-root directory (pre-merge), sorted — diagnostic/test surface, not consumed downstream. */
  packageRoots: string[];
  /**
   * Every partition id that SURVIVED (own-floor keys, plus `'_repo'` iff the
   * merged bucket itself cleared the floor) — sorted, de-duplicated. Empty
   * exactly when `silent` is true. This is the explicit surviving-partition
   * set spec §6.8/the prototype's `merged` map represents; a caller (the
   * mining pipeline) that wants "every partition to mine" reads this rather
   * than reconstructing it by re-deriving status from `partitionOfFile`'s
   * values.
   */
  survivingPartitionIds: string[];
  /** Every pre-merge partition key's `PartitionStatus` (diagnostic surface — `partitionOfFile`/`moduleRootDirOfFile`/`survivingPartitionIds` already encode every consequence of this a downstream reader needs, but a caller that wants to explain a WHY, e.g. a `status`-style report, reads this directly rather than re-deriving it). */
  statusOfKey: Map<string, PartitionStatus>;
  /**
   * Spec §6.8's J4: true when NO partition survived at all — neither any
   * individual key cleared the floor on its own, nor did the merged `_repo`
   * bucket (`survivingPartitionIds.length === 0`). A repo with a 5000-scope
   * partition and a 10-scope partition is NOT silent: the 5000-scope
   * partition survives on its own floor regardless of what happens to the
   * 10-scope one (own-floor survival and the `_repo` merge outcome are
   * independent; only the FULLY-merged, fully-under-floor case is silent).
   * `silent` therefore also holds for the trivial zero-scope repo (no key
   * exists to survive), matching spec's own framing ("repo with < 300 scopes
   * ... -> silent", `v6-spec.md:94`) literally rather than only its "at
   * least one merge happened" special case.
   */
  silent: boolean;
}

/**
 * Spec §6.8: package-root detection (nested roots win, closest ancestor),
 * the 300-scope floor over raw scopes (grouped by their file's pre-merge
 * partition key), the single `_repo` merge bucket, and J4.
 */
export function derivePartitions(files: string[], rawScopes: RawScope[], config: RootsConfig): PartitionMap {
  // Spec §6.8 defines exactly one partition mode: 'auto' (`DEFAULT_ROOTS`'s
  // default, and the only mode this spec section names — its own heading is
  // literally "auto:"). `config.partition.mode` has exactly one valid value
  // TODAY and this function has no second algorithm to dispatch to; it stays
  // a real parameter of this function's own signature (rather than left
  // implicit) purely so a future second mode can dispatch on it without a
  // signature change — there is nothing for this build to branch on yet.
  void config.partition.mode;

  const packageRootDirs = new Set<string>();
  for (const file of files) {
    if (isPackageMarkerBasename(basenameOf(file))) packageRootDirs.add(dirnameOf(file));
  }
  // Longest (most-nested) directory first, so the first match in `keyFor`'s
  // walk is always the closest ancestor — spec's "nested roots win."
  const sortedRoots = [...packageRootDirs].sort((a, b) => b.length - a.length);

  const keyFor = (relPath: string): string => {
    for (const root of sortedRoots) {
      if (root === '' || relPath === root || relPath.startsWith(`${root}/`)) return root;
    }
    return '_root';
  };

  const scopesByKey = new Map<string, RawScope[]>();
  for (const scope of rawScopes) {
    const key = keyFor(scope.relPath);
    const bucket = scopesByKey.get(key);
    if (bucket) bucket.push(scope);
    else scopesByKey.set(key, [scope]);
  }

  // First pass: own-floor keys survive under their own id; every other key's
  // scopes fall into the single `_repo` merge bucket (prototype's `bucket`).
  const statusOfKey = new Map<string, PartitionStatus>();
  const mergedKeys: string[] = [];
  let mergedCount = 0;
  for (const [key, scopes] of scopesByKey) {
    if (scopes.length >= PARTITION_SCOPE_FLOOR) {
      statusOfKey.set(key, 'own-floor');
    } else {
      mergedKeys.push(key);
      mergedCount += scopes.length;
    }
  }
  // Second pass: does the merged bucket itself clear the floor? Every merged
  // key's final status depends on this ONE shared outcome (prototype's own
  // `if (bucket.length >= 300) merged.set('_repo', bucket)` — a bucket that
  // does not clear the floor is simply never added to `merged`, i.e. dropped
  // in full, not partially).
  const repoBucketSurvives = mergedCount >= PARTITION_SCOPE_FLOOR;
  for (const key of mergedKeys) {
    statusOfKey.set(key, repoBucketSurvives ? 'repo-merged' : 'dropped');
  }

  const survivingPartitionIds = new Set<string>();
  const partitionOfFile = new Map<string, string>();
  const moduleRootDirOfFile = new Map<string, string>();
  for (const [key, scopes] of scopesByKey) {
    const status = statusOfKey.get(key) as PartitionStatus;
    if (status === 'dropped') continue; // excluded from mining — no entry in either map (see PartitionMap's own doc)

    const finalId = status === 'own-floor' ? key : '_repo';
    survivingPartitionIds.add(finalId);
    // The "partition root" arm of §6.3's nearest-of rule: the pre-merge
    // package-root directory itself when this file's partition stood on its
    // own; the repo root ('') both for `_root` (which never had a directory
    // of its own) and for anything the 300-floor merged into `_repo` (this
    // file's own header comment states the substitution).
    const moduleRootDir = finalId === '_repo' ? '' : key === '_root' ? '' : key;
    for (const scope of scopes) {
      partitionOfFile.set(scope.relPath, finalId);
      moduleRootDirOfFile.set(scope.relPath, moduleRootDir);
    }
  }

  return {
    partitionOfFile,
    moduleRootDirOfFile,
    packageRoots: [...packageRootDirs].sort(),
    survivingPartitionIds: [...survivingPartitionIds].sort(),
    statusOfKey,
    silent: survivingPartitionIds.size === 0,
  };
}
