/**
 * source/cli/src/roots/weights.ts — R4 Task 7: §9.1's instance weights, exactly.
 *
 * A PURE module: five arithmetic lines from spec §9.1
 * (`planning/roots/2026-08-17-yg-roots-v6-spec.md:368-379`), each transcribed
 * as its own named helper below (`wSurv`, `wProv`, `wChurn`, `base`, `w`) so a
 * mutation to any one factor is surgical and independently killable —
 * MR-19..22 each target exactly one of them. No I/O, no clock reads, no
 * randomness: every timestamp this module compares against comes in through
 * `WeightInputs.clockTs`, read ONCE by the caller from HEAD's committer
 * timestamp (R4-I1) — this module never calls `Date.now()`.
 *
 * BRANCH ORDER IS THE WHOLE POINT (R4-I5). `base(s)`'s three-way ladder — no
 * lifecycle row ⇒ `noLifecycleWeight`; else dirty ⇒ `dirtyWeight`; else
 * `max(baseFloor, wSurv·wProv·wChurn)` — is a DEGRADED-MODE SELECTOR, and the
 * ledger cap in `w(s,q)` wraps `base(s)`'s FULL result rather than folding
 * into the product `base` computes internally. A degraded branch (no row, or
 * dirty) must still be capped when a mark is present — `min(noLifecycleWeight,
 * hookShapedWeight)` is a real, reachable value, not a masked one — and that
 * is only true because the cap is applied LAST, by `w()`, never inlined into
 * `base()`'s own `max(baseFloor, …)` line (MR-19's killer case is exactly
 * this: no lifecycle row, mark present, `min(0.3, 0.15) = 0.15` — cap-inside-
 * the-product would instead read `0.3`, silently un-capping every degraded
 * scope a mark was meant to shape).
 *
 * A MODULE-KIND UNIT NEVER SURVIVES, AND THAT IS INVISIBLE FROM THE FORMULA
 * ALONE. `finalizeUnits` (`extract.ts:735-736`) mints a `module`-kind
 * `ScopeUnit` whose `relPath` is a DIRECTORY, never a real file the walk ever
 * recorded a blob for. `LifecycleIndex.rowFor(skeyR, relPath)` tries a
 * scope-level lookup first (keyed `relPath#kind#qualifiedName` — for a module
 * unit, a directory-shaped key no historical scope key can ever equal, since
 * every real scope's `relPath` names an actual parsed file) and then a
 * file-level lookup on the bare `relPath` (here, the directory itself — no
 * historical blob is ever recorded under a path that names a directory, not
 * a file). Both lookups therefore MISS for every module-kind unit, always —
 * `base(s)` takes the no-lifecycle-row branch every time, `w(s,q)` returns
 * `noLifecycleWeight` (0.3) unconditionally, and `ageDays` returns 0. This is
 * spec-consistent (§9.1 defines no third key space for `module`) but it is a
 * real product consequence stated once, here: no module-level fact can ever
 * be hook-eligible in R4 — a module scope's survived population is
 * permanently empty.
 *
 * WHAT THIS MODULE DOES NOT OWN. It reads a ledger already filtered to
 * UNRELEASED marks (`WeightInputs.ledger`'s own doc) — `releasedMarks` is the
 * function that does the filtering, exported separately so the caller (T8's
 * wiring) can compute the released set once, filter, and hand the remainder
 * in; it never counts `hookShapedConform`, never writes a mark, and exports
 * no `survived` predicate of its own — §9.4c's survived-raw population is
 * `ageDays(s) ≥ freshPenaltyDays ∧ ¬isHookShaped(s, q)`, composed by the
 * CALLER from the two functions this module exports for exactly that
 * purpose (`makeWeightFns`'s own `ageDays`/`isHookShaped`), never duplicated
 * here as a third function that could drift from the two it would recompute.
 */

import type { LifecycleRow } from './history-replay.js';
import type { LedgerEntry, RootsConfig } from '../model/graph.js';
import type { ScopeUnit } from './extract.js';

const SECONDS_PER_DAY = 86400;

// -----------------------------------------------------------------------------
// Interfaces produced
// -----------------------------------------------------------------------------

/**
 * A two-level "resolve this key to a lifecycle row" abstraction — scope-level
 * first, file-level fallback, `undefined` when neither matches. Deliberately
 * generic over what the two string arguments MEAN: `makeWeightFns` below
 * calls it with a `ScopeUnit`'s own `(skeyR, relPath)` pair (the real,
 * documented meaning, matching `LifecycleRow.key`'s two key spaces —
 * `history-replay.ts`'s own doc on that field), while `releasedMarks` calls
 * it with a ledger mark's `(stable_id, stable_id)` pair against a DIFFERENT
 * `LifecycleIndex` the caller builds for that purpose (see `releasedMarks`'s
 * own doc for why the two calls legitimately pass a different kind of
 * index through the same interface).
 */
export interface LifecycleIndex {
  rowFor(skeyR: string, relPath: string): LifecycleRow | undefined;
}

export interface WeightInputs {
  lifecycle: LifecycleIndex;
  ledger: readonly LedgerEntry[]; // committed marks; released marks already filtered out
  dirtyPaths: ReadonlySet<string>; // repo-relative POSIX
  clockTs: number; // HEAD committer timestamp, epoch seconds — the same
  // instant the header's ISO-8601 `clock` string encodes
  config: RootsConfig;
}

// -----------------------------------------------------------------------------
// §9.1's five lines, each its own named helper (Step 1) — module-private:
// the public surface is `makeWeightFns`/`releasedMarks` below, and keeping
// these five ungeneralized and unexported is what makes a mutation to any
// one of them show up ONLY through the public functions' own return values,
// exactly where the acceptance-table tests already look.
// -----------------------------------------------------------------------------

/** `stable_days = max(0, (now − L.last_modified_ts)/86400)` — §9.1. */
function stableDaysOf(row: LifecycleRow, clockTs: number): number {
  return Math.max(0, (clockTs - row.lastModifiedTs) / SECONDS_PER_DAY);
}

/** `age_days = max(0, (now − L.first_seen_ts)/86400)` — §9.1. */
function ageDaysOf(row: LifecycleRow, clockTs: number): number {
  return Math.max(0, (clockTs - row.firstSeenTs) / SECONDS_PER_DAY);
}

/**
 * `w_surv = min(1, stable_days/survivalFullDays) × (age_days < freshPenaltyDays
 * ? 0.5 : 1)` — §9.1. The fresh-penalty factor is a SEPARATE multiplicative
 * term from the survival ratio, not a substitute floor — MR-20's killer case
 * is exactly this factor's deletion.
 */
function wSurv(row: LifecycleRow, clockTs: number, config: RootsConfig): number {
  const stableDays = stableDaysOf(row, clockTs);
  const ageDaysValue = ageDaysOf(row, clockTs);
  const survivalRatio = Math.min(1, stableDays / config.weights.survivalFullDays);
  return survivalRatio * (ageDaysValue < config.weights.freshPenaltyDays ? 0.5 : 1);
}

/**
 * `w_prov = L.author_kind=='human' ? 1.0 : agentBase + (1−agentBase)·min(1,
 * stable_days/agentPromoteDays)` — §9.1.
 */
function wProv(row: LifecycleRow, clockTs: number, config: RootsConfig): number {
  if (row.authorKind === 'human') return 1.0;
  const stableDays = stableDaysOf(row, clockTs);
  const { agentBase, agentPromoteDays } = config.weights;
  return agentBase + (1 - agentBase) * Math.min(1, stableDays / agentPromoteDays);
}

/** `w_churn = L.churned_early ? 0.25 : 1.0` — §9.1. */
function wChurn(row: LifecycleRow): number {
  return row.churnedEarly ? 0.25 : 1.0;
}

/**
 * `base(s) = no lifecycle row ? noLifecycleWeight : scope dirty in working
 * tree ? dirtyWeight : max(baseFloor, w_surv·w_prov·w_churn)` — §9.1. Branch
 * order fixed; see this module's own header for why the ledger cap is
 * deliberately NOT a fourth branch here.
 */
function base(row: LifecycleRow | undefined, dirty: boolean, clockTs: number, config: RootsConfig): number {
  if (!row) return config.weights.noLifecycleWeight;
  if (dirty) return config.weights.dirtyWeight;
  return Math.max(config.weights.baseFloor, wSurv(row, clockTs, config) * wProv(row, clockTs, config) * wChurn(row));
}

/**
 * `w(s,q) = ledgerMarked(s,q) ? min(base(s), hookShapedWeight) : base(s)` —
 * §9.1, cap applied LAST (R4-I5). `baseValue` is `base(s)`'s already-computed
 * result, whichever branch produced it — degraded or not.
 */
function w(baseValue: number, marked: boolean, config: RootsConfig): number {
  return marked ? Math.min(baseValue, config.weights.hookShapedWeight) : baseValue;
}

// -----------------------------------------------------------------------------
// Public surface.
// -----------------------------------------------------------------------------

export function makeWeightFns(inputs: WeightInputs): {
  baseWeight: (unit: ScopeUnit) => number; // w_base — roles/§8.9b consumer (D7)
  surfaceWeight: (unit: ScopeUnit, surface: string) => number; // w(s,q) — cap applied LAST
  ageDays: (unit: ScopeUnit) => number; // AgeFn
  isHookShaped: (unit: ScopeUnit, surface: string) => boolean; // unreleased mark present
} {
  const { lifecycle, ledger, dirtyPaths, clockTs, config } = inputs;

  const rowOf = (unit: ScopeUnit): LifecycleRow | undefined => lifecycle.rowFor(unit.skeyR, unit.relPath);

  const isHookShaped = (unit: ScopeUnit, surface: string): boolean =>
    ledger.some((entry) => entry.stableId === unit.stableId && entry.surface === surface);

  const baseWeight = (unit: ScopeUnit): number => base(rowOf(unit), dirtyPaths.has(unit.relPath), clockTs, config);

  const surfaceWeight = (unit: ScopeUnit, surface: string): number => w(baseWeight(unit), isHookShaped(unit, surface), config);

  const ageDays = (unit: ScopeUnit): number => {
    const foundRow = rowOf(unit);
    return foundRow ? ageDaysOf(foundRow, clockTs) : 0;
  };

  return { baseWeight, surfaceWeight, ageDays, isHookShaped };
}

/**
 * §18.3's release rule, evaluated per mark: releases when the marked scope's
 * own `stable_days` (at `clockTs`, off the row the walk resolved for it) has
 * reached `ledger.releaseStableDays` AND there exists a human-authored
 * non-merge commit touching the scope with `ts ≥ markDate +
 * ledger.releaseMinDaysAfterMark` (Step 2; MR-22 kills the second conjunct's
 * deletion). `LifecycleRow.lastHumanCommitTs` — the max ts over human
 * touches, and every walked commit is already non-merge (`git log
 * --no-merges`, T2) — answers "exists a human touch at ts ≥ threshold"
 * directly: the greatest clears the threshold iff any does.
 *
 * Release is predicated on the SCOPE's `stable_days`, never on the mark's
 * own age (criterion 1) — `markDate` only ever enters the `releaseMinDaysAfterMark`
 * gap check, never the `stable_days` comparison itself.
 *
 * A mark whose scope the walk cannot resolve at all — `lifecycle.rowFor`
 * misses — stays capped: conservative, per D2/Step 2 ("Marks the walk cannot
 * see stay capped").
 *
 * THE STABLE_ID → ROW RESOLUTION IS THE CALLER'S, NOT THIS FUNCTION'S. A
 * `LedgerEntry` carries only the marked scope's CURRENT `stable_id` (D6),
 * never a `skeyR`/`relPath` pair — those exist only on a live `ScopeUnit`,
 * and mapping a `stable_id` to one is `mine.ts`'s own `unitByStableId`, built
 * from the CURRENT tree's unit list, which this pure module has neither
 * access to nor need of. So this function calls
 * `lifecycle.rowFor(mark.stableId, mark.stableId)` against a `LifecycleIndex`
 * the CALLER builds specifically for that purpose — one that resolves each
 * current unit's own `stable_id` through the REAL skeyR/relPath-keyed index
 * first (`unit.stableId -> realIndex.rowFor(unit.skeyR, unit.relPath)`) and
 * exposes the result behind the same two-argument shape, so a `(stable_id,
 * stable_id)` lookup here answers the identical question `makeWeightFns`
 * would ask via `(skeyR, relPath)`, for the one scope that owns that
 * `stable_id`. `LifecycleIndex` is deliberately just "resolve a key to a
 * row" — this module never assumes the two string arguments mean skeyR/
 * relPath specifically.
 *
 * Returns the set of RELEASED marks' identity keys — `markKey` below, over
 * `(stable_id, surface, date)`, §18.3's own dedupe triple — so the caller
 * filters `marks` down to the unreleased remainder before constructing
 * `WeightInputs.ledger`.
 */
export function releasedMarks(marks: readonly LedgerEntry[], lifecycle: LifecycleIndex, clockTs: number, config: RootsConfig): Set<string> {
  const released = new Set<string>();
  for (const mark of marks) {
    const row = lifecycle.rowFor(mark.stableId, mark.stableId);
    if (!row) continue;
    if (stableDaysOf(row, clockTs) < config.ledger.releaseStableDays) continue;
    const markMs = Date.parse(mark.date);
    if (Number.isNaN(markMs)) continue; // a syntactically valid, semantically malformed mark date — never resolvable, so treat as unreleased rather than throw
    const threshold = Math.floor(markMs / 1000) + config.ledger.releaseMinDaysAfterMark * SECONDS_PER_DAY;
    if (row.lastHumanCommitTs !== null && row.lastHumanCommitTs >= threshold) {
      released.add(markKey(mark));
    }
  }
  return released;
}

/** §18.3's own dedupe triple: `(stable_id, surface, date)`, NUL-joined via the \u0000 escape (never a raw NUL byte — the repo's `source-no-raw-control-chars` aspect forbids that encoding) - a surface id legitimately carries a colon (auto.call:foo), so a plain separator character risked collision. */
function markKey(entry: LedgerEntry): string {
  return `${entry.stableId}\u0000${entry.surface}\u0000${entry.date}`;
}
