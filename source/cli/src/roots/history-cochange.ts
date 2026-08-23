/**
 * source/cli/src/roots/history-cochange.ts — R4 Task 6: the co-change
 * accumulator and its coupling projections. Folds a walked commit's changed-
 * file set into per-pair support and per-file commit counts (spec §13.5,
 * `v6-spec.md:621-625`), then derives, at finish, the cut pair set (D1's
 * raw-versus-derived split) and the file/module coupling percentiles
 * (Appendix G.3, `:1018`).
 *
 * TWO PUBLIC OPERATIONS. `accumulateCochange(state, commit)` folds one
 * commit's already-gate-1-filtered file set into `state`, mutating it in
 * place — synchronous, no I/O, and applying **no exclusion of its own**: the
 * caller (`buildHistoryJoin`'s probe-then-fetch protocol) filters each
 * commit's `files` array through `makeRootsFileFilters(config).forMarkers`
 * exactly once, before any consumer — including this one — ever sees it
 * (D17 gate 1). A record failing gate 1 never reaches this module; a record
 * passing gate 1 but failing gate 2 (no registered grammar, or excluded from
 * parsing) counts here in full — §6.8's "test-pattern files … remain fully
 * counted for co-change and history" (`v6-spec.md:271`) is exactly this
 * middle tier, and it is what makes the `routing.py ↔ test_routing.py`
 * signal reachable at all. `finishCochange(state, config, resolvePath)`
 * derives the finished products — WITHOUT mutating `state`, so it may be
 * called more than once on the same state (acceptance 5's repeat-call
 * property): the cut pair set, and the coupling percentiles computed over
 * that cut set.
 *
 * ORDER-FREE BY CONSTRUCTION (D16). Every quantity this module accumulates
 * is a plain integer sum — support counts and per-file commit counts — and
 * integer addition is commutative, so folding the same commits through
 * `accumulateCochange` in any order (or split across any number of calls,
 * with a persist/reload of the raw accumulator in between) leaves `state`
 * equivalent. `finishCochange` never reads Map iteration order into its
 * result: every collection it produces is explicitly re-sorted before
 * being returned, so nothing here depends on which order a JS `Map` happens
 * to iterate its entries in.
 *
 * PAIRS ARE ACCUMULATED RAW; THE CUT IS DERIVED, NEVER PERSISTED AS STATE
 * (D1). `accumulateCochange` writes only to `state.pairSupport` and
 * `state.fileCommits` — the uncut, unfiltered, un-rename-resolved raw
 * accumulators `cochange-raw.jsonl` persists (via `serializeCochangeState`/
 * `deserializeCochangeState` below). The `cochange.minSupport`/
 * `minConfidence` filter and the `maxPairs` cut happen once, inside
 * `finishCochange`, and are never baked into the accumulator: a pair sitting
 * at support 7 today must still be able to reach 8 on a later run, and a
 * pair outside today's 5000-pair cut may belong in tomorrow's — persisting
 * the filtered/cut set instead would make either floor permanent, which is
 * exactly what would make a resumed index disagree with a full one (R4-I2).
 *
 * RENAMES FOLD AT FINISH, THROUGH THE INJECTED `resolvePath` — NEVER AS A
 * RUNNING REMAP DURING ACCUMULATION. `resolvePath` is the alias closure
 * `history-replay.ts`'s `finishReplay` produces from the SAME walked
 * commits' rename edges (Task 5) — injected here rather than recomputed, so
 * there is exactly one rename map in the process. An `R`/`C` record counts
 * under its own commit's **new** path (the caller resolves `newPath ?? path`
 * before calling `accumulateCochange` — this module never inspects a
 * record's `status` at all, only the already-resolved path strings the
 * caller hands it via `HistoryCommitRecord.files`), and nothing else happens
 * at that moment: the supports and commit counts earlier commits accumulated
 * under the file's OLD path stay exactly where they were recorded and are
 * folded into the new path only once, at `finishCochange`, through
 * `resolvePath`. Rewriting past supports the instant a rename record arrives
 * would make the result depend on whether the rename happened to arrive
 * before or after a given co-change in THIS run's own walk order — which
 * differs between a full walk and a resume (D16) — so a running remap is
 * forbidden by construction: this module has no code path that could do it.
 * This module's own tests pass either the identity function or a small
 * hand-written map; the real alias closure is wired in by the caller that
 * owns the history join.
 *
 * COUPLING IS A REPO-GLOBAL PROJECTION OVER THE CUT SET, NOT THE MINING
 * ENGINE'S PARTITION-AWARE `moduleOfFile`. G.3 fixes the rank (`v6-spec.md
 * :1018`) but not the "module" a file belongs to for the per-module median;
 * `mine.ts`'s own `moduleOfFile` (`:978`) answers that question from a
 * PARTITION's minted `module`-kind scope units — data this module has no
 * access to (co-change is computed once, repo-wide, before partitioning is
 * even consulted). So `couplingByModule` here groups files by their own
 * PARENT DIRECTORY (`extract.ts`'s shared `dirnameOf`, the same POSIX-
 * relPath-dirname convention `partitions.ts`/`enumerate.ts` already reuse
 * rather than each re-deriving it) — a coarser, partition-free module
 * concept that is exactly right for a REPO-GLOBAL field. Appendix D places
 * `couplingByFile`/`couplingByModule` inside each `partitions[]` entry
 * beside the partition's own `moduleOfFile` (`:892`); projecting this
 * module's repo-global maps down to one partition's own file set and module
 * boundaries is downstream wiring's job, not this module's.
 */

import type { HistoryCommitRecord } from '../utils/git-history.js';
import type { RootsConfig } from './model.js';
import { dirnameOf } from './extract.js';

// -----------------------------------------------------------------------------
// Interfaces produced
// -----------------------------------------------------------------------------

/** Appendix D's cut-set pair shape (`v6-spec.md:867`) — `{"a":"…","b":"…","sup":54,"conf":0.75}`, unabbreviated field names kept short to match the committed model body exactly. `a < b` lexicographically, always (the sort's own tie-break needs a total order, and a canonical side avoids ever emitting the same pair twice under swapped labels). */
export interface CochangePair {
  a: string;
  b: string;
  sup: number;
  conf: number;
}

/** One raw pair row as `cochange-raw.jsonl` persists it (D1) — uncut, unfiltered, keyed on whatever path the walk recorded (pre-`resolvePath`). `a < b` lexicographically at the RAW path, same convention as `CochangePair`. */
export interface CochangeRawPairRow {
  a: string;
  b: string;
  support: number;
}

/** One raw per-file commit-count row as `cochange-raw.jsonl` persists it (D1) — the `commits(a)` denominator `finishCochange`'s confidence needs, accumulated over the SAME qualifying-commit set as the pair supports. */
export interface CochangeRawFileRow {
  path: string;
  commits: number;
}

/** The two `history.*` thresholds this module needs at accumulate time, threaded once at construction since `accumulateCochange`'s own signature takes no config parameter. Currently one field; kept as its own named type rather than a bare number so a future threshold has somewhere to land without widening `accumulateCochange`'s signature. */
export interface CochangeThresholds {
  megaCommitFileCap: number;
}

/**
 * The live accumulator `accumulateCochange` mutates. `pairSupport` is keyed
 * by the RAW, unordered pair (`pairMapKey`, below) so a pair folded from
 * either file-ordering direction lands on one entry; `fileCommits` is keyed
 * by the raw path alone. `processedShas` guards the SAME per-run idempotency
 * `history-replay.ts`'s `touchedBy` guards for lifecycle rows: a commit
 * folded twice (a re-fed record, or a caller retrying a batch) must not
 * increment any support or count a second time. `processedShas` is this
 * run's own bookkeeping only — like `touchedBy`, it never survives a
 * serialize/deserialize round-trip (`deserializeCochangeState` always starts
 * it empty), because a resume only ever feeds commits the previous run never
 * saw, so there is nothing to re-guard against.
 */
export interface CochangeState {
  thresholds: CochangeThresholds;
  processedShas: Set<string>;
  pairSupport: Map<string, CochangeRawPairRow>;
  fileCommits: Map<string, number>;
}

export function createCochangeState(thresholds: CochangeThresholds): CochangeState {
  return { thresholds, processedShas: new Set(), pairSupport: new Map(), fileCommits: new Map() };
}

/** The two raw accumulators in `io/roots-history-store.ts`'s own documented per-file order — the shape a caller persists into `cochange-raw.jsonl`'s two blocks. */
export interface CochangeStateSnapshot {
  pairs: CochangeRawPairRow[];
  fileCommits: CochangeRawFileRow[];
}

function compareStrAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `(a, b)` — `cochange-raw.jsonl`'s own pair-block order (`roots-history-store.ts`'s header comment). */
function comparePairRow(x: CochangeRawPairRow, y: CochangeRawPairRow): number {
  const aCmp = compareStrAsc(x.a, y.a);
  return aCmp !== 0 ? aCmp : compareStrAsc(x.b, y.b);
}

/** Snapshot `state`'s two raw accumulators for persistence, in `io/roots-history-store.ts`'s own documented order. Read-only: `state` is untouched. */
export function serializeCochangeState(state: CochangeState): CochangeStateSnapshot {
  return {
    pairs: [...state.pairSupport.values()].sort(comparePairRow),
    fileCommits: [...state.fileCommits.entries()]
      .map(([path, commits]) => ({ path, commits }))
      .sort((x, y) => compareStrAsc(x.path, y.path)),
  };
}

/**
 * Reconstruct a `CochangeState` from a loaded snapshot plus the run's own
 * thresholds — config, not accumulated data, so it is supplied fresh on
 * every load rather than round-tripped through the snapshot (the same
 * choice `history-replay.ts`'s `deserializeReplayState` makes for its own
 * thresholds). `processedShas` starts empty — see `CochangeState`'s own doc.
 */
export function deserializeCochangeState(snapshot: CochangeStateSnapshot, thresholds: CochangeThresholds): CochangeState {
  const pairSupport = new Map<string, CochangeRawPairRow>();
  for (const row of snapshot.pairs) pairSupport.set(pairMapKey(row.a, row.b), { ...row });
  const fileCommits = new Map<string, number>();
  for (const { path, commits } of snapshot.fileCommits) fileCommits.set(path, commits);
  return { thresholds, processedShas: new Set(), pairSupport, fileCommits };
}

// -----------------------------------------------------------------------------
// Step 1: accumulateCochange
// -----------------------------------------------------------------------------

/** Map key for an UNORDERED file pair — lexicographically smaller path first, joined on a NUL separator (`\u0000`) so `(a, b)` and `(b, a)` land on the same accumulator entry regardless of which order the caller's file list happened to present them in. NUL is the one byte a POSIX path can never contain, so no two distinct path pairs can ever collide onto the same key — a plain space or any other printable joiner is a legal path character and would let an unrelated pair alias onto this one. */
function pairMapKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Fold one commit's file set into `state`. Idempotent per commit sha
 * (`processedShas`) — a commit folded twice contributes once. The changed-
 * file set is every DISTINCT `newPath ?? path` across the commit's records
 * (a `Set`, so a commit whose raw records happen to repeat a path — not
 * something a real git walk produces, but not this function's business to
 * assume — still counts that path once); only non-merge commits (the walk
 * itself is `--no-merges`, so every `HistoryCommitRecord` this function ever
 * sees already satisfies that) with **>= 2 and <= `history.megaCommitFileCap`**
 * changed files contribute anything at all — a commit outside that band
 * updates neither accumulator, which is what keeps a mass refactor or a
 * lockfile sweep from coupling everything in it to everything else (spec
 * §13.5). Every file in a qualifying commit gets its `fileCommits` count
 * incremented once (the `commits(a)` confidence denominator); every
 * UNORDERED pair among those files gets its `pairSupport` entry incremented
 * once. This function applies no exclusion of its own beyond the file-count
 * band — see this file's header comment for why gate 1 is entirely the
 * caller's concern and gate 2 is deliberately never applied on this path.
 */
export function accumulateCochange(state: CochangeState, commit: HistoryCommitRecord): void {
  if (state.processedShas.has(commit.sha)) return;
  state.processedShas.add(commit.sha);

  const fileSet = new Set<string>();
  for (const f of commit.files) fileSet.add(f.newPath ?? f.path);
  const files = [...fileSet];

  if (files.length < 2 || files.length > state.thresholds.megaCommitFileCap) return;

  for (const f of files) {
    state.fileCommits.set(f, (state.fileCommits.get(f) ?? 0) + 1);
  }

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const key = pairMapKey(files[i], files[j]);
      const existing = state.pairSupport.get(key);
      if (existing) {
        existing.support += 1;
      } else {
        const a = files[i] < files[j] ? files[i] : files[j];
        const b = files[i] < files[j] ? files[j] : files[i];
        state.pairSupport.set(key, { a, b, support: 1 });
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Step 2/3: finishCochange
// -----------------------------------------------------------------------------

/**
 * Resolve every raw pair's two sides through `resolvePath` and merge every
 * pair landing on the same final unordered pair — additive, so the merged
 * support is exactly the sum of every raw pair's own support, independent of
 * which raw pairs happened to alias together or in what order this function
 * visits them (`state.pairSupport`'s own iteration order, which is itself
 * insertion order — deterministic, but immaterial here since addition is
 * commutative). A raw pair whose two sides resolve to the SAME final path
 * (two distinct raw paths that both close onto one final identity) is
 * dropped — a file cannot be its own co-change partner, and no acceptance
 * in this module exercises that shape on a real rename chain; it exists only
 * as a defensive floor against a degenerate `resolvePath`.
 */
function resolvePairs(pairSupport: ReadonlyMap<string, CochangeRawPairRow>, resolvePath: (p: string) => string): Map<string, CochangeRawPairRow> {
  const resolved = new Map<string, CochangeRawPairRow>();
  for (const { a, b, support } of pairSupport.values()) {
    const ra = resolvePath(a);
    const rb = resolvePath(b);
    if (ra === rb) continue;
    const finalA = ra < rb ? ra : rb;
    const finalB = ra < rb ? rb : ra;
    const key = pairMapKey(finalA, finalB);
    const existing = resolved.get(key);
    if (existing) existing.support += support;
    else resolved.set(key, { a: finalA, b: finalB, support });
  }
  return resolved;
}

/** Resolve every raw file's commit count through `resolvePath` and merge counts landing on the same final path — additive, same reasoning as `resolvePairs`. */
function resolveFileCommits(fileCommits: ReadonlyMap<string, number>, resolvePath: (p: string) => string): Map<string, number> {
  const resolved = new Map<string, number>();
  for (const [rawPath, count] of fileCommits) {
    const finalPath = resolvePath(rawPath);
    resolved.set(finalPath, (resolved.get(finalPath) ?? 0) + count);
  }
  return resolved;
}

/** `(sup desc, a asc, b asc)` — Step 2's own stated order: sort BEFORE the `maxPairs` cut, never after, so a first-N-by-insertion cut can never drop the strongest pair (MR-17). */
function comparePairsForCut(x: CochangePair, y: CochangePair): number {
  if (x.sup !== y.sup) return y.sup - x.sup;
  const aCmp = compareStrAsc(x.a, y.a);
  return aCmp !== 0 ? aCmp : compareStrAsc(x.b, y.b);
}

/**
 * Step 3's own formalization (G.3 gives the rank, not the convention — this
 * plan fixes it): `percentile = round(100 * |{files with a strictly smaller
 * partner count}| / |files with any coupling entry|)`, ties sharing a
 * percentile. `partnerCounts` is the number of DISTINCT co-change partners
 * each file has in the CUT set (`pairs`, post `minSupport`/`minConfidence`/
 * `maxPairs`) — every pair in that set already cleared the max-direction
 * `>= minConfidence` gate, so counting a file's appearances across `pairs`
 * directly answers "distinct partners with confidence >= minConfidence"
 * with no second filter needed. Implemented as a sorted-values rank lookup
 * (O(n log n)) rather than the O(n^2) direct pairwise comparison the prose
 * formula reads as, since `n` here is bounded by `2 * maxPairs` file
 * endpoints (up to 10 000 at the default 5000) and a repository-scale
 * quadratic pass is exactly the unbudgeted cost this codebase avoids
 * elsewhere for the same reason (see `mine-stages.ts`'s own note on why its
 * cell-construction `Set`s are never re-sorted).
 */
function computeFilePercentiles(partnerCounts: ReadonlyMap<string, number>): Record<string, number> {
  const entries = [...partnerCounts.entries()];
  const total = entries.length;
  const out: Record<string, number> = {};
  if (total === 0) return out;

  const sortedCounts = entries.map(([, c]) => c).sort((x, y) => x - y);
  const firstIndexOfValue = new Map<number, number>();
  for (let i = 0; i < sortedCounts.length; i++) {
    const c = sortedCounts[i];
    if (!firstIndexOfValue.has(c)) firstIndexOfValue.set(c, i);
  }

  for (const [file, count] of entries) {
    /* v8 ignore next -- `count` is drawn from the same `entries` array `sortedCounts` was built from, so `firstIndexOfValue` always has an entry for it; a miss is structurally impossible. */
    const smaller = firstIndexOfValue.get(count) ?? 0;
    out[file] = Math.round((100 * smaller) / total);
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Group `couplingByFile`'s entries by their file's own parent directory
 * (this file's header comment explains why that is the right "module" here,
 * repo-global and partition-free) and take the ROUNDED median of each
 * group's percentiles. Rounding the median extends the per-file percentile's
 * own rounding rule to the per-module aggregate: Appendix
 * D's own worked example shows an integer (`"couplingByModule":
 * {"src/app":61}`, `v6-spec.md:892`), and a fractional median (an even-sized
 * group's average of two adjacent integers) would silently violate that
 * shape on the commonest case — an even file count per module.
 */
function computeModuleCoupling(couplingByFile: Record<string, number>): Record<string, number> {
  const byModule = new Map<string, number[]>();
  for (const file of Object.keys(couplingByFile)) {
    const mod = dirnameOf(file);
    const group = byModule.get(mod);
    if (group) group.push(couplingByFile[file]);
    else byModule.set(mod, [couplingByFile[file]]);
  }
  const out: Record<string, number> = {};
  for (const [mod, values] of byModule) out[mod] = Math.round(median(values));
  return out;
}

/**
 * Derive the finished co-change products from `state`, without mutating it:
 * (1) resolve every raw pair and every raw per-file commit count through
 * `resolvePath` and merge onto final paths (Step 2 — see `resolvePairs`/
 * `resolveFileCommits`); (2) compute max-direction confidence
 * `max(support/commits(a), support/commits(b))` per resolved pair and keep
 * only pairs with `support >= cochange.minSupport` AND that max-direction
 * confidence `>= cochange.minConfidence`; (3) sort the survivors by
 * `(sup desc, a asc, b asc)` and cut at `cochange.maxPairs` — sorting BEFORE
 * cutting, never after (MR-17); (4) compute the coupling percentiles (Step
 * 3) over that cut set. `config` is the full `RootsConfig` (matching this
 * module's siblings' own convention, `history.ts`'s `extractBlobRecord`
 * included) though only `config.cochange`'s three fields are read.
 */
export function finishCochange(
  state: CochangeState,
  config: RootsConfig,
  resolvePath: (p: string) => string,
): { pairs: CochangePair[]; couplingByFile: Record<string, number>; couplingByModule: Record<string, number> } {
  const resolvedPairs = resolvePairs(state.pairSupport, resolvePath);
  const resolvedFileCommits = resolveFileCommits(state.fileCommits, resolvePath);

  // Every file appearing in a resolved pair was incremented into `fileCommits` in the very same
  // `accumulateCochange` call that formed the pair (Step 1), through the SAME `resolvePath` fold,
  // so a miss here is structurally impossible — but the `?? 0` fallback still needs a real branch
  // for the type to be `number` rather than `number | undefined`, and no acceptance drives it, so
  // it is marked unreachable rather than left uncovered without explanation.
  const commitsOf = (file: string): number => {
    const n = resolvedFileCommits.get(file);
    /* v8 ignore next */
    return n ?? 0;
  };

  const { minSupport, minConfidence, maxPairs } = config.cochange;
  const qualifying: CochangePair[] = [];
  for (const { a, b, support } of resolvedPairs.values()) {
    const confAB = support / commitsOf(a);
    const confBA = support / commitsOf(b);
    const conf = Math.max(confAB, confBA);
    if (support >= minSupport && conf >= minConfidence) {
      qualifying.push({ a, b, sup: support, conf });
    }
  }
  qualifying.sort(comparePairsForCut);
  const pairs = qualifying.slice(0, maxPairs);

  const partnerCounts = new Map<string, number>();
  for (const p of pairs) {
    partnerCounts.set(p.a, (partnerCounts.get(p.a) ?? 0) + 1);
    partnerCounts.set(p.b, (partnerCounts.get(p.b) ?? 0) + 1);
  }
  const couplingByFile = computeFilePercentiles(partnerCounts);
  const couplingByModule = computeModuleCoupling(couplingByFile);

  return { pairs, couplingByFile, couplingByModule };
}
