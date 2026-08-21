/**
 * source/cli/src/roots/history.ts — Task 4: the blob-record extraction seam.
 * Turns a historical blob (a git blob sha, plus the historical PATH it was
 * seen at in the walk) into scope records exactly ONCE ever, and persists
 * them content-addressed — spec §13.2 (`v6-spec.md:604-607`), §6.1
 * oversize/parse tolerance (`:222`), §6.2 binding cache (`:237`), §6.4
 * ordinals across key spaces (`:247`), §6.8's exclusion list (`:271`, D17),
 * §20.1 blob-rate budget (`:712`); program plan's key clause (`:75-76`).
 *
 * THREE PUBLIC OPERATIONS. `extractBlobRecord` is the PURE, per-file extraction
 * (no cache, no I/O beyond parsing): the historical mirror of
 * `pipeline.ts`'s `parseAndExtractAll` inner loop, applying the SAME two size
 * gates and the SAME registered-grammar/`forParsing` gate (D17 gate 2) so
 * R4-I7's one key space holds — a blob the live pass would never parse must
 * never acquire historical scopes that join nothing. `makeBlobRecordReader`
 * wraps it in a read-through cache over `io/roots-blob-cache.ts` (Task 1):
 * probe the shard, extract on a miss, write-through, and count exactly one
 * parse per distinct cache KEY via the caller-supplied `onParsed` hook — a RUN
 * DIAGNOSTIC ONLY ("blobs parsed this run", D4's own closing rule), never the
 * source of D4's `parsed`/`mb` rosters. Those rosters are accumulated from a
 * PERSISTED roster of distinct non-skipped cache keys, reading `bytes` and
 * `skipped` off each key's own blob RECORD — a cache hit and a fresh
 * extraction alike — precisely so the two numbers are properties of the
 * history, never of what this run did (R4-I3); wiring them to `onParsed`
 * instead would make a warm run report `parsed: 0`, the exact failure D4
 * warns against. `carriesLifecycleRows` is gate 2's own path-only half,
 * exported so a caller whose record never resolves a blob at all (`history-
 * replay.ts`'s `D`/`T` touch) can still answer gate 2 without a second
 * implementation of it.
 *
 * GRAMMAR SELECTION IS PATH-DERIVED, NEVER CONTENT-SNIFFED (R4-I6). The
 * historical path passed in IS the grammar signal — `getGrammarForExtension`
 * on its extension, nothing else — because a rename changes which grammar a
 * blob's TWO images (pre/post) extract under even when the blob content is
 * byte-identical (acceptance 4). `withParsedFile` keys the tree-sitter pool
 * off the SAME path for the identical reason, so this rule is structural
 * (built into which parser gets invoked), not merely a check this file
 * performs before calling it.
 *
 * D17 GATE 2, RESOLVED BEFORE ANY CACHE KEY EXISTS. A historical path that
 * fails `forParsing` (the merged built-in + config exclusions plus the
 * mining-only test-pattern carve-out — `makeRootsFileFilters`, never
 * re-implemented here) or resolves no registered grammar has no binding at
 * all, so it is answered from the path ALONE, in memory, before any key is
 * computed: `{bytes: 0, skipped: true, reason: 'excluded' | 'no-grammar'}`,
 * and the cache is never read or written for it (D11, D4). Both answers are
 * pure functions of the path — caching either would buy nothing and would
 * add one JSON file per distinct blob of every non-code file in the whole
 * history, against §20.1's per-blob budget. Gate 1 (`forMarkers`) is the
 * CALLER's (T8's probe-then-fetch protocol): a record failing it never
 * reaches this module at all.
 *
 * D11'S ROUND TRIP: a cached record stores the file's raw scopes with the
 * two GRAMMAR-DERIVED constants (`grammarHasDecoratorTypes`,
 * `grammarNodeTypeVocabulary`) stripped — they are a pure function of the
 * already-known `bindingHash` (already inside the cache key), so inlining a
 * whole grammar's node-type vocabulary into every blob record would multiply
 * the cache's size for zero information. A cache HIT re-attaches them from
 * the same binding before returning, so a hit's record and a fresh
 * extraction's record are DEEP-EQUAL for the same (sha, path) pair — the
 * property acceptance 1 pins. Each scope's own keys are additionally
 * canonicalized (`sortOwnKeys`) before either path returns, so the two are
 * BYTE-IDENTICAL under `JSON.stringify`, not merely deep-equal — see
 * `sortOwnKeys`'s own doc for why that stronger guarantee matters (R4-I3).
 * Only the two EXPENSIVE skips —
 * `'oversize'` (knowable only once the bytes/line-count are in hand) and
 * `'unparseable'` (knowable only after a parse attempt) — are ever WRITTEN;
 * `'no-grammar'`/`'excluded'` never reach the cache at all (above).
 */

import path from 'node:path';
import type { Tree } from '../ast/types.js';
import { withParsedFile } from '../ast/parser.js';
import { getGrammarForExtension } from '../utils/language-registry.js';
import { debugWrite } from '../utils/debug-log.js';
import { hashString } from '../io/hash.js';
import { readBlobRecord, writeBlobRecord } from '../io/roots-blob-cache.js';
import type { RootsConfig } from '../model/graph.js';
import { assetNameOfWasmFile, bindingForAsset, type RootsBinding } from './binding.js';
import { extractUnits, EXTRACTOR_VERSION, type RawScope, type ExtractOptions } from './extract.js';
import { makeRootsFileFilters } from './partitions.js';
import { MAX_PARSE_LINES } from './pipeline.js';

// -----------------------------------------------------------------------------
// Types (Interfaces produced)
// -----------------------------------------------------------------------------

/**
 * A `RawScope` (`extract.ts:92`) minus the two grammar-derived constants
 * (D11). A value satisfying this type is STRUCTURALLY compatible with a real
 * `RawScope` too (`Omit<>` only narrows what is GUARANTEED present) — which
 * is exactly what lets `extractBlobRecord`'s own fresh-extraction return
 * value carry the two constants at runtime (straight off `extractUnits`,
 * unstripped) while still satisfying this narrower, disk-shaped type: the
 * stripping only happens explicitly at the one place it matters, the actual
 * cache WRITE (`writeThroughRecord` below).
 */
export type StoredRawScope = Omit<RawScope, 'grammarHasDecoratorTypes' | 'grammarNodeTypeVocabulary'>;

export interface BlobScopeRecord {
  /** D4's `mb` input — the blob's raw byte length, before any UTF-8 decode. */
  bytes: number;
  skipped: false;
  scopes: StoredRawScope[];
}

/**
 * `reason` carries four values but only TWO are ever WRITTEN to the cache:
 * `'oversize'` and `'unparseable'` are knowable only once the bytes (or a
 * parse attempt) are in hand, so recording them is what makes the skip
 * permanent. `'no-grammar'` and `'excluded'` are produced in memory from the
 * path alone (D17 gate 2's two causes) and are NEVER written — a reader of a
 * `debugWrite` line still needs to know which of the four fired, which is
 * why all four stay in one union rather than splitting persisted from
 * transient reasons into two separate types.
 */
export type BlobSkipReason = 'oversize' | 'no-grammar' | 'excluded' | 'unparseable';

export interface SkippedBlobRecord {
  bytes: number;
  skipped: true;
  reason: BlobSkipReason;
}

export type BlobRecord = BlobScopeRecord | SkippedBlobRecord;

// -----------------------------------------------------------------------------
// blobCacheKey
// -----------------------------------------------------------------------------

/**
 * sha256 of the three joined (space-separated, mirroring `extract.ts`'s own
 * `stable_id` join style — `extract.ts:610`): the blob's own content sha, the
 * `EXTRACTOR_VERSION` that produced the record, and the PER-GRAMMAR
 * `bindingHash` of the grammar selected from the historical path's extension
 * — `binding.ts`'s `bindingForAsset(assetName).hash`, and NEVER the
 * all-grammar header fold (`pipeline.ts`'s `bindingSetHash`, spec `:137`).
 * §13.2 (`v6-spec.md:605`) is ambiguous between the two, and the choice is
 * not cosmetic: with the all-grammar fold there would be ONE key per blob
 * sha, so the same blob seen at `.ts` and at `.py` would collide (acceptance
 * 4 becomes unsatisfiable) and every cached record would be invalidated
 * whenever ANY unrelated grammar in the registry moved.
 *
 * The full 64-hex-character digest — never truncated, unlike `stable_id`'s
 * 16-char slice — matching D15's own description of a cache key's shape.
 */
export function blobCacheKey(blobSha: string, extractorVersion: string, bindingHash: string): string {
  return hashString(`${blobSha} ${extractorVersion} ${bindingHash}`);
}

// -----------------------------------------------------------------------------
// D17 gate 2 resolution (path-only, before any key exists)
// -----------------------------------------------------------------------------

interface Gate2Admitted {
  admitted: true;
  binding: RootsBinding;
  bindingHashValue: string;
}
interface Gate2Rejected {
  admitted: false;
  reason: 'no-grammar' | 'excluded';
}

/**
 * D17 gate 2, applied FIRST and from the historical path alone: `forParsing`
 * (the merged built-in + config exclusions plus the mining-only test-pattern
 * carve-out — `makeRootsFileFilters`, never a second exclusion list) and
 * THEN a registered-grammar lookup — that order, matching `pipeline.ts`'s
 * own live-path gate and `v6-spec.md:271`'s reading (D17): a path already
 * excluded is `'excluded'` regardless of whether its extension would
 * otherwise resolve a grammar; only a path that SURVIVES the exclusion test
 * and still resolves no grammar is `'no-grammar'`.
 *
 * Never inspects `content` — content is never in hand at this point, and
 * never would be even if it were (R4-I6: grammar selection is path-derived,
 * content sniffing is forbidden everywhere in this file).
 */
function resolveGate2(historicalPath: string, config: RootsConfig): Gate2Admitted | Gate2Rejected {
  const filters = makeRootsFileFilters(config);
  if (!filters.forParsing(historicalPath)) return { admitted: false, reason: 'excluded' };
  const grammarInfo = getGrammarForExtension(path.extname(historicalPath));
  if (!grammarInfo) return { admitted: false, reason: 'no-grammar' };
  const { binding, hash } = bindingForAsset(assetNameOfWasmFile(grammarInfo.wasmFile));
  return { admitted: true, binding, bindingHashValue: hash };
}

/**
 * The path-only half of D17 gate 2, exported for `history-replay.ts`'s `D`/`T`
 * touch — those records never resolve a `BlobRecord` (a delete's `postSha` is
 * null; a typechange is deliberately never blob-resolved at all), so they
 * cannot read gate 2's outcome off a resolved record's own skip reason the
 * way `A`/`M`/`R`/`C` do. Gate 2 itself needs nothing but the path, so this
 * wraps `resolveGate2` rather than making `history-replay.ts` re-derive
 * `forParsing`/`getGrammarForExtension` a second time (this module's own
 * no-duplication discipline, R4-I14) — one predicate, reused by both the
 * blob-resolvable and the never-blob-resolvable record shapes.
 */
export function carriesLifecycleRows(historicalPath: string, config: RootsConfig): boolean {
  return resolveGate2(historicalPath, config).admitted;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// -----------------------------------------------------------------------------
// extractBlobRecord (Steps 1-2)
// -----------------------------------------------------------------------------

/**
 * Pure per-blob extraction against a historical blob's content, once its
 * historical path has already cleared D17 gate 2. Applies, in order: the
 * gate itself (from `relPath` alone — a rejection short-circuits before
 * `content` is even inspected); `history.blobMaxBytes` on `content`'s RAW
 * byte length (the length BEFORE any UTF-8 decode, matching the live path's
 * `Buffer.byteLength(content, 'utf8')` check at `pipeline.ts:126` exactly —
 * `content` here already arrives as a `Buffer`, so its own `.length` IS that
 * byte length, no re-encoding needed); the SAME `MAX_PARSE_LINES` (40 000)
 * line-count gate the live path applies (`pipeline.ts:127` — imported, never
 * re-typed, so the two thresholds can never drift apart, R4-I7); and finally
 * a parse via `withParsedFile`/`extractUnits` — the SAME `extractUnits` the
 * live path calls, so ordinals and `qualifiedName` are identical in both key
 * spaces (R4-I7). A decode that produces replacement characters is still
 * parsed — content is never sniffed to guess a grammar or an encoding
 * (R4-I6). A throw from the parser degrades to an `'unparseable'` skip plus
 * one `debugWrite`; the caller (this function's own promise resolving, never
 * rejecting on a parse failure) continues, matching R4-I10.
 */
export async function extractBlobRecord(relPath: string, content: Buffer, config: RootsConfig): Promise<BlobScopeRecord | SkippedBlobRecord> {
  const gate2 = resolveGate2(relPath, config);
  if (!gate2.admitted) {
    return { bytes: 0, skipped: true, reason: gate2.reason };
  }
  return extractAdmitted(relPath, content, config, gate2.binding);
}

/**
 * `extractAdmitted`'s own return shape: `scopes` is a genuine `RawScope[]`
 * (straight off `extractUnits`, grammar constants included), not yet
 * narrowed to the public `StoredRawScope[]` contract. Keeping the WIDER type
 * internal (rather than narrowing at `extractAdmitted`'s own return) is what
 * lets the read-through cache's write path (`writeThroughRecord`, below)
 * call `stripGrammarConstants` on it directly, while `extractBlobRecord`'s
 * public signature still returns `BlobScopeRecord` — `RawScope[]` is
 * structurally assignable to `StoredRawScope[]` (`Omit<>` only narrows the
 * GUARANTEE, not the runtime shape), so the assignment at each public
 * boundary below is ordinary covariant widening, not a cast.
 */
interface FreshBlobScopeRecord {
  bytes: number;
  skipped: false;
  scopes: RawScope[];
}

/** The gate-2-already-resolved extraction body — shared by `extractBlobRecord` and the read-through cache's own miss path, so gate 2 is resolved exactly once per call site rather than twice per miss. */
async function extractAdmitted(relPath: string, content: Buffer, config: RootsConfig, binding: RootsBinding): Promise<FreshBlobScopeRecord | SkippedBlobRecord> {
  const bytes = content.length; // already raw bytes — no re-encoding
  if (bytes > config.history.blobMaxBytes) {
    return { bytes, skipped: true, reason: 'oversize' };
  }

  const text = content.toString('utf-8');
  // The live path's SECOND size gate (`pipeline.ts:127`), applied identically
  // — R4-I7's one key space only holds if the two paths admit the same files.
  // Knowable only once the content is decoded, so — like the byte-count gate
  // above — this is an EXPENSIVE skip in D11's sense and is recorded under
  // the same `'oversize'` reason (no fifth reason value is added: the
  // record's purpose, "do not fetch and re-attempt this key", is identical
  // for both gates).
  if (text.split('\n').length > MAX_PARSE_LINES) {
    return { bytes, skipped: true, reason: 'oversize' };
  }

  const extractOptions: ExtractOptions = {
    shapeDepth: config.enumerate.shapeDepth,
    shapeMaxStatements: config.enumerate.shapeMaxStatements,
    localVarSampleMax: config.enumerate.localVarSampleMax,
  };

  try {
    const scopes = await withParsedFile(relPath, text, (tree: Tree) => extractUnits(relPath, text, tree, binding, extractOptions));
    // `scopes` carries the two grammar constants exactly as `extractUnits`
    // produced them — deliberately NOT stripped here. That is what makes a
    // fresh extraction's record deep-equal to a cache HIT's reattached
    // record for the identical (sha, path) pair (acceptance 1): the write
    // path (`writeThroughRecord`, below) is the ONE place the two constants
    // are ever actually stripped, and `extractBlobRecord`'s own public
    // return (`StoredRawScope[]`-typed) simply widens back down over this
    // richer runtime value at that boundary — see `FreshBlobScopeRecord`'s
    // own doc above.
    //
    // Each scope's OWN keys are also canonicalized (`sortOwnKeys`, below)
    // before this returns — not just deep-equal but BYTE-IDENTICAL, under
    // `JSON.stringify`, to what a cache HIT for the same (sha, path) produces
    // (`makeBlobRecordReader`'s hit branch runs the same normalizer). Without
    // it a fresh scope carries `extractUnits`' own field-declaration order
    // while a hit's carries the on-disk canonical order with the two grammar
    // constants re-appended last — equal values, different key order — and
    // R4-I3 depends on nothing downstream noticing that difference by
    // `JSON.stringify`-ing or hashing a scope directly.
    return { bytes, skipped: false, scopes: scopes.map(sortOwnKeys) };
  } catch (e) {
    debugWrite(`[roots-history] extractBlobRecord: unparseable blob at historical path '${relPath}': ${errMsg(e)}`);
    return { bytes, skipped: true, reason: 'unparseable' };
  }
}

// -----------------------------------------------------------------------------
// makeBlobRecordReader (Step 3): the read-through cache
// -----------------------------------------------------------------------------

/**
 * Re-orders a plain object's own keys into code-point sort
 * order — the SAME canonicalization convention `io/roots-blob-cache.ts`'s
 * `writeBlobRecord` already applies at the byte level (its own `canonicalJson`,
 * and `binding.ts`'s private copy of the same rule), applied here to the
 * in-memory VALUE this module returns rather than to a serialized string.
 * Array element order AND identity are left untouched (order there is data,
 * not a key-order artifact, and `extract.ts`'s shared references stay
 * shared); only the top-level object's keys are sorted — see the
 * prototype-safety and flat-shape notes in the function body.
 *
 * Applied to every scope this module hands back, on BOTH the fresh-extraction
 * path (`extractAdmitted`, above) and the cache-HIT path (below), so a hit and
 * a fresh miss for the identical (sha, path) pair are not merely deep-equal
 * but BYTE-IDENTICAL under `JSON.stringify` — closing the gap a live review
 * found: a fresh scope arrives in `extractUnits`' own field-declaration order,
 * while a stored scope arrives already key-sorted by `canonicalJson` (the
 * on-disk write) with the two grammar constants re-appended LAST by
 * `reattachGrammarConstants` — two different, non-canonical orders for equal
 * values, until both are run through this one normalizer. Without it, the
 * moment a downstream consumer (T5/T8) `JSON.stringify`s or hashes a scope
 * directly instead of treating it as a bag of named fields, a cold run and a
 * warm run would disagree on those bytes — exactly the class of defect R4-I3
 * exists to rule out, on a path with no test to catch it today.
 */
function sortOwnKeys<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  // `Object.fromEntries` uses CreateDataProperty, so a `__proto__` own key
  // (which `JSON.parse` happily produces from a corrupt or hand-written
  // shard) stays an OWN key instead of silently vanishing onto the object's
  // prototype — the same proto-safe construction this node's log records
  // adopting once before. Non-recursive on purpose: a `RawScope`'s fields
  // are scalars and arrays of scalars, and array elements keep their
  // IDENTITY (shared references from `extract.ts` stay shared). If
  // `RawScope` ever gains a nested object field, this must recurse again —
  // bring the recursion back with `Object.fromEntries` at that point.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
  ) as T;
}

function stripGrammarConstants(scope: RawScope): StoredRawScope {
  const { grammarHasDecoratorTypes, grammarNodeTypeVocabulary, ...rest } = scope;
  void grammarHasDecoratorTypes; // deliberately dropped (D11) — a pure function of `bindingHash`, already inside the cache key
  void grammarNodeTypeVocabulary; // deliberately dropped (D11) — same reason
  return rest;
}

/** D11's read-side half: the two grammar constants are a pure function of `binding` (already resolved for this key), so reattaching them costs nothing and needs no extra data. */
function reattachGrammarConstants(scope: StoredRawScope, binding: RootsBinding): RawScope {
  return {
    ...scope,
    grammarHasDecoratorTypes: binding.decorators.length > 0,
    grammarNodeTypeVocabulary: binding.nodeTypeVocabulary,
  };
}

/**
 * Structural validation of whatever `readBlobRecord` handed back (`unknown`
 * — `io/roots-blob-cache.ts` is generic over the record and knows nothing of
 * this shape). A shard that parsed as JSON but is not shaped like a
 * `BlobRecord` this module ever wrote is corruption from THIS module's own
 * perspective and reads as a MISS — one `debugWrite`, never a throw — the
 * same per-record tolerance `io/roots-blob-cache.ts`'s own header comment
 * documents (R4-I10). Deliberately shallow beyond the top level: a
 * `StoredRawScope`'s own ~18 fields are exactly what `writeThroughRecord`
 * itself wrote moments (or runs) earlier, through the SAME canonical
 * serializer every other content-addressed shard in this codebase uses, so a
 * top-level shape check catches the failure modes that actually occur
 * (truncation, a half-written temp file surviving a crash, an unrelated JSON
 * value) without re-deriving a full per-field schema this module does not
 * otherwise need.
 */
function parseStoredRecord(raw: unknown, key: string): BlobScopeRecord | SkippedBlobRecord | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.bytes !== 'number' || typeof r.skipped !== 'boolean') {
    debugWrite(`[roots-history] corrupt blob-cache record for key ${key}: not shaped like a BlobRecord`);
    return undefined;
  }
  if (r.skipped) {
    // Only these two reasons are ever WRITTEN (D11) — anything else read
    // back is corruption, not a legitimate stored value.
    if (r.reason !== 'oversize' && r.reason !== 'unparseable') {
      debugWrite(`[roots-history] corrupt blob-cache record for key ${key}: unexpected skip reason '${String(r.reason)}'`);
      return undefined;
    }
    return { bytes: r.bytes, skipped: true, reason: r.reason };
  }
  if (!Array.isArray(r.scopes)) {
    debugWrite(`[roots-history] corrupt blob-cache record for key ${key}: 'scopes' is not an array`);
    return undefined;
  }
  return { bytes: r.bytes, skipped: false, scopes: r.scopes as StoredRawScope[] };
}

/**
 * `bytes`, `skipped: false`, `scopes` — the exact fields D11 says are ever
 * persisted, `scopes` stripped of the two grammar constants. The one and
 * only place stripping happens (`extractAdmitted`'s own return already
 * carries them, deliberately, so a caller reading directly from
 * `extractBlobRecord` gets a record deep-equal to a cache hit's).
 */
function writeThroughRecord(record: FreshBlobScopeRecord): { bytes: number; skipped: false; scopes: StoredRawScope[] } {
  return { bytes: record.bytes, skipped: false, scopes: record.scopes.map(stripGrammarConstants) };
}

/**
 * The read-through cache over `io/roots-blob-cache.ts` (Task 1): probe the
 * shard, extract on a miss, write-through, one `onParsed()` per genuine miss
 * — never fired on a hit, never fired for a gate-2 rejection, which never
 * reaches the cache at all. `onParsed` is a RUN DIAGNOSTIC ONLY, not the
 * source of D4's `parsed`/`mb` rosters (see the file header comment): it also
 * fires for an EXPENSIVE skip (`'oversize'`/`'unparseable'`) — a genuine miss
 * that keys, probes and writes, even though nothing was actually parsed — so
 * "once per genuine miss" and "once per successful parse" are not the same
 * count. D4's rosters are accumulated elsewhere, from the persisted key
 * roster, reading `skipped`/`bytes` off each record — hit and fresh
 * extraction alike.
 *
 * `content` is `Buffer | undefined` because a caller that already knows (or
 * expects) a key to be a cache HIT need not have fetched the blob at all —
 * T8's windowed probe-then-fetch protocol (D16) fetches only the keys that
 * turn out to be MISSES, and calls this reader for every touched key either
 * way. On a genuine MISS with no `content` supplied, this is a caller
 * contract violation (the probe should have triggered a fetch first) rather
 * than a degraded external condition, so it THROWS rather than silently
 * fabricating a skip record that would then be (wrongly) cached.
 */
export function makeBlobRecordReader(
  cacheDir: string,
  config: RootsConfig,
  onParsed?: () => void,
): (sha: string, relPath: string, content: Buffer | undefined) => Promise<BlobRecord> {
  return async (sha: string, relPath: string, content: Buffer | undefined): Promise<BlobRecord> => {
    const gate2 = resolveGate2(relPath, config);
    if (!gate2.admitted) {
      // Never keyed, never probed, never fetched, never cached (D11, D17, D4).
      return { bytes: 0, skipped: true, reason: gate2.reason };
    }
    const { binding, bindingHashValue } = gate2;
    const key = blobCacheKey(sha, EXTRACTOR_VERSION, bindingHashValue);

    const cached = parseStoredRecord(await readBlobRecord(cacheDir, key), key);
    if (cached) {
      if (!cached.skipped) {
        // `sortOwnKeys` closes the hit-vs-miss key-order gap (see its own doc
        // above): without it, a hit's re-attached scope is deep-equal to a
        // fresh miss's but not byte-identical under `JSON.stringify`.
        return { bytes: cached.bytes, skipped: false, scopes: cached.scopes.map((s) => sortOwnKeys(reattachGrammarConstants(s, binding))) };
      }
      return cached;
    }

    if (content === undefined) {
      throw new Error(
        `makeBlobRecordReader: cache miss for key ${key} (historical path '${relPath}', blob ${sha}) with no content supplied — the caller must fetch this blob before calling again`,
      );
    }

    const fresh = await extractAdmitted(relPath, content, config, binding);
    onParsed?.();
    if (fresh.skipped) {
      // Only the two EXPENSIVE skips reach here at all — gate 2's rejections
      // returned above without ever touching the cache. Recording BOTH
      // (D11) is what makes acceptance 5's "never parsed on any later run"
      // hold: the next call for this same key is a HIT.
      await writeBlobRecord(cacheDir, key, fresh);
      return fresh;
    }
    await writeBlobRecord(cacheDir, key, writeThroughRecord(fresh));
    return fresh;
  };
}
