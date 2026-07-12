/**
 * source/cli/src/core/advise-nominations.ts — the `Nomination` model and
 * `buildNominations`, which turns the graph's LIVE attention signals into a
 * stable, evidence-bound list of nominations.
 *
 * A nomination is one advisable attention item: a stable `id`, a `what`/`why`/
 * `next` triple, and an `evidenceHash` — the sha256 of a canonical snapshot of
 * exactly the evidence the item rests on. Binding a decision (dismiss / defer /
 * done — see io/advise-decisions-store) to that hash is what lets a dismissed
 * item stay hidden while its evidence is unchanged, yet return the moment the
 * evidence moves.
 *
 * This module produces the T0 LIVE sources (recomputed from the graph on every
 * run, never cached): overdue `review_by`, dead-attach (`aspect-effective-
 * nowhere`), orphaned aspects, and suppress-marker anomalies. Task 5 extends the
 * source set and the presentation. The three graph-derived sources are computed
 * here from the same check functions the validator uses (single source of truth
 * for their semantics); suppress anomalies are gathered at the CLI boundary
 * (which owns the filesystem walk) and injected via `sources`, keeping this
 * engine module deterministic and free of I/O.
 */

import type { Graph } from '../model/graph.js';
import type { ValidationIssue } from '../model/validation.js';
import { checkReviewOverdue, checkAspectEffectiveNowhere } from './checks/aspect-contracts.js';
import { checkOrphanedAspects } from './checks/aspects.js';
import { hashString } from '../io/hash.js';

/** One advisable attention item, bound to the exact evidence it rests on. */
export interface Nomination {
  /** Stable identity: `<classKey>:<key>` (e.g. `overdue-review-by:what-why-next`). */
  id: string;
  /** Class precedence for ordering (lower = higher priority). Task 5 refines. */
  classRank: number;
  /** One-line statement of the item. */
  what: string;
  /** Why it matters — carries the concrete evidence and its provenance. */
  why: string;
  /** The exact human action, noting that it requires the user's approval. */
  next: string;
  /** sha256 of the canonical JSON of the evidence snapshot (io/hash.hashString). */
  evidenceHash: string;
  /** Recency key for tie-break (ISO). NOT part of the evidence hash. */
  evidenceTs: string;
}

/**
 * A risky suppress marker surfaced by the live suppression scan. Gathered at the
 * CLI boundary (the filesystem walk lives there) and injected so this engine
 * module stays I/O-free and deterministic. Mapped 1:1 to a nomination.
 */
export interface SuppressAnomaly {
  /** Repo-relative POSIX path of the file carrying the marker. */
  file: string;
  /** 1-based line of the marker. */
  line: number;
  /** The aspect id the marker names (`*` for a wildcard). */
  aspectId: string;
  /** Why the marker is risky: `wildcard` | `typo` | `inert` | `unbounded`. */
  risk: string;
  /** The marker's reason text, when present. */
  reason?: string;
}

/** Inputs beyond the graph that the live nomination sources need. */
export interface NominationSources {
  /** Injected UTC clock — the engine keeps no `Date.now`; the overdue source
   *  compares `review_by` against this. */
  todayUtc: Date;
  /** Risky suppress markers gathered live at the CLI boundary. Absent → none. */
  suppressAnomalies?: SuppressAnomaly[];
}

/** Class precedence per source (lower = higher priority). Task 5 refines these. */
const CLASS_RANK = {
  deadAttach: 10,
  orphaned: 20,
  overdueReviewBy: 30,
  suppressAnomaly: 40,
} as const;

/**
 * Canonical JSON of a flat evidence snapshot: keys emitted in sorted order so the
 * hash is independent of property-insertion order. The snapshots are shallow
 * records of strings / numbers, so a one-level key sort is sufficient.
 */
function canonicalJson(snapshot: Record<string, string | number>): string {
  const sortedKeys = Object.keys(snapshot).sort();
  const ordered: Record<string, string | number> = {};
  for (const key of sortedKeys) ordered[key] = snapshot[key];
  return JSON.stringify(ordered);
}

/** sha256 hex of a flat evidence snapshot's canonical JSON. */
function hashEvidence(snapshot: Record<string, string | number>): string {
  return hashString(canonicalJson(snapshot));
}

/** The aspect id an aspect-scoped validation issue carries on its `aspects/<id>` nodePath. */
function aspectIdFromIssue(issue: ValidationIssue): string | undefined {
  const nodePath = issue.nodePath;
  if (typeof nodePath !== 'string') return undefined;
  const prefix = 'aspects/';
  return nodePath.startsWith(prefix) ? nodePath.slice(prefix.length) : undefined;
}

/**
 * Phrase the human action so it reads as a nomination that needs sign-off — the
 * check's own `next` plus an explicit note that acting requires the user's
 * approval (no advise decision is ever taken silently).
 */
function asApprovalNext(next: string): string {
  return `${next} This requires your approval.`;
}

/**
 * Build the LIVE nominations from the current graph. Pure and deterministic given
 * `graph` and `sources` (the only clock is the injected `sources.todayUtc`).
 * Ordered by `classRank` then `evidenceTs` (newest first) so callers get a stable
 * ordering without re-sorting.
 */
export function buildNominations(graph: Graph, sources: NominationSources): Nomination[] {
  const nominations: Nomination[] = [];
  const todayIso = sources.todayUtc.toISOString();

  // --- overdue review_by: an aspect running past its standing review date ---
  for (const issue of checkReviewOverdue(graph, sources.todayUtc)) {
    const aspectId = aspectIdFromIssue(issue);
    if (aspectId === undefined) continue;
    const aspect = graph.aspects.find((a) => a.id === aspectId);
    const reviewBy = aspect?.reviewBy ?? '';
    nominations.push({
      id: `overdue-review-by:${aspectId}`,
      classRank: CLASS_RANK.overdueReviewBy,
      what: issue.messageData.what,
      why: issue.messageData.why,
      next: asApprovalNext(issue.messageData.next),
      evidenceHash: hashEvidence({ source: 'overdue-review-by', aspectId, reviewBy }),
      // The review-by day is the item's natural recency key.
      evidenceTs: reviewBy !== '' ? `${reviewBy}T00:00:00.000Z` : todayIso,
    });
  }

  // --- dead-attach: a rule source effective on zero nodes (looks enforced, isn't) ---
  for (const issue of checkAspectEffectiveNowhere(graph)) {
    const aspectId = aspectIdFromIssue(issue);
    if (aspectId === undefined) continue;
    nominations.push({
      id: `dead-attach:${aspectId}`,
      classRank: CLASS_RANK.deadAttach,
      what: issue.messageData.what,
      why: issue.messageData.why,
      next: asApprovalNext(issue.messageData.next),
      evidenceHash: hashEvidence({ source: 'dead-attach', aspectId }),
      evidenceTs: todayIso,
    });
  }

  // --- orphaned aspect: defined but referenced by no node / type / flow ---
  for (const issue of checkOrphanedAspects(graph)) {
    const aspectId = aspectIdFromIssue(issue);
    if (aspectId === undefined) continue;
    nominations.push({
      id: `orphaned-aspect:${aspectId}`,
      classRank: CLASS_RANK.orphaned,
      what: issue.messageData.what,
      why: issue.messageData.why,
      next: asApprovalNext(issue.messageData.next),
      evidenceHash: hashEvidence({ source: 'orphaned-aspect', aspectId }),
      evidenceTs: todayIso,
    });
  }

  // --- suppress-marker anomalies: risky waivers (wildcard / typo / inert / unbounded) ---
  for (const anomaly of sources.suppressAnomalies ?? []) {
    const provenance = `${anomaly.file}:${anomaly.line}`;
    const reasonQuote = anomaly.reason ? ` The marker's stated reason is "${anomaly.reason}".` : '';
    nominations.push({
      id: `suppress-anomaly:${provenance}`,
      classRank: CLASS_RANK.suppressAnomaly,
      what: `A suppress marker at ${provenance} is risky (${anomaly.risk}).`,
      why:
        `The waiver "${anomaly.aspectId}" at ${provenance} is classified ${anomaly.risk}, ` +
        `so it silences more than it should or has no effect.${reasonQuote}`,
      next: asApprovalNext(
        `Re-examine the waiver at ${provenance} — narrow it to the specific aspect, ` +
          `close its range, or remove it.`,
      ),
      evidenceHash: hashEvidence({
        source: 'suppress-anomaly',
        file: anomaly.file,
        line: anomaly.line,
        aspectId: anomaly.aspectId,
        risk: anomaly.risk,
      }),
      evidenceTs: todayIso,
    });
  }

  nominations.sort((a, b) =>
    a.classRank !== b.classRank
      ? a.classRank - b.classRank
      : a.evidenceTs < b.evidenceTs
        ? 1
        : a.evidenceTs > b.evidenceTs
          ? -1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
  );

  return nominations;
}
