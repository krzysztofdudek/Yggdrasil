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
import { writeHistoryState, type HistoryStateMeta } from '../io/roots-history-store.js';
import type { RootsConfig, LedgerEntry } from '../model/graph.js';
import { assetNameOfWasmFile, bindingForAsset, type RootsBinding } from './binding.js';
import { extractUnits, EXTRACTOR_VERSION, dirnameOf, type RawScope, type ExtractOptions } from './extract.js';
import { makeRootsFileFilters } from './partitions.js';
import { MAX_PARSE_LINES } from './pipeline.js';
import {
  walkHistory,
  readHead,
  openBlobReader,
  isShallowRepository,
  GitLogError,
  type HistoryCommitRecord,
  type WalkOptions,
  type BlobReader,
} from '../utils/git-history.js';
import {
  createReplayState,
  replayCommit,
  finishReplay,
  serializeReplayState,
  deserializeReplayState,
  type LifecycleRow,
  type ValueEvent,
  type BlobRecordLookup,
  type ReplayThresholds,
} from './history-replay.js';
import {
  createCochangeState,
  accumulateCochange,
  finishCochange,
  serializeCochangeState,
  deserializeCochangeState,
  type CochangePair,
  type CochangeThresholds,
} from './history-cochange.js';
import { baseWeightOfRow, stableDaysOf } from './weights.js';
import {
  HISTORY_STATE_SCHEMA_VERSION,
  resolveWalkMode,
  parseResumeState,
  deriveStateEpoch,
} from './history-resume.js';

// Re-exported so `roots/history.js` stays the ONE public entry point for
// resume-adjacent behavior — `cli/roots.ts`'s D13 short-circuit and this
// module's own tests import these from here, never from `history-resume.js`
// directly, even though the implementation lives there (split purely for the
// prompt-size ceiling, see that file's own header).
export {
  HISTORY_STATE_SCHEMA_VERSION,
  computeInputsHash,
  computeCurrentInputsHash,
  allRegisteredGrammarBindingHashes,
  historyConfigSubtree,
  decideWalkMode,
  isWindowingActive,
  resolveWalkMode,
  parseResumeState,
  deriveStateEpoch,
  type WalkMode,
  type InputsHashIngredients,
  type DecideWalkModeInputs,
  type ResolvedWalkMode,
  type ParsedResumeState,
} from './history-resume.js';

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

// -----------------------------------------------------------------------------
// buildHistoryJoin (R4 Task 8): the orchestration entry point composing T2's
// walk, this module's own cache reader, T5's replay and T6's co-change into
// the finished join `runRootsIndex` wires into `mine()`'s weight functions
// and the model body — spec §9.4c degenerate case (`v6-spec.md:405-409`),
// §16.2 (`:655`), §18.4 (`:687`), §21.1 (`:719`), Appendix D (`:861-897`).
//
// DEGRADED MODE (R4-I4, Step 2): no git repository (no resolvable HEAD), a
// SHALLOW clone, or a walk that throws ⇒ `undefined` — never a partial join.
// The pipeline's own default (constant weights, no AgeFn) is what a caller
// falls back to; this function's only degraded-mode job is to say so.
//
// D17 GATE 1 IS APPLIED HERE, ONCE — before the replay, the co-change
// accumulator, or the blob roster see a commit's files — on a record's
// POST-image path (`newPath ?? path`, D17 clause 1: `A`/`M`/`R`/`C` alike,
// and it is what `D`/`T` already carry as their only path). One filtered
// array feeds all three consumers, so none of them can drift from the
// others on what "a changed file" means. The commit itself is still walked
// and still counted in `historyStats.commits` even when every one of its
// records is filtered away.
//
// THE PROBE-THEN-FETCH PROTOCOL (T8 Step 1) is implemented here as a
// GLOBAL, deduped pass over the whole walked range rather than literally
// interleaved with `walkHistory`'s own streaming — `walkHistory`'s `onCommit`
// callback is synchronous (`(c: HistoryCommitRecord) => void`, T2's own
// landed interface), so genuine async probing cannot be awaited from inside
// it. This module instead: (1) walks the full range, collecting every
// gate-1-surviving commit plus the deduped set of every admitted
// `(sha, path) -> key` reference the walk names; (2) probes every distinct
// key's on-disk cache entry once `walkHistory`'s own promise settles; (3)
// fetches only the MISSES, chunked into `BLOB_FETCH_CHUNK_SHAS` (400, T2's
// own per-request bound) through the ONE `BlobReader` this function opens
// for the whole call and closes in a `finally`; (4) folds every collected
// commit through `replayCommit`/`accumulateCochange` — an order-free
// operation by construction (D16), so the fact that this pass runs after
// (rather than during) the walk changes no model-visible quantity. What it
// trades away is peak memory: this holds the WHOLE gate-1-filtered commit
// list (lightweight — paths and shas, never blob content) for the range in
// memory at once, rather than a bounded few-hundred-commit slice. A key
// probed here once is a single read, never a re-parse (R4-I8 is untouched);
// a key resolved once (hit or fresh miss) is never re-probed within the same
// call, deduped by `refsByKey`.
//
// THE PENDING-KEY SET'S OWN SIZE IS NOT A NEW COST THIS DESIGN INTRODUCES.
// `refsByKey` holds at most one entry per DISTINCT admitted (sha, path)-
// derived key across the whole range — O(unique keys), never O(commits) —
// and any windowed design would need to retain that same roster too: a
// window only bounds how many commits are BUFFERED before a flush, not how
// many distinct keys the walk names overall, and a key probed in one window
// is still counted once in the roster a windowed design would carry forward
// to avoid re-probing it in a later window. Fetched CONTENT is the one
// quantity actually bounded here — `BLOB_FETCH_CHUNK_SHAS` below caps how
// many misses' bytes are held at once, through the single `BlobReader`
// opened for the whole call — while the commit list and the key roster
// themselves are read only, never blob content, and scale with the walked
// range regardless of whether the fetch itself is windowed.
//
// THE CLOCK COMES FROM `readHead`, NEVER FROM THE WALK (Step 1): the walk is
// `--no-merges`, so on a repository whose HEAD is a merge commit the walk's
// last record is neither HEAD's sha nor HEAD's timestamp, while §13.4 is
// categorical that the clock is HEAD's committer timestamp. `clockTs`/
// `clockIso` are the SAME `readHead` call's two representations — never
// independently re-derived from one another.
// -----------------------------------------------------------------------------

/** One admitted (sha, historicalPath) reference this walk named, deduped by its cache key — the unit the probe-then-fetch protocol resolves. */
interface AdmittedRef {
  sha: string;
  path: string;
  key: string;
  binding: RootsBinding;
}

/**
 * Chunk size for fetching cache MISSES through the walk's single open
 * `BlobReader` — matches `git-history.ts`'s own `<= 400`-sha per-request
 * bound (§13.2), so peak "fetched blob content held in memory at once" stays
 * bounded regardless of how many distinct misses a cold run accumulates. A
 * named constant, never a magic literal (T8 Step 1's own requirement).
 */
const BLOB_FETCH_CHUNK_SHAS = 400;

/**
 * §18.4's fixed trailing window (`v6-spec.md:687`) — "fixed" is the spec's
 * own word, so this is a literal constant, never a config key (R4-I13: R4
 * invents no config key).
 */
const AGENT_SHARE_WINDOW_DAYS = 120;

/** D12's periodic-update cadence for the >60s fetch progress line: an `onProgress` call every N misses processed, never on every single one (§20.1's per-blob budget — a callback per blob is the wrong order of overhead for a walk sized in the thousands). */
const PROGRESS_UPDATE_EVERY_BLOBS = 500;

/**
 * Resolve every distinct admitted reference to its `BlobRecord`: probe the
 * on-disk shard for each key first (a genuine cache hit costs one read and
 * nothing else); fetch only the misses, chunked, through `reader`; extract
 * and write-through each fetched miss exactly like `makeBlobRecordReader`'s
 * own miss path (the SAME private helpers — `extractAdmitted`,
 * `writeThroughRecord` — so a hit and a fresh extraction remain byte-
 * identical for the same (sha, path), R4-I3). `onParsed` is the same run
 * diagnostic `makeBlobRecordReader` exposes — fired once per genuine miss
 * that reaches extraction, never the source of D4's `parsed`/`mb` rosters
 * (those are read off `resolved` itself by the caller, per key). `onProgress`
 * is D12's own >60s/every-500 transport: one call up front carrying
 * `totalUncachedBlobs` (the count the command projects an ETA from, BEFORE
 * any fetching starts), then one call every `PROGRESS_UPDATE_EVERY_BLOBS`
 * misses processed, plus a final call so the command always learns the true
 * end count even when it does not land on a multiple of 500.
 */
async function resolveAdmittedRefs(
  cacheDir: string,
  config: RootsConfig,
  refs: ReadonlyMap<string, AdmittedRef>,
  reader: BlobReader,
  onParsed?: () => void,
  onProgress?: (info: HistoryProgressInfo) => void,
): Promise<Map<string, BlobRecord>> {
  const resolved = new Map<string, BlobRecord>();
  const misses: AdmittedRef[] = [];
  for (const ref of refs.values()) {
    const cached = parseStoredRecord(await readBlobRecord(cacheDir, ref.key), ref.key);
    if (cached) {
      resolved.set(
        ref.key,
        cached.skipped
          ? cached
          : { bytes: cached.bytes, skipped: false, scopes: cached.scopes.map((s) => sortOwnKeys(reattachGrammarConstants(s, ref.binding))) },
      );
    } else {
      misses.push(ref);
    }
  }

  onProgress?.({ phase: 'fetching', blobsParsed: 0, totalUncachedBlobs: misses.length });

  let processed = 0;
  for (let i = 0; i < misses.length; i += BLOB_FETCH_CHUNK_SHAS) {
    const chunk = misses.slice(i, i + BLOB_FETCH_CHUNK_SHAS);
    const bySha = new Map<string, Buffer>();
    await reader.read([...new Set(chunk.map((r) => r.sha))], (sha, content) => {
      bySha.set(sha, content);
    });
    for (const ref of chunk) {
      const content = bySha.get(ref.sha) ?? Buffer.alloc(0);
      const fresh = await extractAdmitted(ref.path, content, config, ref.binding);
      onParsed?.();
      processed++;
      if (processed % PROGRESS_UPDATE_EVERY_BLOBS === 0) {
        onProgress?.({ phase: 'fetching', blobsParsed: processed, totalUncachedBlobs: misses.length });
      }
      if (fresh.skipped) {
        await writeBlobRecord(cacheDir, ref.key, fresh);
        resolved.set(ref.key, fresh);
      } else {
        await writeBlobRecord(cacheDir, ref.key, writeThroughRecord(fresh));
        resolved.set(ref.key, fresh);
      }
    }
  }
  if (misses.length > 0 && processed % PROGRESS_UPDATE_EVERY_BLOBS !== 0) {
    onProgress?.({ phase: 'fetching', blobsParsed: processed, totalUncachedBlobs: misses.length });
  }

  return resolved;
}

/**
 * §18.4: `Σ base(agent-authored, stable_days < agentPromoteDays) / Σ base`
 * over the replay's own lifecycle population first seen inside the trailing
 * 120 days of `clockTs`. `base` is `weights.ts`'s own `baseWeightOfRow` —
 * never a second transcription of §9.1's formula. The population is every
 * FINISHED lifecycle row (scope- and file-level alike — `historyStats`'
 * own precedent for "a property of the whole history," never restricted to
 * one row level) whose `firstSeenTs` falls inside the window; `dirty` is
 * always `false` here — dirty-working-tree status is a LIVE-tree property
 * `w(s,q)`'s own degraded branch exists to protect an in-progress build
 * against, and has no bearing on this REPLAY-only diagnostic, which never
 * touches the working tree at all.
 *
 * An EMPTY population (nothing first seen in the window) is `null` — §18.4's
 * own "n/a" — never `0`: a division by a zero-sized population is a
 * different fact from "a non-empty population with no agent-authored
 * member," and `JSON.stringify(NaN)` silently emits `null` too, so an
 * unguarded `sum / total` would make the two indistinguishable (MR-29).
 */
function computeAgentShare(lifecycle: readonly LifecycleRow[], clockTs: number, config: RootsConfig): number | null {
  const windowStartTs = clockTs - AGENT_SHARE_WINDOW_DAYS * 86400;
  let numerator = 0;
  let denominator = 0;
  let populationCount = 0;
  for (const row of lifecycle) {
    if (row.firstSeenTs < windowStartTs) continue;
    populationCount++;
    const w = baseWeightOfRow(row, false, clockTs, config);
    denominator += w;
    if (row.authorKind === 'agent' && stableDaysOf(row, clockTs) < config.weights.agentPromoteDays) {
      numerator += w;
    }
  }
  if (populationCount === 0) return null;
  return denominator > 0 ? numerator / denominator : 0;
}


/** Every input `buildHistoryJoin` needs beyond `repoRoot`/`config`, injected by the command layer (`cli/roots.ts`) so the roots engine never reads a store directly (Task 1's seam). `full` mirrors `--full` (D2): forces a full walk and discards any state on disk, the determinism reference. */
export interface HistoryDeps {
  cacheDir: string;
  stateDir: string;
  ledger: readonly LedgerEntry[];
  dirtyPaths: ReadonlySet<string>;
  full?: boolean;
}

/**
 * Structured progress data only (D12) — counts and a phase tag, never
 * preformatted text: the engine stays `no-direct-console`, and the COMMAND
 * owns every rendered word. `totalUncachedBlobs` rides on the FIRST
 * `'fetching'`-phase call of a run (and on every subsequent one, for a
 * stateless reader) — the command needs it once, to decide whether the
 * projected fetch time clears D12's 60s threshold, before the periodic
 * `blobsParsed` updates that follow mean anything.
 */
export interface HistoryProgressInfo {
  phase: 'walking' | 'fetching' | 'replaying';
  commitsWalked?: number;
  blobsParsed?: number;
  totalUncachedBlobs?: number;
}

/**
 * The finished history join — every field's own source stated here, since
 * that is the contract a caller reads: `lifecycle`/`events`/
 * `aliases` are `finishReplay`'s finished products; `cochange` is the CUT
 * set (`finishCochange`'s `pairs`); `couplingByFile`/`couplingByModule` are
 * the REPO-GLOBAL projections (`finishCochange`'s own G.3 percentiles —
 * projecting them down to one partition's own file set is `runRootsIndex`'s
 * job, via `projectCouplingForPartition` below); `agentShare` is §18.4's
 * diagnostic; `historyStats` is D4's five history-derived integers;
 * `blobShas`/`parsedKeys` are the two rosters `historyStats.blobs`/`.parsed`
 * are computed FROM (returned rather than collapsed to their cardinalities,
 * so a consumer can ask per-sha/per-key membership questions no integer can
 * answer); `clockTs`/`clockIso` are `readHead`'s own two representations of
 * the SAME instant.
 */
export interface HistoryJoin {
  lifecycle: LifecycleRow[];
  events: ValueEvent[];
  aliases: Array<[string, string]>;
  cochange: CochangePair[];
  couplingByFile: Record<string, number>;
  couplingByModule: Record<string, number>;
  agentShare: number | null;
  historyStats: { commits: number; events: number; blobs: number; parsed: number; mb: number };
  blobShas: ReadonlySet<string>;
  parsedKeys: ReadonlyMap<string, number>;
  clockTs: number;
  clockIso: string | null;
}

/**
 * `history.*`'s walk-shaping fields, mapped to T2's `WalkOptions` — D3:
 * windowing (`history.full: false`, or `maxCommits > 0` even under a full
 * walk) makes the walked set a function of when the run happens;
 * `sinceMonths` is meaningful only under `history.full === false` (T2's own
 * field doc). `sinceSha`, when supplied, is D2's own resume anchor — the
 * caller (`buildHistoryJoin`) only ever passes one when `decideWalkMode` has
 * already returned `'resume'`, which `isWindowingActive` (above) has already
 * ruled out, so a `sinceSha` and a windowing field are never both set on the
 * same call (D3: windowing always forces `'full'`).
 */
function buildWalkOptions(config: RootsConfig, sinceSha?: string): WalkOptions {
  return {
    agentIdentities: config.history.agentIdentities,
    ...(sinceSha ? { sinceSha } : {}),
    ...(config.history.maxCommits > 0 ? { maxCommits: config.history.maxCommits } : {}),
    ...(config.history.full ? {} : { sinceMonths: config.history.windowMonths }),
  };
}

export async function buildHistoryJoin(
  repoRoot: string,
  config: RootsConfig,
  deps: HistoryDeps,
  onProgress?: (info: HistoryProgressInfo) => void,
): Promise<HistoryJoin | undefined> {
  const head = readHead(repoRoot);
  if (head.sha === null || head.committerTs === null) {
    debugWrite(`[roots-history] buildHistoryJoin: no usable HEAD for ${repoRoot} — degraded mode (no git repository, or no commits yet)`);
    return undefined;
  }
  if (isShallowRepository(repoRoot)) {
    debugWrite(`[roots-history] buildHistoryJoin: ${repoRoot} is a shallow clone — degraded mode (R4-I4)`);
    return undefined;
  }

  // D2's own walk decision, resolved against whatever replay state already
  // sits on disk. `resumeState` is `undefined` on a full walk (mode ===
  // 'full') AND on a resume verdict whose loaded rows failed the deep parse
  // (`parseResumeState`'s own belt-and-suspenders — R4-I10: degrade to a
  // full walk, never guess at a partial one) — `isResuming` is the single
  // flag every branch below reads instead of re-deriving that distinction.
  const { mode, state: rawState, inputsHash } = await resolveWalkMode(repoRoot, config, deps.stateDir, deps.full ?? false);
  const resumeState = mode === 'resume' && rawState ? parseResumeState(rawState) : undefined;
  const isResuming = resumeState !== undefined;

  const filters = makeRootsFileFilters(config);
  const replayThresholds: ReplayThresholds = {
    churnEarlyDays: config.history.churnEarlyDays,
    lifecycleFileMaxKb: config.history.lifecycleFileMaxKb,
    lifecycleMaxAppearances: config.history.lifecycleMaxAppearances,
  };
  const carriesRows = (p: string): boolean => carriesLifecycleRows(p, config);
  const replayState = isResuming
    ? deserializeReplayState(resumeState.replaySnapshot, replayThresholds, carriesRows)
    : createReplayState(replayThresholds, carriesRows);
  const cochangeThresholds: CochangeThresholds = { megaCommitFileCap: config.history.megaCommitFileCap };
  const cochangeState = isResuming ? deserializeCochangeState(resumeState.cochangeSnapshot, cochangeThresholds) : createCochangeState(cochangeThresholds);

  // The two rosters D4 needs are UNIONS across runs (D4's own definition —
  // "properties of the history", never of what this run did): seeded from
  // the loaded state's own rosters on a resume, empty on a full walk (D2's
  // discard rule — a full verdict starts every accumulator, roster included,
  // from empty). `baseCommitsAccumulated` is the ONE quantity neither roster
  // derives (no file records which commit shas were ever walked), so it is
  // its own persisted running total (`meta.json`'s `commitsAccumulated`).
  const blobShas = new Set<string>(isResuming ? resumeState.rosters.blobShas : []);
  const priorParsedKeys = isResuming ? resumeState.rosters.parsedKeys : new Map<string, number>();
  const baseCommitsAccumulated = isResuming ? resumeState.rosters.commitsAccumulated : 0;

  const refsByKey = new Map<string, AdmittedRef>();
  const walkedCommits: HistoryCommitRecord[] = [];
  let commitsWalked = 0;

  const walkOptions = buildWalkOptions(config, isResuming ? resumeState.lastIndexedSha : undefined);

  const reader = openBlobReader(repoRoot);
  try {
    try {
      await walkHistory(repoRoot, walkOptions, (commit) => {
        commitsWalked++;
        // D17 gate 1, applied HERE, ONCE — on the record's post-image path
        // (`newPath ?? path`), before the replay, the co-change accumulator
        // or the blob roster below ever see this commit's files.
        const filteredFiles = commit.files.filter((f) => filters.forMarkers(f.newPath ?? f.path));
        walkedCommits.push({ ...commit, files: filteredFiles });

        for (const record of filteredFiles) {
          if (record.status === 'D' || record.status === 'T') continue; // never blob-resolved (D4, D17)
          const candidates: Array<[string | null, string]> = [
            [record.preSha, record.path],
            [record.postSha, record.newPath ?? record.path],
          ];
          for (const [sha, historicalPath] of candidates) {
            if (sha === null) continue;
            // D4: every RESOLVED sha of a gate-1-surviving A/M/R/C record,
            // whether or not that record's path is one R4 extracts. Adding to
            // the (possibly-seeded) `blobShas` set is what makes this a UNION
            // across a resume rather than a fresh roster.
            blobShas.add(sha);
            const gate2 = resolveGate2(historicalPath, config);
            if (!gate2.admitted) continue; // never keyed, never probed, never fetched, never cached (D11, D17, D4)
            const key = blobCacheKey(sha, EXTRACTOR_VERSION, gate2.bindingHashValue);
            if (!refsByKey.has(key)) refsByKey.set(key, { sha, path: historicalPath, key, binding: gate2.binding });
          }
        }
      });
    } catch (e) {
      if (e instanceof GitLogError) {
        debugWrite(`[roots-history] buildHistoryJoin: git log failed for ${repoRoot}: ${e.message} — degraded mode (R4-I4)`);
        return undefined;
      }
      throw e;
    }

    onProgress?.({ phase: 'walking', commitsWalked });

    let blobsParsedThisRun = 0;
    const resolvedThisRun = await resolveAdmittedRefs(
      deps.cacheDir,
      config,
      refsByKey,
      reader,
      () => {
        blobsParsedThisRun++;
      },
      onProgress,
    );
    onProgress?.({ phase: 'fetching', blobsParsed: blobsParsedThisRun });

    const lookup: BlobRecordLookup = {
      get(sha: string, historicalPath: string): BlobRecord | undefined {
        const gate2 = resolveGate2(historicalPath, config);
        if (!gate2.admitted) return { bytes: 0, skipped: true, reason: gate2.reason };
        const key = blobCacheKey(sha, EXTRACTOR_VERSION, gate2.bindingHashValue);
        return resolvedThisRun.get(key);
      },
    };

    // Order within the collected commit set is irrelevant by construction
    // (D16): both `replayCommit` and `accumulateCochange` are set functions
    // over per-record/per-commit values, with nothing carried between calls
    // that depends on the order those calls arrive in. On a resume,
    // `replayState`/`cochangeState` are already seeded with the loaded
    // state's own rows, so folding only THIS run's newly-walked commits into
    // them is exactly the union D16/R4-I2 require — never a second pass over
    // commits the previous run already applied.
    for (const commit of walkedCommits) {
      replayCommit(replayState, commit, lookup);
      accumulateCochange(cochangeState, commit);
    }
    onProgress?.({ phase: 'replaying', commitsWalked });

    const { lifecycle, events, aliases, events_n } = finishReplay(replayState);
    const aliasLookup = new Map(aliases);
    const resolvePath = (p: string): string => aliasLookup.get(p) ?? p;
    const { pairs: cochange, couplingByFile, couplingByModule } = finishCochange(cochangeState, config, resolvePath);

    // The "parsed" roster is likewise a UNION: every key this run resolved
    // (hit or fresh miss) folded onto whatever the loaded state already
    // counted. D4: "parsed" = distinct non-skipped cache keys, over the
    // union — never reset to what this one run happened to touch.
    const parsedKeys = new Map<string, number>(priorParsedKeys);
    for (const [key, record] of resolvedThisRun) {
      if (!record.skipped) parsedKeys.set(key, record.bytes); // D4: "parsed" is a cache-KEY roster, and only over NON-skipped records
    }
    let totalBytes = 0;
    for (const bytes of parsedKeys.values()) totalBytes += bytes;

    // D4: `commits` is a property of the WHOLE history, cache/resume
    // independent — the running total, never this run's own delta (which is
    // what `commitsWalked`, above, stays for the stderr run summary,
    // Step 4).
    const commitsAccumulated = baseCommitsAccumulated + commitsWalked;
    const historyStats = {
      commits: commitsAccumulated,
      events: events_n,
      blobs: blobShas.size,
      parsed: parsedKeys.size,
      mb: Math.floor(totalBytes / (1024 * 1024)),
    };

    const agentShare = computeAgentShare(lifecycle, head.committerTs, config);

    // Persist the new state as one set (D15): the five accumulators first,
    // `meta.json` last — `writeHistoryState`'s own documented write order —
    // carrying HEAD's own sha as `lastIndexedSha`. A resumed walk that
    // produced a state whose `lastIndexedSha` were anything but HEAD would be
    // a bug, not a fallback: both a full walk and a resume walk the range
    // through to HEAD by construction (a resume walks `sinceSha..HEAD`), so
    // `head.sha` is the only value ever written here, on either path.
    const stateEpoch = deriveStateEpoch(HISTORY_STATE_SCHEMA_VERSION, inputsHash, head.sha);
    const { lifecycle: rawLifecycle, events: rawEvents, aliases: rawAliases } = serializeReplayState(replayState);
    const { pairs: rawPairs, fileCommits: rawFileCommits } = serializeCochangeState(cochangeState);
    const meta: HistoryStateMeta = {
      stateSchemaVersion: HISTORY_STATE_SCHEMA_VERSION,
      stateEpoch,
      inputsHash,
      lastIndexedSha: head.sha,
      blobShas: [...blobShas].sort(),
      parsedKeys: [...parsedKeys.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      commitsAccumulated,
    };
    await writeHistoryState(deps.stateDir, {
      meta,
      lifecycle: rawLifecycle,
      events: rawEvents,
      aliases: rawAliases,
      cochangeRaw: [...rawPairs, ...rawFileCommits],
      // The finished CUT, not a raw accumulator (D1's own sort-order comment
      // on `cochange.jsonl`) — informational only; a resume reconstructs the
      // finished cut fresh from `cochange-raw.jsonl` via `finishCochange`
      // every time, never reads this field back.
      cochange,
    });

    return {
      lifecycle,
      events,
      aliases,
      cochange,
      couplingByFile,
      couplingByModule,
      agentShare,
      historyStats,
      blobShas,
      parsedKeys,
      clockTs: head.committerTs,
      clockIso: head.committerIso,
    };
  } finally {
    reader.close();
  }
}

/**
 * Project the repo-global `couplingByFile`/`couplingByModule` (co-change
 * itself stays repo-global, spec `:622` — only the percentiles are projected
 * per partition, Appendix D `:892`) down to one partition's own file set:
 * `couplingByFile` keeps only entries whose file belongs to `partitionFiles`;
 * `couplingByModule` keeps only entries whose module directory is the
 * `dirnameOf` of at least one of this partition's own files — the same
 * repo-global, partition-free grouping `history-cochange.ts`'s own
 * `computeModuleCoupling` used to BUILD `couplingByModule` in the first
 * place, so the membership test here matches how each entry's key was
 * formed. Lives here (not `mine.ts`) — `mine()` never sees a `HistoryJoin`
 * at all.
 */
export function projectCouplingForPartition(
  join: Pick<HistoryJoin, 'couplingByFile' | 'couplingByModule'>,
  partitionFiles: ReadonlySet<string>,
): { couplingByFile: Record<string, number>; couplingByModule: Record<string, number> } {
  const couplingByFile: Record<string, number> = {};
  for (const [file, pct] of Object.entries(join.couplingByFile)) {
    if (partitionFiles.has(file)) couplingByFile[file] = pct;
  }
  const moduleDirs = new Set<string>();
  for (const file of partitionFiles) moduleDirs.add(dirnameOf(file));
  const couplingByModule: Record<string, number> = {};
  for (const [mod, pct] of Object.entries(join.couplingByModule)) {
    if (moduleDirs.has(mod)) couplingByModule[mod] = pct;
  }
  return { couplingByFile, couplingByModule };
}
