import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type { PredicateTrace } from '../model/file-when.js';
import { evaluateFileWhen, type EvalContext } from './file-when-evaluator.js';
import type { FileContentCache } from '../io/file-content-cache.js';
import { hashFileRaw } from '../io/hash.js';
import type { TypeClassCache } from '../io/type-class-cache.js';

export type TypeMatch = {
  typeId: string;
  trace: PredicateTrace;
};

export type ClosestType = {
  typeId: string;
  trace: PredicateTrace;
  score: number;
};

export type UnreadableType = {
  typeId: string;
  reason: string;
  /** Why the file could not be evaluated: a genuine read failure, or over the content-scan size limit. */
  kind: 'read' | 'too-large';
};

export type ClassificationResult = {
  matches: TypeMatch[];
  closest: ClosestType[];
  unreadable: UnreadableType[];
};

/**
 * `classifyFile`'s three returned arrays — `matches`, `closest`, `unreadable`
 * — are each SETS/SELECTIONS that are order-independent by construction
 * (io/type-class-cache.ts's `architecturePredicateHash` sorts by id before
 * hashing, so a pure reorder of whole type blocks in yg-architecture.yaml
 * never changes which shard a file's classification is stored under). But
 * each ARRAY, wherever it comes from, still reflects whatever order it was
 * built in — `Object.entries(graph.architecture.node_types)`'s declaration
 * order on a fresh evaluation, or a shard's on-disk write order on a cache
 * hit — and several callers (the ambiguous-node-type message, the
 * strict-match pick, `yg type-suggest --file`'s closest-types list, `yg
 * check`'s file-unreadable error) render one of these arrays verbatim.
 * `sortedByTypeId` and `sortedByScoreThenTypeId` below are applied to ALL
 * THREE arrays, on every path out of `classifyFile`, so a pure type reorder
 * can never change what a warm (cached) run renders versus what a cold
 * (freshly evaluated) run computes:
 *
 *   - `matches`/`unreadable` are untruncated — every element that belongs in
 *     the array is already present regardless of build order, so sorting by
 *     `typeId` alone canonicalizes them completely, even re-applied to an
 *     older shard whose on-disk order predates this sort.
 *   - `closest` is truncated to the top 3, so declaration order could
 *     otherwise decide MEMBERSHIP, not just sequence: sorting by
 *     (score, typeId) must run before the `.slice(0, 3)` that builds a fresh
 *     result, or the selection itself stays order-dependent. Once every
 *     `.slice(0, 3)` sees a canonically pre-sorted array, the 3 chosen never
 *     depend on where in the file their type happens to be declared.
 *
 * This closes the class completely: `io/type-class-cache.ts`'s
 * `CachedClassification` has exactly five fields — `v` and `key` (cache
 * bookkeeping, never rendered) plus these three arrays — so once all three
 * are canonical, nothing else stored under a cache hit can still vary. A
 * `trace` riding inside `matches`/`closest` is derived from its OWN type's
 * `when` alone, unaffected by any other type's position in the file; the
 * only edit besides a pure whole-block reorder — adding, removing, renaming,
 * or re-`enforce`-ing a type, or changing any type's `when` (including the
 * order of an `any_of`/`all_of` list, which the underlying predicate hash
 * does NOT canonicalize) — changes `architecturePredicateHash` and
 * invalidates every shard, so a warm run and a cold run are never comparing
 * a stale shard against a fresh evaluation of a genuinely different rule
 * set; they are always the identical rule set, one read from disk and one
 * just computed.
 */
function sortedByTypeId<T extends { typeId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0));
}

/**
 * Sort `closest` candidates by score descending, ties broken by typeId
 * ascending — the same canonicalization `sortedByTypeId` gives `matches`/
 * `unreadable`, composed with the score ordering `closest` also carries.
 * `Array.prototype.sort` is stable (guaranteed since ES2019), so sorting by
 * typeId first and by score second preserves the typeId tie-break among
 * equal scores instead of losing it to whatever order the ties arrived in.
 */
function sortedByScoreThenTypeId(items: ClosestType[]): ClosestType[] {
  return sortedByTypeId(items).sort((a, b) => b.score - a.score);
}

/**
 * Classify a file against all types in the architecture.
 *
 * Returns:
 *   matches     — types whose `when` evaluates to true on this file
 *   closest     — top 3 non-matching types ranked by satisfied-fraction (descending)
 *   unreadable  — types whose `when` could not be evaluated on this file at all
 *                 (e.g. a `content:` predicate on a file over the size limit).
 *                 Distinct from a plain non-match: the predicate was never
 *                 actually applied, so this file must not be silently treated
 *                 as failing that type.
 *
 * Types without `when` (organizational) are skipped.
 * Files under `.yggdrasil/` are auto-exempt (evaluator returns vacuously true).
 *
 * `classCache`, when supplied, is consulted first: the file's own
 * repo-relative path, together with its RAW content hash (io/hash.ts's
 * `hashFileRaw` — full bytes, no line-ending normalization, independent of
 * FileContentCache's own probe/size-limited read) keyed against `classCache`'s
 * own once-per-instance architecture-predicate hash, forms the cache key. The
 * raw (un-normalized) hash is deliberate: `hashFile`'s usual normalization
 * would let a CRLF file and its line-ending-normalized LF twin collide on the
 * same key even though FileContentCache — the actual predicate-evaluation
 * input below — reads raw, un-normalized bytes and can disagree between them.
 * A hit skips the whole `evaluateFileWhen` loop below; a miss runs it as today
 * and, on success, best-effort writes the result back. Omitting `classCache`
 * runs exactly as before — the parameter changes nothing for a caller that
 * does not pass one. A failure hashing the file (vanished mid-run, permission
 * denied, …) is treated as an unconditional cache miss rather than thrown:
 * the ordinary loop below already has its own robust unreadable-file handling
 * via FileContentCache, and a caching failure must never be the reason a
 * file's classification blows up.
 */
export async function classifyFile(
  absPath: string,
  repoRelPath: string,
  graph: Graph,
  cache: FileContentCache,
  classCache?: TypeClassCache,
): Promise<ClassificationResult> {
  let contentHash: string | undefined;
  if (classCache) {
    try {
      contentHash = await hashFileRaw(absPath);
    } catch {
      contentHash = undefined;
    }
    if (contentHash !== undefined) {
      const cached = classCache.get(contentHash, repoRelPath);
      if (cached) {
        return {
          matches: sortedByTypeId(cached.matches),
          closest: sortedByScoreThenTypeId(cached.closest),
          unreadable: sortedByTypeId(cached.unreadable),
        };
      }
    }
  }

  const matches: TypeMatch[] = [];
  const partialScores: ClosestType[] = [];
  const unreadable: UnreadableType[] = [];

  const ctx: EvalContext = {
    absPath,
    repoRelPath,
    projectRoot: path.dirname(graph.rootPath),
    cache,
  };

  for (const [typeId, def] of Object.entries(graph.architecture.node_types)) {
    if (def.when === undefined) continue;
    const result = await evaluateFileWhen(def.when, ctx);
    if (result.unreadable) {
      unreadable.push({
        typeId,
        reason: result.unreadableReason ?? 'unreadable',
        kind: result.unreadableKind ?? 'read',
      });
      continue;
    }
    if (result.result) {
      matches.push({ typeId, trace: result.trace });
    } else {
      const score = computeSatisfiedFraction(result.trace);
      partialScores.push({ typeId, trace: result.trace, score });
    }
  }

  const closest = sortedByScoreThenTypeId(partialScores).slice(0, 3);

  const result: ClassificationResult = {
    matches: sortedByTypeId(matches),
    closest,
    unreadable: sortedByTypeId(unreadable),
  };
  if (classCache && contentHash !== undefined) {
    await classCache.set(contentHash, repoRelPath, result);
  }
  return result;
}

/**
 * Compute satisfied-fraction of a predicate trace (range 0..1).
 *
 * atom:    1.0 if matched, 0.0 otherwise
 * all_of:  average of children scores (1.0 for empty)
 * any_of:  max of children scores (0.0 for empty)
 * not:     1 - child score
 * exempt:  1.0 (vacuously true)
 */
function computeSatisfiedFraction(trace: PredicateTrace): number {
  switch (trace.kind) {
    case 'atom-path':
    case 'atom-content':
      return trace.result ? 1.0 : 0.0;
    case 'all_of': {
      if (trace.children.length === 0) return 1.0;
      const sum = trace.children.reduce((acc, c) => acc + computeSatisfiedFraction(c), 0);
      return sum / trace.children.length;
    }
    case 'any_of': {
      if (trace.children.length === 0) return 0.0;
      return Math.max(...trace.children.map(computeSatisfiedFraction));
    }
    case 'not':
      return 1.0 - computeSatisfiedFraction(trace.child);
    case 'exempt':
      return 1.0;
  }
}
