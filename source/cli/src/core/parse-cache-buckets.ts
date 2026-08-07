/**
 * source/cli/src/core/parse-cache-buckets.ts — per-(aspect, node) parse-cache
 * buckets for the fill stage (spec §7).
 *
 * A deterministic check.mjs or an LLM companion.mjs runs buildUnitCtx once per
 * PAIR — and for a `per: file` rule, a pair is one SUBJECT FILE, not one node.
 * Before this grouping, every pair (in the non-pooled deterministic branch and
 * every LLM pair dispatched through the tier pool) built and destroyed its own
 * throwaway ParseCache, so a `per: file` rule with N subjects on a node whose
 * relation target maps M files re-parsed that target's M files N times over —
 * discarding every one of the N-1 redundant parses.
 *
 * Grouping by (aspectId, nodePath) — or, for a nodeless (type-covered) subject,
 * its own unit key, since there is no node to group by — gives every subject of
 * the SAME rule on the SAME node (or the same nodeless file) one shared cache
 * instead of one each. `parseCache-holding-Trees` must not accumulate for the
 * life of a whole run on a large repo (see destroyParseCache's own doc), so a
 * bucket's cache is destroyed the moment every pair sharing it has settled —
 * counted down here, not held for the life of the tier's pool or the whole run.
 */

import type { ExpectedPair } from './pairs.js';
import { destroyParseCache } from '../structure/index.js';
import type { ParseCache } from '../structure/index.js';

/**
 * The bucket key for a pair's shared parse cache: (aspectId, nodePath) for a
 * component-owned pair, or (aspectId, unitKey) for a nodeless one (there is no
 * node to group by — its own file path stands in, so it never collides with a
 * DIFFERENT nodeless file of the same aspect).
 */
export function parseCacheBucketKey(pair: ExpectedPair): string {
  return pair.nodePath !== undefined ? `${pair.aspectId}\0${pair.nodePath}` : `${pair.aspectId}\0${pair.unitKey}`;
}

export interface ParseCacheBucket { cache: ParseCache; remaining: number }

/**
 * Build one bucket per distinct (aspectId, node/unit) key present in `pairs`,
 * each holding a fresh, empty `ParseCache` and a countdown of how many pairs in
 * `pairs` share it. Bucket members MAY run concurrently with each other (the
 * LLM tier pool does not serialize same-bucket pairs) — a plain `Map`-backed
 * `ParseCache` is safe under that interleaving (JS has no threads; the worst a
 * race can do is a same-file double-parse on a bucket's first wave, never
 * corruption or a stale-content read — the recorded doc on hook-loader.ts's
 * enumerateNodeMappedFilesCached and ctx-parsers.ts's content-equality gate are
 * what actually guard correctness, not this Map).
 */
export function buildParseCacheBuckets(pairs: ExpectedPair[]): Map<string, ParseCacheBucket> {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const key = parseCacheBucketKey(p);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const buckets = new Map<string, ParseCacheBucket>();
  for (const [key, remaining] of counts) buckets.set(key, { cache: new Map(), remaining });
  return buckets;
}

/**
 * Release one pair's hold on its bucket's shared parse cache. Once every pair
 * sharing a bucket has settled (remaining reaches 0), that bucket's cache is
 * destroyed immediately — not held until the rest of the tier's pool or the
 * whole run finishes — and removed from `buckets`, so `pair`'s own bucket
 * lookup afterward correctly finds nothing.
 */
export function releaseParseCacheBucket(buckets: Map<string, ParseCacheBucket>, pair: ExpectedPair): void {
  const key = parseCacheBucketKey(pair);
  const bucket = buckets.get(key);
  if (!bucket) return;
  bucket.remaining -= 1;
  if (bucket.remaining <= 0) {
    destroyParseCache(bucket.cache);
    buckets.delete(key);
  }
}

/**
 * Destroy whatever caches a bucket map still holds. A BACKSTOP for the phase
 * loops' `finally`: the per-pair release above already empties every bucket in
 * the common case, so this normally iterates nothing. It exists for a bucket
 * whose pair never reached its own release — see each call site for the exact
 * escape it guards.
 */
export function destroyRemainingParseCaches(buckets: Map<string, ParseCacheBucket>): void {
  for (const { cache } of buckets.values()) destroyParseCache(cache);
}
