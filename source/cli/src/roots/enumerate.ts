/**
 * source/cli/src/roots/enumerate.ts — spec §7's twelve generic enumerators
 * (Appendix B, read in full), the last of the roots engine's three extraction
 * files (`extract.ts`, `partitions.ts`, this file).
 *
 * TWO PUBLIC STAGES, PER PARTITION (the engine's own phase order:
 * "extractUnits per file → derivePartitions → finalizeUnits → then
 * vocabularies → enumerate"): a caller (the mining pipeline) groups
 * `finalizeUnits`' repo-wide `ScopeUnit[]` by `partitionId`, then for EACH
 * partition calls `buildVocabularies` once (or reads the partition's slice of
 * its repo-wide return) and `enumerate` once, passing that partition's own
 * `ScopeUnit[]` slice and its own `RootsVocabularies`. Spec §7.2's normative
 * reason ("a global vocabulary leaks tokens from one package into another as
 * vacuous negatives") is exactly why `enumerate` never sees another
 * partition's units.
 *
 *   `buildVocabularies(units, partitions, config)` — spec §7.2: for each of
 *   the SIX vocabulary-bearing enumerators (E3 nodeType, E6-call, E6-deco,
 *   E8 import, E9 supertype, E10 shape), count distinct candidate tokens per
 *   partition, drop tokens under `config.enumerate.support[<enumerator>]`,
 *   keep the top `config.enumerate.topK[<enumerator>]` by count (ties broken
 *   token-asc), store the survivors alphabetically (this repo's canonical
 *   array convention). Returns one `RootsVocabularies` per partitionId found
 *   among `units`.
 *
 *   `enumerate(units, vocab, config)` — computes every one of the twelve
 *   enumerators' surfaces for one partition's units, producing `bags` (one
 *   `FeatureBag` per scope, spec §5's sparse-boolean rule already applied:
 *   a `bool`-typed surface is present in `surfaces` ONLY when true; a
 *   `cat`-typed surface is present whenever the scope is in that surface's
 *   applicability domain, whatever its value) and `domains` (spec §5,
 *   Appendix B's `domain` column: for every surface id that could ever appear
 *   in `bags`, the FULL set of stableIds eligible for it — true, false, or
 *   whatever categorical value — so a later counting stage can compute
 *   `n_false(q,r) = |domain(q) ∩ members(r)| − n_true(q,r)` without treating
 *   an out-of-domain scope as a silent "false"). §5's own sparse ≡ dense
 *   property is exercised in `enumerate.test.ts`, not proved here.
 *
 * Also exports the §7.3 static surface→overlap-group map (`overlapGroupForSurface`)
 * the mining pipeline's tautology skip consumes — the map only; the skip
 * ITSELF is a named mine stage (§7.3, "roles do not exist yet in the
 * pipeline order" at enumeration time), that pipeline's job, not this file's.
 */

import type { RootsConfig } from '../model/graph.js';
import type { ScopeUnit } from './extract.js';
import { dirnameOf, basenameOf, MIN_MODULE_CODE_FILES } from './extract.js';
import type { PartitionMap } from './partitions.js';

// ---------------------------------------------------------------------------
// E1's char-class name-shape function (spec §7.1's Appendix B verbatim rule):
// upper-case runs -> 'U', lower-case/digit runs -> 'a', `_ - $ .` literal,
// everything else -> '?'; runs of a period-≤-3 unit repeated ≥ 2 times fold
// to `(x)+`. Mirrors `prototype-roots2.mjs:59-63` exactly (the verified
// prototype implementation this file's own header comment names as the
// enumerator semantics reference).
// ---------------------------------------------------------------------------
// Exported (R4 Task 4): T5's replay change-signature needs the SAME E1
// char-class fold this file already applies to `unit.name` — a second copy
// would be a second definition of E1's own semantics, free to drift from
// this one (this file's own header cites the prototype line this mirrors).
export function nameShape(name: string): string {
  if (!name) return '?';
  let r = name.replace(/[A-Z]+/g, 'U').replace(/[a-z0-9]+/g, 'a').replace(/[^Ua_\-$.]/g, '?');
  for (let unitLen = 1; unitLen <= 3; unitLen++) {
    for (let start = 0; start + 2 * unitLen <= r.length; start++) {
      const unit = r.slice(start, start + unitLen);
      let end = start + unitLen;
      while (r.slice(end, end + unitLen) === unit) end += unitLen;
      if (end - start >= 2 * unitLen) {
        r = `${r.slice(0, start)}(${unit})+${r.slice(end)}`;
      }
    }
  }
  return r;
}

/** Spec §7.1 E8: relative specifiers normalize to a repo-rooted `~/`-prefixed path, extension stripped; package (non-relative) specifiers pass through unchanged. Mirrors `prototype-roots2.mjs:64-67`. */
function normalizeImportSpecifier(spec: string, fromRelPath: string): string {
  if (!spec.startsWith('.')) return spec;
  const parts = `${dirnameOf(fromRelPath)}/${spec}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `~/${out.join('/').replace(/\.[a-z]+$/, '')}`;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Spec §7.2 steps 2-3: drop under-support tokens, keep the top-K by count (ties token-asc), store the survivors sorted (this repo's canonical array convention). */
function topKSorted(counts: Map<string, number>, support: number, topK: number): string[] {
  const survivors = [...counts.entries()].filter(([, count]) => count >= support);
  survivors.sort(([tokenA, countA], [tokenB, countB]) => countB - countA || (tokenA < tokenB ? -1 : tokenA > tokenB ? 1 : 0));
  return survivors.slice(0, topK).map(([token]) => token).sort();
}

/** Per-partition survived vocabulary for the six vocabulary-bearing enumerators (spec §7.2), keyed exactly like `RootsConfig.enumerate.support`/`topK`. */
export interface RootsVocabularies {
  nodeType: string[];
  call: string[];
  decorator: string[];
  import: string[];
  supertype: string[];
  shape: string[];
}

/** Spec §7.1 E3's vocabulary-eligibility filter: "statement/expression/declaration/clause types only." Mirrors `prototype-roots2.mjs:445`. */
const VOCAB_ELIGIBLE_NODE_TYPE_RE = /statement|expression|declaration|clause/;

/**
 * Spec §7.2, for one partition's `ScopeUnit`s: count distinct candidate
 * tokens per vocabulary-bearing enumerator, then apply the support-floor +
 * top-K selection. Each unit already carries its own final `partitionId`,
 * which is what `buildVocabularies` groups by — `partitions` is a real,
 * consulted DEFENSIVE guard on top of that, not decoration: it restricts
 * output to `partitions.survivingPartitionIds`, so a caller that (by a bug
 * elsewhere, or a stale `units` array from a build that predates a
 * re-partition) passes a unit whose `partitionId` `derivePartitions` never
 * actually surfaced cannot silently produce a vocabulary for a partition
 * that does not exist. Under normal use — `finalizeUnits`' own output fed
 * straight through with the `PartitionMap` that produced it — every unit's
 * `partitionId` is already guaranteed to be a surviving one (R1's own
 * contract: a dropped scope's file never gets a `ScopeUnit` at all), so this
 * guard is a no-op in the common path and a real safety net off it.
 */
export function buildVocabularies(units: ScopeUnit[], partitions: PartitionMap, config: RootsConfig): Map<string, RootsVocabularies> {
  const survivingPartitionIds = new Set(partitions.survivingPartitionIds);

  const byPartition = new Map<string, ScopeUnit[]>();
  for (const unit of units) {
    if (unit.kind === 'module') continue; // module scopes carry only E12's (non-vocabulary) cat surfaces
    if (!survivingPartitionIds.has(unit.partitionId)) continue;
    const bucket = byPartition.get(unit.partitionId);
    if (bucket) bucket.push(unit);
    else byPartition.set(unit.partitionId, [unit]);
  }

  const result = new Map<string, RootsVocabularies>();
  for (const [partitionId, scopes] of byPartition) {
    const nodeTypeCounts = new Map<string, number>();
    const callCounts = new Map<string, number>();
    const decoratorCounts = new Map<string, number>();
    const importCounts = new Map<string, number>();
    const supertypeCounts = new Map<string, number>();
    const shapeCounts = new Map<string, number>();
    const importCountedFiles = new Set<string>(); // one count-pass per file, not per scope (fileImports repeats across every scope of a file)

    for (const scope of scopes) {
      if (scope.kind === 'method') {
        for (const nodeType of scope.nodeTypesSeen) if (VOCAB_ELIGIBLE_NODE_TYPE_RE.test(nodeType)) bump(nodeTypeCounts, nodeType);
        for (const callee of scope.calleeTexts) bump(callCounts, callee);
        for (const shape of scope.statementShapes) bump(shapeCounts, shape);
      }
      if (scope.kind === 'method' || scope.kind === 'type') {
        for (const decorator of scope.decorators) bump(decoratorCounts, decorator);
        for (const supertype of scope.supertypes) bump(supertypeCounts, supertype);
      }
      if (scope.kind === 'file' && !importCountedFiles.has(scope.relPath)) {
        importCountedFiles.add(scope.relPath);
        for (const raw of scope.fileImports) bump(importCounts, normalizeImportSpecifier(raw, scope.relPath));
      }
    }

    const support = config.enumerate.support;
    const topK = config.enumerate.topK;
    result.set(partitionId, {
      nodeType: topKSorted(nodeTypeCounts, support.nodeType, topK.nodeType),
      call: topKSorted(callCounts, support.call, topK.call),
      decorator: topKSorted(decoratorCounts, support.decorator, topK.decorator),
      import: topKSorted(importCounts, support.import, topK.import),
      supertype: topKSorted(supertypeCounts, support.supertype, topK.supertype),
      shape: topKSorted(shapeCounts, support.shape, topK.shape),
    });
  }
  return result;
}

/** One scope's computed surfaces — bool entries present ONLY when true (spec §5); cat entries present whenever the scope is in that surface's domain. */
export interface FeatureBag {
  stableId: string;
  skeyR: string;
  kind: ScopeUnit['kind'];
  relPath: string;
  surfaces: Record<string, string>;
}

/** Surface id -> the full set of stableIds eligible for it (spec §5's applicability domain), regardless of the value each would take. */
export type DomainMap = Map<string, Set<string>>;

function addToDomain(domains: DomainMap, surfaceId: string, stableId: string): void {
  const set = domains.get(surfaceId);
  if (set) set.add(stableId);
  else domains.set(surfaceId, new Set([stableId]));
}

/**
 * Computes every one of the twelve enumerators' surfaces for one partition's
 * `ScopeUnit`s. Appendix B's `domain` column is read literally per row,
 * INCLUDING the two grammar-conditioned bool rows (REWORK R3 closed the one
 * remaining proxy gap this file's header used to carry — `auto.has:<t>` now
 * reads `ScopeUnit.grammarNodeTypeVocabulary`, `extract.ts`'s own threaded
 * copy of `RootsBinding.nodeTypeVocabulary`, LITERALLY: "methods in a grammar
 * whose vocabulary holds `<t>`" is exactly `unit.grammarNodeTypeVocabulary.includes(t)`,
 * no per-partition observation involved at all):
 *
 *   - `auto.has:<t>` ("methods in a grammar whose vocabulary holds `<t>`"):
 *     `unit.grammarNodeTypeVocabulary` — the scope's OWN grammar's complete
 *     declared node-type vocabulary, captured at extraction time (when the
 *     correct `RootsBinding` is already in hand) and threaded through
 *     unchanged. See `extract.ts`'s `RawScope.grammarNodeTypeVocabulary` doc
 *     for why this replaced an earlier extension-observed empirical proxy —
 *     briefly, `EXT2GRAMMAR` is many-to-one (`.ts`/`.mts`/`.cts` share one
 *     grammar) and an extension-keyed reconstruction here would wrongly
 *     treat two extensions of the SAME grammar as different capability
 *     domains, undercounting `n_false` in the permissive direction.
 *   - `auto.deco:@<d>` / `auto.extends:<T>` ("scopes in a grammar with
 *     decorator/heritage nodes" — GENERIC, not per-token): resolved via
 *     `RawScope.grammarHasDecoratorTypes` (a real `RootsBinding.decorators`
 *     read, extraction-time) and `RawScope.grammarHasHeritageCandidacy` (an
 *     empirical per-scope proxy — see `extract.ts`'s `deriveHeritage` doc for
 *     why no static "grammar has heritage nodes" flag is available either;
 *     unlike E3's node-type vocabulary, tree-sitter's own node-types.json
 *     schema has no "does this grammar declare a heritage-shaped field"
 *     capability bit to read literally, so this one stays a documented
 *     per-scope proxy).
 *
 * Every other domain in Appendix B is a plain structural test
 * (`bodyStatementCount`, `hasReturnStatement`, `hasParameterList`,
 * `fileImports.length`, kind membership) computed directly from fields
 * `extract.ts` already collects, with no proxy involved.
 */
export function enumerate(units: ScopeUnit[], vocab: RootsVocabularies, config: RootsConfig): { bags: FeatureBag[]; domains: DomainMap } {
  const bags: FeatureBag[] = [];
  const domains: DomainMap = new Map();

  // E12's domain needs each resolved module directory's DIRECT file count —
  // a module unit can exist as a partition-root fallback target even with
  // fewer than MIN_MODULE_CODE_FILES files of its own (`extract.ts`'s
  // `finalizeUnits` doc), so this is recomputed here rather than assumed.
  const directFileCountByDir = new Map<string, number>();
  for (const unit of units) {
    if (unit.kind !== 'file') continue;
    const dir = dirnameOf(unit.relPath);
    directFileCountByDir.set(dir, (directFileCountByDir.get(dir) ?? 0) + 1);
  }

  const pathSegments = config.enumerate.pathSegments;
  const nodeTypeVocab = vocab.nodeType;
  const callVocab = vocab.call;
  const decoratorVocab = vocab.decorator;
  const importVocab = vocab.import;
  const supertypeVocab = vocab.supertype;
  const shapeVocab = vocab.shape;

  for (const unit of units) {
    const surfaces: Record<string, string> = {};
    const emitCat = (surfaceId: string, value: string): void => {
      surfaces[surfaceId] = value;
      addToDomain(domains, surfaceId, unit.stableId);
    };
    const emitBool = (surfaceId: string, value: boolean): void => {
      addToDomain(domains, surfaceId, unit.stableId);
      if (value) surfaces[surfaceId] = 'true';
    };

    if (unit.kind === 'method' || unit.kind === 'type') {
      // E1 nameshape — domain: "all named scopes" (method, type), LITERALLY
      // excluding anonymous ones (REWORK F6): `unit.name === '<anon>'` means
      // no one actually chose a name for this scope, so folding it through
      // `nameShape()` would fabricate a plausible-looking char-class string
      // (Appendix B's own worked convention names, e.g. `?a?`-shaped output)
      // out of a placeholder — never a real naming convention anyone wrote.
      if (unit.name !== '<anon>') {
        emitCat('auto.nameshape', nameShape(unit.name));
      }

      // E6-deco — domain: "scopes in a grammar with decorator nodes".
      if (unit.grammarHasDecoratorTypes) {
        for (const token of decoratorVocab) emitBool(`auto.deco:@${token}`, unit.decorators.includes(token));
      }
      // E9 extends — domain: "scopes in a grammar with heritage nodes".
      if (unit.grammarHasHeritageCandidacy) {
        for (const token of supertypeVocab) emitBool(`auto.extends:${token}`, unit.supertypes.includes(token));
      }
    }

    if (unit.kind === 'method') {
      // E2 arity — domain: "methods with a parameter list".
      if (unit.hasParameterList) emitCat('auto.arity', unit.arity >= 3 ? '3+' : String(unit.arity));

      // E4 first1 — domain: "methods with ≥ 1 body statement".
      if (unit.bodyStatementCount >= 1 && unit.firstStatementType !== undefined) {
        emitCat('auto.first1', unit.firstStatementType);
      }
      // E5 ret — domain: "methods with ≥ 1 return statement".
      if (unit.hasReturnStatement) emitCat('auto.ret', unit.lastReturnExprType ?? 'bare');

      // E11 varshape — domain: "methods declaring ≥ 2 locals".
      if (unit.localVarNames.length >= 2) emitCat('auto.varshape', modalNameShape(unit.localVarNames));

      // E3 has:<t> — domain: "methods in a grammar whose vocabulary holds
      // `<t>`", read LITERALLY off `grammarNodeTypeVocabulary` (this
      // function's own header explains why this is no longer an
      // extension-observed proxy).
      for (const token of nodeTypeVocab) {
        if (!unit.grammarNodeTypeVocabulary.includes(token)) continue;
        emitBool(`auto.has:${token}`, unit.nodeTypesSeen.includes(token));
      }
      // E6-call call:<c> — domain: "methods with ≥ 1 body statement".
      if (unit.bodyStatementCount >= 1) {
        for (const token of callVocab) emitBool(`auto.call:${token}`, unit.calleeTexts.includes(token));
        // E10 stshape:<sh> — same domain (Appendix B row).
        for (const token of shapeVocab) emitBool(`auto.stshape:${token}`, unit.statementShapes.includes(token));
      }
    }

    if (unit.kind === 'file') {
      // E1 filenameshape — domain: "all files".
      const stem = basenameOf(unit.relPath).replace(/\.[^./]+$/, '');
      emitCat('auto.filenameshape', nameShape(stem));

      // E7 dirN — domain: "all files"; "role cells only" (spec footnote) is a
      // MINING-layer placement rule (the mining pipeline's), not an
      // enumeration-time one. A
      // ROOT-LEVEL file (no containing directory at all) emits ZERO `dirN`
      // surfaces, a DELIBERATE, prototype-faithful decision, not an
      // under-match of "all files": there is no first path segment to name a
      // value with, and the prototype's own generator produces exactly the
      // same empty result (`prototype-roots2.mjs:112`:
      // `dirname(rel).split('/').filter(s => s !== '.')` — for a root file,
      // Node's `dirname` returns `'.'`, filtered away, leaving nothing to
      // `forEach` over). "In domain with no computable value" is not a state
      // a `cat` surface can represent (unlike a `bool` surface, which can be
      // legitimately absent-because-false); a root file is simply out of
      // E7's domain for every `dirN`, exactly like the prototype.
      const segments = dirnameOf(unit.relPath).split('/').filter((s) => s !== '' && s !== '.');
      for (let i = 0; i < Math.min(segments.length, pathSegments); i++) {
        emitCat(`auto.dir${i + 1}`, segments[i]);
      }

      // E8 imp:<s> — domain: "files with ≥ 1 import".
      if (unit.fileImports.length >= 1) {
        const normalized = new Set(unit.fileImports.map((spec) => normalizeImportSpecifier(spec, unit.relPath)));
        for (const token of importVocab) emitBool(`auto.imp:${token}`, normalized.has(token));
      }
    }

    if (unit.kind === 'module') {
      // E12 — domain: "directories with ≥ 3 code files" (recomputed above,
      // since a module unit can exist below the threshold as a
      // partition-root fallback target).
      if ((directFileCountByDir.get(unit.relPath) ?? 0) >= MIN_MODULE_CODE_FILES) {
        emitCat('auto.moddirshape', nameShape(basenameOf(unit.relPath)));
        emitCat('auto.modsize', modSizeBand(directFileCountByDir.get(unit.relPath) as number));
        const directFileShapes = units
          .filter((u) => u.kind === 'file' && dirnameOf(u.relPath) === unit.relPath)
          .map((u) => nameShape(basenameOf(u.relPath).replace(/\.[^./]+$/, '')));
        if (directFileShapes.length > 0) emitCat('auto.modfileshape', modalOf(directFileShapes));
      }
    }

    bags.push({ stableId: unit.stableId, skeyR: unit.skeyR, kind: unit.kind, relPath: unit.relPath, surfaces });
  }

  return { bags, domains };
}

/** Spec §7.1 E12's size band. */
function modSizeBand(fileCount: number): string {
  if (fileCount >= 20) return '20+';
  if (fileCount >= 8) return '8-19';
  return '3-7';
}

/** First-seen-wins modal value over an already-computed value list (stable ties, matching `Array.prototype.sort`'s stability over insertion order). */
function modalOf(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best as string;
}

/** E11's modal name-shape over sampled local-variable names. */
function modalNameShape(names: string[]): string {
  return modalOf(names.map(nameShape));
}

// ---------------------------------------------------------------------------
// Spec §7.3's static surface -> overlap-group map, exported for the mining
// pipeline's per-(role, surface) tautology skip (the skip ITSELF — testing a candidate's
// group against the role's own §8.8 defining feature groups — needs roles,
// which do not exist at enumeration time; only the STATIC map belongs here).
// Role features (§8.1) draw from name tokens, supertypes, decorators and
// package-import segments, so the four overlap groups are exactly:
// name-tokens (<-> E1, AND <-> E12's `auto.modfileshape` — Appendix B's own
// `overlap` column, `v6-spec.md:839`, names it explicitly; `auto.moddirshape`
// carries `—` there and has no group), supertype (<-> E9), decorator (<-> E6-
// deco), import-segments (<-> E8, AND <-> E7 placement — spec `:307`'s own
// parenthetical). REWORK F9: `auto.modfileshape` maps to `name-tokens` below
// per that table cell, even though roles (§8.1) never actually consume
// module-level surfaces today — the map is complete against Appendix B
// regardless of whether anything downstream currently exercises this
// particular cell; every OTHER enumerator surface (E2, E3, E4, E5, E10, E11,
// and E12's own `auto.moddirshape`/`auto.modsize`) has no overlap group at
// all and never participates in the tautology skip.
// ---------------------------------------------------------------------------
const OVERLAP_GROUP_RULES: ReadonlyArray<{ test: RegExp; group: string }> = [
  { test: /^auto\.nameshape$/, group: 'name-tokens' },
  { test: /^auto\.filenameshape$/, group: 'name-tokens' },
  { test: /^auto\.modfileshape$/, group: 'name-tokens' },
  { test: /^auto\.extends:/, group: 'supertype' },
  { test: /^auto\.deco:/, group: 'decorator' },
  { test: /^auto\.imp:/, group: 'import-segments' },
  { test: /^auto\.dir\d+$/, group: 'import-segments' },
];

/** Spec §7.3: the overlap group a surface id belongs to, or `undefined` if it belongs to none (never a tautology candidate). */
export function overlapGroupForSurface(surfaceId: string): string | undefined {
  for (const rule of OVERLAP_GROUP_RULES) {
    if (rule.test.test(surfaceId)) return rule.group;
  }
  return undefined;
}
