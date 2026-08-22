/**
 * source/cli/src/roots/history-replay.ts — R4 Task 5: the lifecycle/value-event/
 * alias REPLAY. Folds a walked commit's file records into per-scope lifecycle
 * rows, value-tuple change events, and raw rename edges — spec §13.3
 * (`v6-spec.md:609-615`), §6.5 change signature (`:249-252`), §6.4 ordinals
 * (`:244-247`), §9.1's lifecycle-row fields (`:368-379`); design §12
 * (`integration-design.md:439-467`); D5, D6, D16, D17.
 *
 * THE FOLD IS A FUNCTION OF THE COMMIT *SET*, NEVER OF ARRIVAL ORDER (D16).
 * There is no `prevState[path]` map carried between commits — a running
 * previous-value map is not merely order-sensitive, it is WRONG on any
 * branched history (two commits on divergent branches touching the same
 * file; whichever a walk hands over second gets compared against the wrong
 * parent). Each `HistoryFileRecord` carries its OWN pre-image blob sha
 * (`preSha` — by definition the blob in that commit's own parent), so every
 * comparison this module makes is per record, with nothing carried across
 * `replayCommit` calls except the six-file accumulator itself (`ReplayState`).
 * Every field `finishReplay` produces is therefore a SET function (min/max/
 * count/greatest-tie-break) over the row's touches — `replayCommit` may be
 * handed the same commits in any order and `finishReplay` returns
 * byte-identical output; that is what makes a resumed index equal a full one
 * (R4-I2), since a resume range is a set difference, never a suffix. R4-I2
 * is why `mergeRowGroup`'s `modifications` at alias-merge time is a PURE
 * FUNCTION of each source row's own already-persisted `modifications` scalar,
 * never a union of real per-run touching-commit sha sets: a real union is
 * exact within one run but is NOT the same function of the commit set when
 * split at different points (the loaded half of a resumed row carries no
 * per-run sha identities to union with), which would make R4-I2 itself false
 * for exactly the alias-merge case this module exists to get right. See that
 * function's own doc for the exact tension and the bounded overcount this
 * trades for consistency.
 *
 * TWO PUBLIC OPERATIONS PLUS THE STATE THEY SHARE. `replayCommit(state,
 * commit, records)` folds one commit's file records into `state`, mutating
 * it in place — synchronous, no I/O, because every blob this commit touches
 * must already be resolved in `records` (T8's global, deduped probe-then-
 * fetch pass over the whole walked range — `history.ts`'s own
 * `resolveAdmittedRefs`; `BlobRecordLookup` is a plain synchronous lookup,
 * never a fetcher). `finishReplay(state)` derives the four finished products —
 * alias-resolved, cap-demoted, totally sorted — WITHOUT mutating `state`,
 * so it may be called more than once on the same state (acceptance: byte-
 * identical on repeat). `createReplayState`/`serializeReplayState`/
 * `deserializeReplayState` are this module's own necessary extension of that
 * surface: the plan's Interfaces block fixes `replayCommit`/`finishReplay`'s
 * signatures and the four row/event/edge/result shapes, but `ReplayState`
 * has to be constructible and round-trippable through `io/roots-history-
 * store.ts`'s six-file set (D1) for that to mean anything, and nothing else
 * names how. `ReplayState` carries the three `history.*` thresholds
 * (`churnEarlyDays`, `lifecycleFileMaxKb`, `lifecycleMaxAppearances`) it
 * needs at fold- and finish-time, because `replayCommit`/`finishReplay`'s own
 * signatures — fixed by the plan — take no config parameter.
 *
 * THE APPEARANCE COUNTER IS THE FILE-LEVEL ROW'S OWN TOUCH COUNT, not a
 * second structure. D1 describes `meta.json` as carrying "per-file walk-
 * appearance counters" alongside the six-file state, but nothing constrains
 * how THIS module tracks the count before the index pipeline ever assembles
 * `meta.json` — and the count `lifecycleMaxAppearances` needs ("appearing in
 * more than N commits") is exactly what a file-level row's own touch total
 * (`modifications + 1`) already is: a persisted, resume-safe running total,
 * incremented on every A/M/D/R/C/T touch alike (Step 2 below). THE DECISION
 * IS PER RAW PATH, THE DROP IS PER FINAL KEY: the cap is DECIDED against each
 * RAW row's own count, at its own pre-alias path, BEFORE the alias closure
 * ever pools a renamed file's touches onto one merged row — Step 4(a)'s
 * "per-path appearance counter" is a counter per LITERAL path, not per
 * renamed-file identity, so a file that followed a rename starts counting
 * again at its new name. But the DROP itself is applied AFTER the alias
 * rewrite and merge, at each row's FINAL key: every raw path that individually
 * crossed the cap is mapped through the closure to its final path
 * (`demotedFinalPaths`), and a merged SCOPE row is dropped IN FULL when its
 * own final owner path is among those — never partially, and never keyed on
 * which specific raw contributor crossed the cap. This is what keeps an alias
 * merge from leaving a stale, partially-updated scope row alive at a demoted
 * path (R4 verify pass V-2): deciding the cap per raw path is right, but
 * applying the drop BEFORE the merge — on each row's own raw key — lets one
 * un-demoted raw contributor's row survive the merge unmerged-away while its
 * demoted alias-sibling is dropped, so the SURVIVING merged row at the final
 * key still reports that un-demoted contributor's OWN, stale `lastModifiedTs`
 * instead of the file's true latest touch. Deciding-per-raw-path-but-dropping-
 * per-final-key closes that: once ANY raw contributor folded into a final
 * identity crossed the cap on its own raw count, the WHOLE merged scope row
 * at that final key is gone, and only the file-level row — which always
 * survives, carrying the full pooled total — remains to represent it (so
 * T7's `rowFor(skeyR, relPath)` two-step lookup finds the file-level fallback
 * it is supposed to, not a scope row keyed to a demoted path's old touches).
 * The file-level row's own MERGED total (after the alias closure, Step 5)
 * still accumulates every raw path's touches — a hot file's full history is
 * never lost — but that merged total is never itself the quantity COMPARED
 * against `lifecycleMaxAppearances`; only the raw, per-path counts feeding
 * into the decision are.
 *
 * THE SCOPE-TOUCH RULE. A record touches a scope row exactly when the row's
 * scope key is among the record's resolved POST-image scope keys — so a
 * record whose post-image still carries a scope touches that scope's row
 * whether or not the value signature changed, and a `T`/`D` record (which
 * resolves no post-image scope set at all — `D`'s postSha is null, and a
 * `T` is deliberately never blob-resolved even though its own record shape
 * carries two non-null shas, see `HistoryFileRecord.status`'s own doc)
 * touches file-level rows only. `scopeKey` is `${kind}#${qualifiedName}` —
 * the ordinal already lives inside `qualifiedName` (`extract.ts`'s own
 * `finalizeUnits`... no: the ordinal is folded in by `extractUnits` itself,
 * the SAME phase-1 function historical blobs run through, so two same-named
 * overloads already carry distinct `qualifiedName`s at the raw-extraction
 * stage — R4-I7's one key space needs nothing extra here).
 *
 * D17 GATE 2 APPLIES TO EVERY RECORD STATUS, `D`/`T` INCLUDED — NEVER
 * RE-DERIVED. This module never calls `resolveGate2`/`forParsing`/
 * `getGrammarForExtension` itself — that would be a second implementation of
 * a gate `history.ts` already owns. For `A`/`M`/`R`/`C` it reads the
 * post-image `BlobRecord`'s own skip reason: `'no-grammar'`/`'excluded'`
 * (never fetched at all, D4/D11) means NO lifecycle row of either level for
 * that record — not even file-level, because a path with no registered
 * grammar or excluded from parsing can never carry a scope, and a file-level
 * row for it would feed nothing while quietly making a lifecycle table's own
 * clock equal HEAD's timestamp on every golden that carries only such paths
 * (the defect an oversize/unparseable clause would hide). `'oversize'`/
 * `'unparseable'` is the opposite case: the path cleared both gates, so it
 * keeps its file-level row with no scope processing (nothing was extracted to
 * process). `D` and `T` records never resolve a `BlobRecord` at all (a
 * delete's `postSha` is null; a typechange is deliberately never
 * blob-resolved), so they cannot read gate 2's outcome off a record's skip
 * reason the way the other four statuses do — but the rule is categorical,
 * not conditioned on a blob having been fetched: a path the walk sees but
 * gate 2 rejects gets no lifecycle row regardless of which status touched it.
 * `D`/`T` therefore answer gate 2 the only way they can, from the path alone,
 * through `history.ts`'s own exported `carriesLifecycleRows` (`ReplayState
 * .carriesLifecycleRows` below) — the same predicate `resolveGate2` computes,
 * reused rather than re-implemented (R4-I14). Gate 1 (`forMarkers`) is never
 * this module's concern at all — a record failing it never reaches
 * `replayCommit` (T8's own filtering, upstream of the fold).
 *
 * `history.lifecycleFileMaxKb` IS A PER-RECORD, IMMEDIATE GATE, unlike
 * `lifecycleMaxAppearances`. A blob's byte size is knowable the moment its
 * `BlobScopeRecord` is in hand and does not need retroactive, whole-history
 * knowledge the way an appearance COUNT does (a file's size at commit N does
 * not depend on commits N+1..HEAD) — so it is checked once per record,
 * immediately, the same shape as the oversize/unparseable skip it sits
 * beside logically: file-level row kept, no scope processing.
 *
 * DAYS VS. SECONDS. Every timestamp this module touches (`HistoryCommitRecord
 * .committerTs`, and therefore every `LifecycleRow`/`ValueEvent` timestamp
 * field) is epoch SECONDS. `history.churnEarlyDays` is a day count. Comparing
 * them without converting is the kind of defect that only ever shows up as
 * "every scope looks like it churned early" — `churnedEarly`'s own derivation
 * below multiplies the threshold by `SECONDS_PER_DAY` before comparing.
 */

import { debugWrite } from '../utils/debug-log.js';
import { hashString } from '../io/hash.js';
import { nameShape } from './enumerate.js';
import type { HistoryCommitRecord, HistoryFileRecord } from '../utils/git-history.js';
import type { BlobRecord, StoredRawScope } from './history.js';

const SECONDS_PER_DAY = 86400;

// -----------------------------------------------------------------------------
// Interfaces produced
// -----------------------------------------------------------------------------

export interface LifecycleRow {
  // A SCOPE-level row's key is `skeyR` — `relPath#kind#qualifiedName` (D6). A FILE-level row's key
  // is the bare `relPath`, with no `#` component at all, which is what makes T7's
  // `LifecycleIndex.rowFor(skeyR, relPath)` a two-step lookup in one table (scope key first, path
  // second) rather than two tables. The two key spaces are therefore DISJOINT and `key` alone is
  // already a total sort key; `lifecycle.jsonl` still sorts by `(key, level)` (T1) so the two
  // levels group readably and the order is stated rather than incidental, never because `key`
  // needed a tie-break.
  key: string;
  level: 'scope' | 'file';
  firstSeenTs: number; // min touch ts
  // Second-smallest DISTINCT touch ts, or null when the scope has been touched once. Carried as a
  // field rather than folded into `churnedEarly` because the persisted row IS the accumulator (D1):
  // a later run can deliver a commit older than everything already recorded, which moves both the
  // birthday and the first modification at once, and a stored boolean could not be recomputed.
  firstModifiedTs: number | null;
  lastModifiedTs: number; // max touch ts
  // Distinct touching commits, minus the introduction, AT THIS ROW'S OWN,
  // un-merged key — "distinct" meaning by sha: `applyTouch` folds each row
  // over a per-row Set<sha> (`ReplayState.touchedBy`) so the SAME commit
  // touching the SAME row twice in one run (a re-fed record, or two of a
  // commit's own file records resolving to one row) contributes once. That
  // per-row dedup is exact and identical between a full run and a resumed one
  // (a resume never re-feeds an already-indexed commit), so it costs R4-I2
  // nothing.
  //
  // AT ALIAS-MERGE TIME (`mergeRowGroup`), the count is instead a SUM of each
  // source row's own `modifications + 1`, minus one — NOT a union of real
  // touching-commit sha sets — because a real union is exact only within a
  // single run and DIVERGES between a full fold and a split-and-resumed one
  // whenever two rows that later alias-merge shared a touching commit before
  // the split point (R4 verify pass V-1): the persisted `Set<sha>` a real
  // union would need has no room in this fixed field list (D1), so a resumed
  // row's loaded half cannot be unioned sha-for-sha with anything. A commit
  // that touched two live paths later merged by a rename is therefore counted
  // ONCE PER PRE-MERGE PATH, not once — a stated, deliberate deviation from
  // the plan's "keyed by sha, so a commit folded twice cannot double-count"
  // parenthetical, chosen because R4-I2 (a resumed index equals a full one,
  // byte-for-byte) is the invariant Task 5 is named against, not the
  // parenthetical's rationale. See `mergeRowGroup`'s own doc for the exact
  // tension and the maintainer-level fix (persisting a real per-row
  // `Set<sha>`, a `LifecycleRow` schema change) that would give both
  // properties — exactness and consistency — at once.
  modifications: number;
  churnedEarly: boolean; // DERIVED at finishReplay: firstModifiedTs - firstSeenTs <= history.churnEarlyDays (days, not seconds)
  fixTouches: number;
  authorKind: 'human' | 'agent'; // kind of the touch with the greatest (ts, sha) — G.2
  lastTouchSha: string; // that touch's sha; the tie-break `authorKind` needs across runs
  lastHumanCommitTs: number | null; // max ts over human touches
}

/**
 * D5's raw value tuple — the seven ingredients Step 3 names, never a
 * per-surface derived value: `nameShape(name)`, first-statement type, return
 * shape (the last return's expression type, or `null` when the body has no
 * return statement — `RawScope.lastReturnExprType` already encodes `'bare'`
 * for a valueless return, so `null` here means "no return at all", not "a
 * bare return"), the sorted decorator/supertype/node-type/callee-text lists.
 * Persisted on the event itself (D5) so a vocabulary change never invalidates
 * the event log; only `valueSignature` below reduces it to a comparable hash,
 * and that hash is never itself stored.
 */
export interface ValueTuple {
  nameShape: string;
  firstStatementType: string | null;
  returnShape: string | null;
  decorators: string[];
  supertypes: string[];
  nodeTypesSeen: string[];
  calleeTexts: string[];
}

// `sha` is the commit the event came from. It is not a spec field; it is the tie-break that makes
// `(ts, key, kind, sha)` a TOTAL order **on the raw events** — the ones `events.jsonl` persists,
// whose `key` still carries the pre-rewrite path — without which two commits at the same second
// could write the event file in either order and break byte-identity (D5, D16).
// The qualifier is not decoration. AFTER `finishReplay` rewrites each event's path component
// through the alias closure, the tuple is no longer total: two distinct live paths
// whose closures land on the same final path, both touched in one commit, produce two events
// identical in all four fields. Rows are explicitly MERGED on that collision; events explicitly
// are not. That is harmless in R4 — nothing serializes the finished event list and
// `historyStats.events` is a count of the raw ones (D4) — so the *semantic* question, whether such
// events should merge the way rows do, is recorded as **R6 debt**, to be answered when R6 first
// reads a finished event. R4 meanwhile keeps the returned ORDER deterministic by breaking such
// ties on the pre-rewrite key, which is all byte-identity needs and decides nothing R6
// has to live with.
export interface ValueEvent {
  key: string;
  ts: number;
  kind: 'introduction' | 'change';
  value: ValueTuple;
  authorHash: string;
  authorKind: 'human' | 'agent';
  sha: string;
}

// One rename edge as the walk recorded it. Edges are accumulated raw and the chain is compressed at
// `finishReplay` (D1) — compressing during the walk would make the result depend on arrival order.
export interface AliasEdge {
  from: string;
  to: string;
  ts: number;
  sha: string;
}

// `events_n` is NOT `events.length`, and that is why it is a field rather than a derivation: it is
// the **raw** count the fold emitted, before the appearance-cap demotion removed a subset,
// and it is what `historyStats.events` accumulates (D4). `events` is the demoted, rewritten,
// sorted list. On a repository with a file touched in more than `lifecycleMaxAppearances` commits
// the two differ, by design.
export interface ReplayResult {
  lifecycle: LifecycleRow[];
  events: ValueEvent[];
  aliases: Array<[string, string]>;
  events_n: number;
}

// `records` resolves BOTH shas of every file record — the pre-image blob as well as the post-image
// one — because a change is `signature(postSha) != signature(preSha)` (D16). Order-free: calling
// this over the same commits in any order leaves `state` equivalent.
//
// `BlobRecordLookup` is keyed on **`(sha, relPath)`, never on `sha` alone**, and the shape is
// declared here because nothing else in the plan fixes it. Two reasons, either sufficient: a blob
// record depends on the path's grammar, not only on the content (`history.ts`'s
// `makeBlobRecordReader` returns `(sha, relPath, content) => …`, and one sha routinely reaches two
// paths under two grammars — a `.ts`/`.py` stub pair); and an `R`/`C` record's
// two shas sit at two different paths, the pre-image at `path` and the post-image at `newPath`
// (T8 Step 1), so a sha-keyed lookup could not even express the rename case. Synchronous — every
// blob a commit's records could need must already be resolved before `replayCommit` is called
// (T8's global, deduped probe-then-fetch pass over the whole walked range); this module fetches
// nothing itself.
export interface BlobRecordLookup {
  get(sha: string, relPath: string): BlobRecord | undefined;
}

// -----------------------------------------------------------------------------
// ReplayState — this module's own accumulator, constructible/serializable so
// acceptance tests (and the index command, once it wires this in) can round-trip it through
// `io/roots-history-store.ts`'s six-file set.
// -----------------------------------------------------------------------------

/** The three `history.*` thresholds the fold and the finish both need, threaded once at construction since neither public function takes a config parameter. */
export interface ReplayThresholds {
  churnEarlyDays: number;
  lifecycleFileMaxKb: number;
  lifecycleMaxAppearances: number;
}

/**
 * The live accumulator `replayCommit` mutates. `rows` is keyed by each row's
 * OWN (pre-alias-rewrite) `key` — file-level rows and scope-level rows share
 * one map since their key spaces are disjoint (no `#` vs. always one). `events`
 * and `aliasEdges` are raw, unsorted, unrewritten — exactly the shape D1 says
 * `events.jsonl`/`aliases.jsonl` persist. Nothing here is itself sorted; sort
 * order is `finishReplay`'s job (for its own returned products) and the
 * caller's job (for persisting the raw accumulators — `serializeReplayState`
 * below applies `io/roots-history-store.ts`'s own documented per-file order).
 * `touchedBy` is `rows`' own shadow: the per-row Set<sha> `applyTouch` guards
 * its OWN re-fold dedup with (a commit already recorded against this row THIS
 * run is a no-op, not a second touch). `mergeRowGroup` deliberately does NOT
 * consult it (R4-I2 — that function's own doc explains why a real union would
 * make a resumed fold diverge from a full one). `touchedBy` never survives
 * past one run's own fold (`deserializeReplayState` always starts it empty)
 * and is never persisted itself (`LifecycleRow.modifications`'s own doc, above,
 * explains why). `carriesLifecycleRows` is D17 gate 2's
 * path-only predicate (`history.ts`'s own export), threaded through for the
 * `D`/`T` touch, which never resolves a `BlobRecord` to read the gate's
 * outcome off.
 */
export interface ReplayState {
  rows: Map<string, LifecycleRow>;
  touchedBy: Map<string, Set<string>>;
  events: ValueEvent[];
  aliasEdges: AliasEdge[];
  thresholds: ReplayThresholds;
  carriesLifecycleRows: (relPath: string) => boolean;
}

export function createReplayState(thresholds: ReplayThresholds, carriesLifecycleRows: (relPath: string) => boolean): ReplayState {
  return { rows: new Map(), touchedBy: new Map(), events: [], aliasEdges: [], thresholds, carriesLifecycleRows };
}

/** The three raw accumulators in `io/roots-history-store.ts`'s own documented sort order — the shape a caller persists into `lifecycle.jsonl`/`events.jsonl`/`aliases.jsonl`. */
export interface ReplayStateSnapshot {
  lifecycle: LifecycleRow[];
  events: ValueEvent[];
  aliases: AliasEdge[];
}

/**
 * The one 3-way ascending string comparator every sort in this module routes
 * through — key, level, kind, sha, from, to alike — rather than each call
 * site re-writing its own `a < b ? -1 : a > b ? 1 : 0`. Sharing ONE
 * implementation is not merely tidier: it is what a real bug in the
 * comparison direction cannot hide from, since every field this module ever
 * sorts (across both the raw accumulators and the finished output) exercises
 * this same location.
 */
function compareStrAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `(key, level)` — `lifecycle.jsonl`'s own order (`roots-history-store.ts`'s
 * header) and the finished `ReplayResult.lifecycle`'s order (Step 5) are the
 * SAME comparison over the SAME two fields; one function serves both, since
 * `key`'s own disjoint scope/file key spaces make it already total (`level`
 * is a stated, never load-bearing, tie-break either way).
 */
function compareRowKeyLevel(a: LifecycleRow, b: LifecycleRow): number {
  const keyCmp = compareStrAsc(a.key, b.key);
  if (keyCmp !== 0) return keyCmp;
  /* v8 ignore next -- every real caller sorts the VALUES of a `Map<string, LifecycleRow>` keyed by `.key` itself (`state.rows`, `merged` in `finishReplay`), so two distinct elements sharing a `key` is structurally impossible; `level` stays in the comparator only to keep the stated `(key, level)` order explicit. */
  return compareStrAsc(a.level, b.level);
}

/**
 * `(ts, key, kind, sha)` — `events.jsonl`'s raw order and the finished
 * `ReplayResult.events`' order (Step 5) are the SAME four-field comparison;
 * only WHICH `key` each event carries differs (pre- vs. post-alias-rewrite),
 * which is the caller's concern, not this comparator's.
 */
function compareEventTuple(a: ValueEvent, b: ValueEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const keyCmp = compareStrAsc(a.key, b.key);
  if (keyCmp !== 0) return keyCmp;
  const kindCmp = compareStrAsc(a.kind, b.kind);
  if (kindCmp !== 0) return kindCmp;
  return compareStrAsc(a.sha, b.sha);
}

/** `aliases.jsonl` by `(ts, sha, from)` — see `roots-history-store.ts`'s own header. */
function compareRawEdges(a: AliasEdge, b: AliasEdge): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const shaCmp = compareStrAsc(a.sha, b.sha);
  if (shaCmp !== 0) return shaCmp;
  return compareStrAsc(a.from, b.from);
}

/** Snapshot `state`'s three raw accumulators for persistence, in `io/roots-history-store.ts`'s own documented per-file order. Read-only: `state` is untouched. */
export function serializeReplayState(state: ReplayState): ReplayStateSnapshot {
  return {
    lifecycle: [...state.rows.values()].sort(compareRowKeyLevel),
    events: [...state.events].sort(compareEventTuple),
    aliases: [...state.aliasEdges].sort(compareRawEdges),
  };
}

/**
 * Reconstruct a `ReplayState` from a loaded snapshot plus the run's own
 * thresholds and gate-2 predicate — both are config, not accumulated data, so
 * they are supplied fresh on every load (resumed or not) rather than
 * round-tripped through the snapshot. `touchedBy` starts empty: a loaded
 * row's own past touches are already folded into its scalar fields and
 * cannot be replayed a second time by a normal resume (which only ever feeds
 * commits the previous run never saw), so there is nothing to reconstruct.
 */
export function deserializeReplayState(snapshot: ReplayStateSnapshot, thresholds: ReplayThresholds, carriesLifecycleRows: (relPath: string) => boolean): ReplayState {
  return {
    rows: new Map(snapshot.lifecycle.map((row) => [row.key, row])),
    touchedBy: new Map(),
    events: [...snapshot.events],
    aliasEdges: [...snapshot.aliases],
    thresholds,
    carriesLifecycleRows,
  };
}

// -----------------------------------------------------------------------------
// Step 2/3/4: touching a row, the value tuple, and per-record event emission
// -----------------------------------------------------------------------------

/**
 * Online two-smallest-DISTINCT-value tracker, order-free by construction: feeding the same set of
 * values through this function in any order (split across any number of calls) produces the same
 * `[min1, min2]` pair. `min1` is `firstSeenTs`; `min2` is `firstModifiedTs`. Used both per-touch
 * (`applyTouch`, feeding one value at a time) and at alias-merge time (`mergeRowGroup`, feeding
 * each source row's own `[firstSeenTs, firstModifiedTs]` pair — valid because the merged set's two
 * smallest distinct values must be drawn from the union of each source's own two smallest, no
 * source's third-smallest-or-later value can ever unseat them).
 */
function feedDistinctMin(min1: number | null, min2: number | null, v: number): [number, number | null] {
  if (min1 === null) return [v, min2];
  if (v === min1) return [min1, min2];
  if (v < min1) return [v, min1];
  if (min2 === null) return [min1, v];
  if (v === min2) return [min1, min2];
  if (v < min2) return [min1, v];
  return [min1, min2];
}

/**
 * Apply one touch (a commit's own `ts`/`sha`/`authorKind`/`isFix`) to the row keyed `key`,
 * creating it on the row's first-ever touch. **Keyed by sha first**: if this exact commit has
 * already touched this exact row THIS run (`state.touchedBy`), the call is a no-op — a record
 * folded twice (or two of one commit's own file records resolving to the same row) must not move
 * any field a second time, `modifications` included, which is what makes "distinct touching
 * commits" true rather than aspirational. Every field past that guard is the set function Step 2
 * names: `firstSeenTs`/`firstModifiedTs` via `feedDistinctMin`; `lastModifiedTs`/`lastTouchSha`/
 * `authorKind` via the greatest-`(ts, sha)` comparator (G.2) — the winning touch's `ts` is always
 * the row's max `ts`, since any smaller `ts` loses the comparison outright regardless of `sha`;
 * `modifications` as "one touch creates the row at 0, every DISTINCT touch after increments by 1";
 * `fixTouches` a plain running sum, no subtraction; `lastHumanCommitTs` a plain max over
 * human-authored touches.
 */
function applyTouch(state: ReplayState, key: string, level: 'scope' | 'file', commit: HistoryCommitRecord): void {
  const { committerTs: ts, sha, authorKind, isFix } = commit;

  const shas = state.touchedBy.get(key);
  if (shas) {
    if (shas.has(sha)) return; // this exact commit already touched this row this run — idempotent, not a second touch
    shas.add(sha);
  } else {
    state.touchedBy.set(key, new Set([sha]));
  }

  const existing = state.rows.get(key);

  if (!existing) {
    state.rows.set(key, {
      key,
      level,
      firstSeenTs: ts,
      firstModifiedTs: null,
      lastModifiedTs: ts,
      modifications: 0,
      churnedEarly: false, // derived at finishReplay
      fixTouches: isFix ? 1 : 0,
      authorKind,
      lastTouchSha: sha,
      lastHumanCommitTs: authorKind === 'human' ? ts : null,
    });
    return;
  }

  const [firstSeenTs, firstModifiedTs] = feedDistinctMin(existing.firstSeenTs, existing.firstModifiedTs, ts);
  const winnerIsNew = ts > existing.lastModifiedTs || (ts === existing.lastModifiedTs && sha > existing.lastTouchSha);
  state.rows.set(key, {
    key,
    level,
    firstSeenTs,
    firstModifiedTs,
    lastModifiedTs: Math.max(existing.lastModifiedTs, ts),
    modifications: existing.modifications + 1,
    churnedEarly: false,
    fixTouches: existing.fixTouches + (isFix ? 1 : 0),
    authorKind: winnerIsNew ? authorKind : existing.authorKind,
    lastTouchSha: winnerIsNew ? sha : existing.lastTouchSha,
    lastHumanCommitTs:
      authorKind === 'human' ? (existing.lastHumanCommitTs === null ? ts : Math.max(existing.lastHumanCommitTs, ts)) : existing.lastHumanCommitTs,
  });
}

function scopeKeyOf(scope: StoredRawScope): string {
  return `${scope.kind}#${scope.qualifiedName}`;
}

/** D5's seven-field tuple. `returnShape` is `null` when the body has no return statement at all — distinct from `RawScope.lastReturnExprType`'s own `'bare'` (a return with no value). */
function computeValueTuple(scope: StoredRawScope): ValueTuple {
  return {
    nameShape: nameShape(scope.name),
    firstStatementType: scope.firstStatementType ?? null,
    returnShape: scope.hasReturnStatement ? (scope.lastReturnExprType ?? null) : null,
    decorators: [...scope.decorators].sort(),
    supertypes: [...scope.supertypes].sort(),
    nodeTypesSeen: [...scope.nodeTypesSeen].sort(),
    calleeTexts: [...scope.calleeTexts].sort(),
  };
}

/** sha256 over the tuple's canonical JSON (D5, Step 3) — field order is fixed by `computeValueTuple`'s own literal shape, so no separate key-sorting canonicalizer is needed the way `history.ts`'s generic records need one. */
function valueSignature(scope: StoredRawScope): string {
  return hashString(JSON.stringify(computeValueTuple(scope)));
}

/** The pre-image scope-key -> scope map for one record, or empty when there is no pre-image at all (`A`) or the pre-image blob could not be resolved into scopes for ANY reason (no sha, unresolved, or any skip reason) — every one of those cases means "no prior value is known", which makes every post-image scope key an introduction, exactly D17's own worked rename-out-of-an-excluded-prefix example. */
function preScopeMap(records: BlobRecordLookup, preSha: string | null, prePath: string): Map<string, StoredRawScope> {
  const map = new Map<string, StoredRawScope>();
  if (preSha === null) return map;
  const rec = records.get(preSha, prePath);
  if (!rec || rec.skipped) return map;
  for (const scope of rec.scopes) map.set(scopeKeyOf(scope), scope);
  return map;
}

/**
 * Fold one file record into `state`. D and T touch their file-level row only
 * and nothing else (D: `Step 4(b)` — a delete prunes no lifecycle rows and
 * contributes its own touch nowhere else; T: never blob-resolved even though
 * its own record shape carries two non-null shas, per `HistoryFileRecord
 * .status`'s own doc) — and, like every other status, only when the touched
 * path clears D17 gate 2 (`state.carriesLifecycleRows`): a path the walk sees
 * but gate 2 rejects gets no lifecycle row of either level, categorically,
 * whether the record that touched it was blob-resolvable or not (Step 2's own
 * rule; the module comment above states why). A and M/R/C resolve the
 * post-image blob at the record's own post-image path (`newPath ?? path`) and
 * branch on what comes back: unresolved (a caller contract violation, logged
 * and skipped, never silently swallowed per R4-I10); `'no-grammar'`/
 * `'excluded'` (no row at all, neither level — the same gate-2 rejection D/T
 * check explicitly, since a resolved `BlobRecord`'s own skip reason answers
 * it for these four statuses without a second lookup); `'oversize'`/
 * `'unparseable'` (file-level row only); a genuine `BlobScopeRecord` over
 * `history.lifecycleFileMaxKb` (file-level row only, the size cost guard);
 * otherwise full scope processing against the pre-image scope set.
 */
function processRecord(state: ReplayState, commit: HistoryCommitRecord, records: BlobRecordLookup, record: HistoryFileRecord): void {
  const prePath = record.path;
  const postPath = record.newPath ?? record.path;

  if (record.status === 'D') {
    if (state.carriesLifecycleRows(prePath)) applyTouch(state, prePath, 'file', commit);
    return;
  }
  if (record.status === 'T') {
    if (state.carriesLifecycleRows(postPath)) applyTouch(state, postPath, 'file', commit);
    return;
  }

  if (record.status === 'R' || record.status === 'C') {
    // `-C` is outside R4's flag set (`-M` only, never `-C`) so a 'C' status is
    // unreachable in practice; handled identically to 'R' because the union
    // carries it, not because a copy behaves like a rename — a copy leaves
    // the source in place, so this edge rule would be wrong for one if `-C`
    // were ever added without first revisiting it.
    state.aliasEdges.push({ from: prePath, to: postPath, ts: commit.committerTs, sha: commit.sha });
  }

  const postSha = record.postSha;
  if (postSha === null) {
    debugWrite(`[history-replay] record status '${record.status}' at ${postPath} in commit ${commit.sha} carries no postSha — skipped`);
    return;
  }
  const postRecord = records.get(postSha, postPath);
  if (postRecord === undefined) {
    debugWrite(
      `[history-replay] unresolved blob record for ${postSha} at ${postPath} in commit ${commit.sha} — the caller must resolve every touched blob before replaying this commit; skipped`,
    );
    return;
  }
  if (postRecord.skipped) {
    if (postRecord.reason === 'no-grammar' || postRecord.reason === 'excluded') {
      // D17 gate 2's own reject: never fetched, never keyed — no row at all.
      return;
    }
    // 'oversize' | 'unparseable': cleared both gates, kept the file-level row.
    applyTouch(state, postPath, 'file', commit);
    return;
  }

  if (postRecord.bytes > state.thresholds.lifecycleFileMaxKb * 1024) {
    applyTouch(state, postPath, 'file', commit);
    return;
  }

  applyTouch(state, postPath, 'file', commit);

  const preScopes = preScopeMap(records, record.preSha, prePath);
  for (const scope of postRecord.scopes) {
    const scopeKey = scopeKeyOf(scope);
    const rowKey = `${postPath}#${scopeKey}`;
    applyTouch(state, rowKey, 'scope', commit);

    const preScope = preScopes.get(scopeKey);
    const kind: ValueEvent['kind'] | undefined = !preScope ? 'introduction' : valueSignature(scope) !== valueSignature(preScope) ? 'change' : undefined;
    if (kind) {
      state.events.push({
        key: rowKey,
        ts: commit.committerTs,
        kind,
        value: computeValueTuple(scope),
        authorHash: commit.authorHash,
        authorKind: commit.authorKind,
        sha: commit.sha,
      });
    }
  }
}

export function replayCommit(state: ReplayState, commit: HistoryCommitRecord, records: BlobRecordLookup): void {
  for (const record of commit.files) {
    processRecord(state, commit, records, record);
  }
}

// -----------------------------------------------------------------------------
// Step 5: finishReplay — alias closure, rewrite+merge, appearance-cap
// demotion, and the final sort.
// -----------------------------------------------------------------------------

/**
 * The one-pass alias closure dictated by Step 5: walk the accumulated raw
 * edges once in ascending `(ts, sha)`; for each edge `(from, to)` set
 * `map[from] = to`, then retarget every entry ALREADY pointing at `from` to
 * `to`. One pass, no fixpoint — a naive repeat-until-nothing-changes loop
 * would spin forever on a rename-back cycle (`a→c` then, later, `c→a`, which
 * `-M` emits as two real `R100` records, not a delete-plus-add). Every value
 * this map ever holds is already a FINAL target the moment it is written
 * (retargeting is immediate, not deferred), so a single lookup resolves a
 * path fully — no chained re-lookup is ever needed.
 */
function computeAliasClosure(edges: readonly AliasEdge[]): Map<string, string> {
  const sorted = [...edges].sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : compareStrAsc(a.sha, b.sha)));
  const map = new Map<string, string>();
  for (const edge of sorted) {
    map.set(edge.from, edge.to);
    for (const [k, v] of map) {
      if (v === edge.from) map.set(k, edge.to);
    }
  }
  return map;
}

function resolveFinalPath(aliasMap: Map<string, string>, p: string): string {
  return aliasMap.get(p) ?? p;
}

/** Splits a key into its `relPath` component and the `#kind#qualifiedName` suffix — `null` for a file-level key (no `#` at all). */
function splitScopeKey(key: string): { relPath: string; suffix: string } | null {
  const idx = key.indexOf('#');
  return idx === -1 ? null : { relPath: key.slice(0, idx), suffix: key.slice(idx) };
}

function rewriteRowKey(row: LifecycleRow, aliasMap: Map<string, string>): string {
  if (row.level === 'file') return resolveFinalPath(aliasMap, row.key);
  const parts = splitScopeKey(row.key);
  /* v8 ignore next -- every scope-level row's key is built as `${postPath}#${scopeKey}` (processRecord above), so it always carries a '#'; this branch defends a type invariant no real input can violate. */
  if (!parts) return row.key;
  return resolveFinalPath(aliasMap, parts.relPath) + parts.suffix;
}

function rewriteEventKey(key: string, aliasMap: Map<string, string>): string {
  const parts = splitScopeKey(key);
  /* v8 ignore next -- every event key is built the same way as a scope row's key (processRecord above); see that branch's own note. */
  if (!parts) return key;
  return resolveFinalPath(aliasMap, parts.relPath) + parts.suffix;
}

/** The file a (rewritten, merged) row's key belongs to — the row's own key for a file-level row, or the `relPath` component for a scope-level one. Used to test a scope row against the appearance-cap demotion set, which is keyed by file path. */
function ownerFilePath(key: string): string {
  const parts = splitScopeKey(key);
  return parts ? parts.relPath : key;
}

/**
 * Merge every raw row whose alias-rewritten key landed on `finalKey` into one
 * row — the same min/max/counter rules `applyTouch` uses, restated as a fold
 * over already-accumulated SUMMARIES rather than one more touch.
 *
 * `modifications` is a SUM of each source row's own `modifications + 1`,
 * minus one — a PURE FUNCTION of each row's own already-persisted scalar,
 * deliberately never a union of real touching-commit sha sets
 * (`ReplayState.touchedBy` is NOT consulted here). This is a deliberate trade
 * against the plan's "keyed by sha, so a commit folded twice cannot
 * double-count" rule: a real union is exact WITHIN one run, but it is not
 * consistent BETWEEN a full fold and a split-and-resumed one whenever two
 * rows that later alias-merge shared a touching commit before the split point
 * — a resumed row's loaded half carries no per-run sha identities to union
 * with (`LifecycleRow`'s own field list has no room to persist a `Set<sha>`,
 * D1), so a real union computed from the resumed run's own `touchedBy` can
 * only ever see the fresh half's real shas, and must guess at the loaded
 * half's — producing a merged count that DIFFERS from the same fold done in
 * one unsplit pass. R4-I2 (a resumed index equals a full one, byte-for-byte)
 * is the invariant this module is explicitly named against, and Task 5's own
 * verify pass demonstrated a real union breaking it on real git, in five
 * commits (V-1) — a merge that is exact-but-order-dependent is not
 * acceptable here, so this function is CONSISTENT-BUT-OVERCOUNTING instead:
 * the sum-of-scalars total is identical whether computed in one pass or split
 * at any commit boundary, because it depends only on each source row's own
 * already-persisted `modifications` value, never on which raw rows happened
 * to share a fold. The overcount is real and bounded: a single commit that
 * touched N pre-merge rows which all land on the same final key is counted N
 * times, not once. Persisting a genuine `Set<sha>` per row (a `LifecycleRow`
 * schema change, graph-schema-version-worthy per AGENTS.md, and a
 * maintainer-level decision) would give exactness AND consistency at once;
 * until then, consistency wins.
 *
 * `fixTouches`/`lastHumanCommitTs` sum/max the same way as before;
 * `firstSeenTs`/`firstModifiedTs` are recomputed by feeding each source's own
 * `[firstSeenTs, firstModifiedTs]` pair through `feedDistinctMin` (valid
 * because the merged two smallest distinct values can only ever come from
 * some source's own two smallest — see that function's own doc);
 * `lastModifiedTs`/`lastTouchSha`/`authorKind` take the source with the
 * greatest `(lastModifiedTs, lastTouchSha)`, the same G.2 comparator
 * `applyTouch` uses. A single-row group is the common case (no alias landed
 * on it) and returns instantly.
 */
function mergeRowGroup(finalKey: string, level: 'scope' | 'file', rows: readonly LifecycleRow[]): LifecycleRow {
  if (rows.length === 1) return { ...rows[0], key: finalKey, level };

  let min1: number | null = null;
  let min2: number | null = null;
  let totalTouches = 0;
  let fixTouches = 0;
  let lastHumanCommitTs: number | null = null;
  let winnerTs = -Infinity;
  let winnerSha = '';
  let winnerAuthorKind: 'human' | 'agent' = 'human';

  for (const row of rows) {
    totalTouches += row.modifications + 1;
    fixTouches += row.fixTouches;
    if (row.lastHumanCommitTs !== null) {
      lastHumanCommitTs = lastHumanCommitTs === null ? row.lastHumanCommitTs : Math.max(lastHumanCommitTs, row.lastHumanCommitTs);
    }
    if (row.lastModifiedTs > winnerTs || (row.lastModifiedTs === winnerTs && row.lastTouchSha > winnerSha)) {
      winnerTs = row.lastModifiedTs;
      winnerSha = row.lastTouchSha;
      winnerAuthorKind = row.authorKind;
    }
    [min1, min2] = feedDistinctMin(min1, min2, row.firstSeenTs);
    if (row.firstModifiedTs !== null) [min1, min2] = feedDistinctMin(min1, min2, row.firstModifiedTs);
  }

  return {
    key: finalKey,
    level,
    firstSeenTs: min1 as number,
    firstModifiedTs: min2,
    lastModifiedTs: winnerTs,
    modifications: totalTouches - 1,
    churnedEarly: false,
    fixTouches,
    authorKind: winnerAuthorKind,
    lastTouchSha: winnerSha,
    lastHumanCommitTs,
  };
}

/** `firstModifiedTs - firstSeenTs <= churnEarlyDays` — both sides converted to the SAME unit first: `LifecycleRow` timestamps are epoch seconds, `churnEarlyDays` is a day count. */
function deriveChurnedEarly(row: LifecycleRow, churnEarlyDays: number): boolean {
  if (row.firstModifiedTs === null) return false;
  return row.firstModifiedTs - row.firstSeenTs <= churnEarlyDays * SECONDS_PER_DAY;
}

/**
 * Derive the finished replay products from `state`, without mutating it:
 * (1) the alias closure over every accumulated raw edge; (2) DECIDE the
 * appearance-cap demotion PER RAW PATH — against each raw file-level row's
 * own touch count, at its own pre-alias key, never against a total an alias
 * merge would later pool from a different path's own history (Step 4(a)'s
 * "per-path appearance counter": a file that followed a rename starts
 * counting again at its new name); (3) rewrite EVERY row's and EVERY event's
 * `relPath` component through the closure and merge rows landing on the same
 * key — file-level rows always survive; a merged SCOPE row (or event) is then
 * DROPPED IN FULL when its final owner path was reached, through the SAME
 * closure, by ANY raw path decided-demoted in step (2) (`demotedFinalPaths`)
 * — never partially, and never decided from the merged/pooled total. The drop
 * happens AFTER the merge, on the FINAL key, deliberately: deciding is per
 * raw path, but dropping BEFORE the merge (on each row's own raw key) would
 * let an un-demoted raw contributor's row survive un-merged while its
 * demoted alias-sibling is dropped, leaving the SURVIVING row at the final
 * key reporting that contributor's own, stale `lastModifiedTs` instead of
 * the file's true latest touch — exactly the defect R4 verify pass V-2
 * demonstrated on real git (a renamed-then-hot file keeping a scope row
 * three days stale at its own file's `lastModifiedTs`). Deciding per raw path
 * but dropping per final key closes that: once ANY raw contributor folded
 * into a final identity crossed the cap, the WHOLE merged scope row at that
 * final key is gone, and only the file-level row — which always survives,
 * carrying the full pooled total — remains to represent it; (4) sort rows by
 * `(key, level)`, events by `(ts, key, kind, sha)`, aliases by `(from, to)`.
 * `events_n` is the RAW pre-demotion count (`state.events.length`) — D4's own
 * `historyStats.events` accumulator, which no run can retro-subtract a
 * demoted subset from.
 */
export function finishReplay(state: ReplayState): ReplayResult {
  const aliasMap = computeAliasClosure(state.aliasEdges);
  const events_n = state.events.length;

  const demotedRawPaths = new Set<string>();
  for (const row of state.rows.values()) {
    if (row.level === 'file' && row.modifications + 1 > state.thresholds.lifecycleMaxAppearances) {
      demotedRawPaths.add(row.key);
      debugWrite(`[history-replay] ${row.key} appeared in ${row.modifications + 1} commits, over lifecycleMaxAppearances (${state.thresholds.lifecycleMaxAppearances}) — demoted to file-level only`);
    }
  }
  // Map the raw, pre-alias demotion decisions through the SAME closure the rows and events are
  // about to be rewritten through — the drop is applied post-merge, at the FINAL key, so an
  // alias-merged scope row can never survive carrying only its un-demoted contributor's stale
  // history (R4 verify pass V-2; see this function's own doc above).
  const demotedFinalPaths = new Set<string>([...demotedRawPaths].map((p) => resolveFinalPath(aliasMap, p)));

  const groups = new Map<string, LifecycleRow[]>();
  for (const row of state.rows.values()) {
    const finalKey = rewriteRowKey(row, aliasMap);
    const group = groups.get(finalKey);
    if (group) group.push(row);
    else groups.set(finalKey, [row]);
  }

  const merged = new Map<string, LifecycleRow>();
  for (const [finalKey, group] of groups) {
    merged.set(finalKey, mergeRowGroup(finalKey, group[0].level, group));
  }

  const lifecycle: LifecycleRow[] = [];
  for (const row of merged.values()) {
    if (row.level === 'scope' && demotedFinalPaths.has(ownerFilePath(row.key))) continue;
    lifecycle.push({ ...row, churnedEarly: deriveChurnedEarly(row, state.thresholds.churnEarlyDays) });
  }
  lifecycle.sort(compareRowKeyLevel);

  const events = state.events
    .map((e) => ({ ...e, key: rewriteEventKey(e.key, aliasMap) }))
    .filter((e) => !demotedFinalPaths.has(ownerFilePath(e.key)));
  events.sort(compareEventTuple);

  const aliases: Array<[string, string]> = [...aliasMap.entries()].sort(([f1, t1], [f2, t2]) => {
    const fromCmp = compareStrAsc(f1, f2);
    return fromCmp !== 0 ? fromCmp : compareStrAsc(t1, t2);
  });

  return { lifecycle, events, aliases, events_n };
}
