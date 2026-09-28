/**
 * source/cli/src/core/advise-shared.ts — the pieces every nomination source
 * shares: the `Nomination` model and the plain-data input shapes the satellite
 * sources consume, the class precedence table, the RZ-5 injection hygiene
 * (`neutralizeControls`, `quoteData`), the evidence hash and the one phrasing
 * of a human sign-off.
 *
 * They live here, not in the engine (`advise-nominations.ts`), so the engine
 * can import each satellite source (imported, package-update, family,
 * architecture-cut) while every satellite imports only this module: the
 * dependency runs one way and the cluster has no runtime import cycle. The
 * engine re-exports them, so existing callers keep importing from where they
 * always did.
 */

import { hashString } from '../io/hash.js';

/** One advisable attention item, bound to the exact evidence it rests on. */
export interface Nomination {
  /** Stable identity: `<classKey>:<key>` (e.g. `overdue-review-by:what-why-next`). */
  id: string;
  /** Class precedence for ordering (lower = higher priority). */
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
  /**
   * Optional finer-than-evidenceTs ordering WITHIN one classRank tier — lower
   * value sorts first, mirroring classRank's own ascending convention. Absent
   * (every class except type-covered-churn) leaves buildNominations' sort to
   * fall through to evidenceTs then id exactly as it did before this field
   * existed. type-covered-churn sets it to the negative of the file's churn
   * count, so the busiest file sorts first instead of the id-alphabetical order
   * every other class shares by default — see typeCoveredChurnNominations.
   */
  rankWithinClass?: number;
  /**
   * Where the item came from, when it did not come from this graph's own
   * signals — the producer that measured it and the commit it measured at.
   *
   * It exists so a reader can always tell what another tool observed from what
   * this graph concluded. Absent on every nomination the graph derives itself,
   * which is what makes its presence meaningful rather than decorative.
   */
  provenance?: { source: string; at: string | null };
  /**
   * The identities this item carried before its class was renamed — each a
   * retired id and the evidence hash the retired class bound for the SAME
   * evidence. A decision stored on disk under a retired identity still governs
   * the item (core/advise-feed), and a dismiss or defer naming a retired id
   * still finds it; a new decision is always recorded under the current `id`.
   * Absent on every class that was never renamed.
   */
  aliases?: ReadonlyArray<{ id: string; evidenceHash: string }>;
}

/**
 * One family-without-law candidate, as read from `.family-candidates.json` (the
 * offline miner's output — telemetry, never an engine input). Every string field
 * is UNTRUSTED repo-derived DATA: it is rendered through `quoteData` (RZ-5), never
 * interpolated raw into an instruction sentence.
 */
export interface FamilyCandidate {
  /** The miner's deterministic stable id (`family-<lang>-<key>`). */
  id: string;
  /** The language stratum the family was mined within. */
  language: string;
  /** Repo-relative POSIX member paths (sorted by the miner). */
  members: string[];
  /** The fitted applicability predicate cut from the cluster (glob or regex). */
  fittedPredicate: { kind: string; value: string };
  /** The `when`/`scope.files` skeleton the miner drafted for the family. */
  scopeFilesDraft: string[];
  /** Cluster size (member count) recorded by the miner. */
  clusterSize: number;
  /** Robustness tightness score (0..1) recorded by the miner. */
  tightness: number;
}

/**
 * The FRESH family-candidates payload the family-without-law nomination class
 * consumes. Produced by `parseFamilyCandidates` (present-or-omit + freshness gate);
 * absent → the class is silently omitted.
 */
export interface FamilyCandidatesData {
  /** The miner's injected timestamp — the `local analysis since <ts>` provenance. */
  ts: string;
  /**
   * The file the families came from, when it is not the shared `.family-candidates.json`:
   * each producer writes its own `.family-candidates.<producer>.json`, so one producer's
   * run can never erase another's families. Named in the nomination's provenance.
   */
  file?: string;
  /**
   * Who measured (`grain`, `yggdrasil-miner`, …), when the file says. Two producers
   * write this same document from two different oracles, so a nomination attributes
   * it. UNTRUSTED repo-derived DATA, rendered through `quoteData`. Absent on a file
   * written before producers named themselves.
   */
  producer?: string;
  /**
   * What "without a law" meant for that producer (`no-certified-convention`,
   * `no-narrow-aspect`, …), when the file says. UNTRUSTED DATA, like `producer`.
   */
  gate?: string;
  /** The fresh, well-formed candidate families (possibly empty → no items). */
  families: FamilyCandidate[];
}

/**
 * One non-trivial cycle in the structural quotient at a given depth — a group of
 * two or more module blocks that mutually depend (the architecture-cut signal).
 * Derived at the CLI boundary from the committed graph's DECLARED relations only
 * (no relation pass), so it is reproducible across machines. Block ids are
 * UNTRUSTED repo-derived DATA, rendered through `quoteData` (RZ-5).
 */
export interface ArchitectureCutCycle {
  /** The quotient depth at which the cycle is visible (provenance). */
  depth: number;
  /** The ≥ 2 module block ids that form the loop, sorted. */
  blocks: string[];
}

/**
 * Class precedence per source (lower = higher priority). Spec §7.2:
 *   drill-MISS > suppress anomaly > effective-nowhere > orphaned > overdue review_by,
 * with EVERY T1 class (promotion, sharpen, decorative-rule, unguarded-hot-spot)
 * below EVERY T0 class.
 */
export const CLASS_RANK = {
  drillMiss: 10,
  suppressAnomaly: 20,
  // Two decisions in force that each replaced the same log entry: a contradiction
  // the graph holds right now, read from its own files, so it ranks with T0.
  logSupersedesConflict: 25,
  effectiveNowhere: 30,
  orphaned: 40,
  overdueReviewBy: 50,
  // Decisions in force that a type's nodes read past the budget: live from the
  // graph's own logs like T0, but a matter of weight rather than of anything
  // being wrong, so it ranks last among them.
  typeDecisionBudget: 55,
  // --- T1: below all T0 ---
  promotion: 60,
  sharpen: 70,
  decorativeRule: 80,
  unguardedHotSpot: 90,
  typeCoveredChurnCluster: 95,
  // --- T2: below all T0 and all T1 (spec §7.2). Both classes share T1's decision
  //     stream (λ) and the joint cap; family ranks above architecture-cut. ---
  familyWithoutLaw: 100,
  architectureCut: 110,
  // A declared relation no import backs: a whole-codebase observation like the
  // two above, read from the relation pass, and the weakest of them — often the
  // relation is true and the extractor simply cannot see it.
  relationDeclaredUnused: 120,
  // --- Imported: a proposal another tool measured. Ranked BELOW everything this
  //     graph derives itself, deliberately — an outside proposal is a suggestion
  //     to weigh, never something that should push the graph's own findings down
  //     the feed.
  imported: 200,
  // --- A newer version of an installed package: news from outside, about rules
  //     from outside. Ranked below every class the graph derives for itself, for
  //     the same reason `imported` is — nothing another repository published
  //     should push a finding this graph made about its own code down the feed.
  //     Placed just ABOVE `imported` rather than below it because an imported
  //     proposal is the feed's documented last item, and because this one is at
  //     least concrete: it names a version and a command, where a proposal asks
  //     for a judgement.
  packageUpdate: 190,
} as const;

/** Bound the length of any quoted repo-derived value rendered into the feed. */
const MAX_QUOTED = 200;

/**
 * Neutralize every control character in an untrusted repo-derived string. Each C0
 * control (including CR / LF, ESC, NUL and the whole 0x00–0x1F range) and every
 * DEL / C1 code point (0x7F–0x9F) is replaced with a space, then runs of
 * whitespace are collapsed and the result trimmed. The `\s+` collapse also folds
 * the Unicode line/paragraph separators (U+2028 / U+2029) and NEL-adjacent
 * whitespace, so no escape sequence or line break can survive to read as an
 * instruction to the agent reading the feed. This is the injection-neutralization
 * core with NO length bound — safe for a full authored message whose only
 * untrusted part is a length-bounded id.
 */
export function neutralizeControls(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Render an untrusted repo-derived string as SAFE inline DATA: neutralize control
 * characters (neutralizeControls) then length-bound the result. The caller wraps
 * the return value in quotes — this keeps repo text as DATA, not an instruction to
 * the agent reading the feed. Exported so the CLI boundary sanitizes the same way
 * when it renders a nomination's stable id (which embeds raw repo strings) onto
 * the opt-in id / dismiss / defer surfaces.
 */
export function quoteData(raw: string): string {
  const out = neutralizeControls(raw);
  return out.length > MAX_QUOTED ? `${out.slice(0, MAX_QUOTED)}…` : out;
}

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
export function hashEvidence(snapshot: Record<string, string | number>): string {
  return hashString(canonicalJson(snapshot));
}

/**
 * Phrase the human action so it reads as a nomination that needs sign-off — the
 * check's own `next`, then the one phrase every human sign-off in the CLI is
 * written in: ask the user to approve it (no advise decision is ever taken
 * silently). "You" in the CLI's output is always the operator — an agent as
 * often as a person — so the sign-off names the user, and never says "your
 * approval", which an agent would read as licence to approve it itself.
 */
export function asApprovalNext(next: string): string {
  if (/ask the user to approve/i.test(next)) return next;
  return `${next.replace(/\.\s*$/, '')} — ask the user to approve it first.`;
}
