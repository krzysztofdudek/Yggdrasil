/**
 * source/cli/src/core/advise-feed.ts — `applyDecisions`, the pure feed-semantics
 * function that folds the committed decision register (io/advise-decisions-store)
 * over the live nominations (core/advise-nominations) to decide what an operator
 * currently sees.
 *
 * A decision applies to a nomination ONLY when it names the same `id` AND its
 * `evidenceHash` still matches the nomination's current evidence. That single
 * rule delivers the whole contract:
 *   - dismiss + same hash → HIDDEN (surfaced only under `--all`).
 *   - defer   + same hash → HIDDEN until `until`; on/after `until` (per the
 *                           injected `todayUtc`) it RETURNS with note
 *                           'deferral elapsed'.
 *   - done    + same hash → HIDDEN permanently (law materialized).
 *   - evidence change (a decision whose hash no longer matches the current
 *     nomination) → the stale decision stops applying, so the nomination RETURNS
 *     as new.
 *
 * Pure and deterministic: the only clock is the injected `todayUtc`, matching the
 * engine's no-`Date.now` rule.
 */

import type { Nomination } from './advise-nominations.js';
import type { AdviseDecision } from '../io/advise-decisions-store.js';

/** A visible nomination, optionally annotated (e.g. a returned deferral). */
export type VisibleNomination = Nomination & { note?: string };

/** The feed split: what shows now (`visible`) vs. what is suppressed (`hidden`). */
export interface AppliedFeed {
  visible: VisibleNomination[];
  hidden: Nomination[];
}

/** Bare `YYYY-MM-DD` of a UTC instant — the granularity a defer `until` compares at. */
function bareUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The decision that governs a nomination: the latest (by `ts`, then by append
 * order) decision that both names the nomination's `id` AND still matches its
 * `evidenceHash`. A decision whose hash no longer matches is stale and never
 * governs, so its nomination returns as new. Returns undefined when nothing
 * applies.
 */
function governingDecision(
  nomination: Nomination,
  decisions: AdviseDecision[],
): AdviseDecision | undefined {
  let governing: AdviseDecision | undefined;
  for (const decision of decisions) {
    if (decision.id !== nomination.id) continue;
    if (decision.evidenceHash !== nomination.evidenceHash) continue;
    // Later ts wins; equal ts falls to append order (this later element).
    if (governing === undefined || decision.ts >= governing.ts) {
      governing = decision;
    }
  }
  return governing;
}

/**
 * Fold `decisions` over `noms` under the injected `todayUtc`, splitting them into
 * what the operator sees now (`visible`) and what stays suppressed (`hidden`).
 * Input order is preserved within each bucket.
 */
export function applyDecisions(
  noms: Nomination[],
  decisions: AdviseDecision[],
  todayUtc: Date,
): AppliedFeed {
  const visible: VisibleNomination[] = [];
  const hidden: Nomination[] = [];
  const today = bareUtcDate(todayUtc);

  for (const nomination of noms) {
    const governing = governingDecision(nomination, decisions);

    // No applying decision — the nomination is new or its evidence has moved.
    if (governing === undefined) {
      visible.push(nomination);
      continue;
    }

    if (governing.action === 'dismiss' || governing.action === 'done') {
      hidden.push(nomination);
      continue;
    }

    // defer: hidden until `until`; on/after `until` it returns, annotated. A
    // missing `until` (anomalous — the defer command always sets it) cannot
    // define a hide window, so the item returns rather than hides forever.
    const until = governing.until;
    const elapsed = until === undefined || today >= until;
    if (elapsed) {
      visible.push({ ...nomination, note: 'deferral elapsed' });
    } else {
      hidden.push(nomination);
    }
  }

  return { visible, hidden };
}
