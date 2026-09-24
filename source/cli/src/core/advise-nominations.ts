/**
 * source/cli/src/core/advise-nominations.ts — the `Nomination` model,
 * `buildNominations` (the graph's live attention signals turned into a stable,
 * evidence-bound nomination list) and `buildAttention` (the one-line-per-class
 * attention aggregates). Both are PURE and deterministic: the only clock is the
 * injected `sources.todayUtc`, and every non-graph input (suppress-marker
 * anomalies, drill-result telemetry, verdict-event telemetry, the C7 tunnel
 * count) arrives as a plain-data PARAMETER — this engine never imports a reader
 * or touches the filesystem. The CLI boundary owns the I/O and passes the data in.
 *
 * A nomination is one advisable attention item: a stable `id`, a `what`/`why`/
 * `next` triple, and an `evidenceHash` — the sha256 of a canonical snapshot of
 * exactly the evidence the item rests on. Binding a decision (dismiss / defer /
 * done — see io/advise-decisions-store) to that hash is what lets a dismissed
 * item stay hidden while its evidence is unchanged, yet return the moment the
 * evidence moves.
 *
 * INJECTION HYGIENE (RZ-5, security-relevant): the advise feed is read by every
 * agent each session. Every repo-derived string (a suppress reason, a drill case
 * name, an aspect id, a unit key, a path) is UNTRUSTED DATA. It is rendered as
 * QUOTED DATA WITH PROVENANCE, never interpolated into a narrator-voice
 * instruction sentence, and every value is passed through `quoteData` first so a
 * control byte, ANSI escape, or embedded newline can never break out of its
 * quotes and read as an instruction to the consuming agent. `next` always names
 * the exact human action and always ends by noting it requires the user's
 * approval — no advise decision is ever taken silently.
 *
 * Source tiers (spec §7.2):
 *   T0 structural (live, from the graph): drill MISS (T0-local), suppress-marker
 *     anomalies, dead-attach (aspect-effective-nowhere), orphaned aspects,
 *     overdue review_by.
 *   T1 (from local telemetry, thin-data honesty labels — RZ-21): promotion
 *     (an advisory rule with a clean recorded record), sharpen (a rule the
 *     reviewer judged the SAME input inconsistently under --repeat), decorative-rule
 *     (an enforceable rule never once violated at exposure, whose independent
 *     corroborating signals agree it may be safe to demote — under the anti-Goodhart
 *     covenant), uncovered-hot-spot (a node whose mapped source churns yet has no
 *     rule beyond drafts covering it — churn signal from git history, injected), and
 *     type-covered-churn (a type-covered file — no owning node — that has been
 *     EDITED since the commit that created it, and whose matched type genuinely
 *     enforces something on it; since it has no node, no node-level rule can
 *     ever attach to it, so the type tier alone carries its enforcement. Ranked
 *     just below uncovered-hot-spot; within the class, ranked by churn
 *     descending — the busiest file first, never id-alphabetical). Every T1
 *     class ranks BELOW every T0 class.
 *   T2 (below all of T0/T1, sharing T1's decision stream and the joint cap):
 *     family-without-law (a tight cluster of files sharing no narrow rule, read
 *     from the offline miner's `.family-candidates.json` — present-or-omit,
 *     freshness-gated) and architecture-cut (module groups that mutually depend,
 *     found as non-trivial cycles in the structural quotient — declared-only, so
 *     reproducible across machines). Both end at a printed proposal (V2), never an
 *     aspect; every repo-derived string is quoted data with provenance (RZ-5).
 */

import type { Graph } from '../model/graph.js';
import type { AspectDef } from '../model/graph.js';
import type { ValidationIssue } from '../model/validation.js';
import { checkReviewOverdue, checkAspectEffectiveNowhere } from './checks/aspect-contracts.js';
import type { TypeCoverageInput } from './pairs.js';
import { checkOrphanedAspects } from './checks/aspects.js';
import { hasNonDraftEffectiveAspects } from './graph/aspects.js';
import { ruleHashFor } from './pair-inputs.js';
import { hashString } from '../io/hash.js';
import { computeAspectHealthSignals } from './aspect-health-signals.js';
import type { DrillResultLine } from '../io/drill-results-store.js';
import type { VerdictEvent } from '../io/events-store.js';
import type { ImportedAdvice } from '../io/advise-imported-store.js';
import { importedNominations } from './advise-imported-nominations.js';
import { packageUpdateNominations } from './advise-package-nominations.js';
import type { PackageUpdateSignal } from './advise-package-nominations.js';
export type { PackageUpdateSignal } from './advise-package-nominations.js';
import { architectureCutNominations } from './advise-architecture-cut.js';
import { familyNominations } from './advise-family-nominations.js';
import { count } from '../utils/count.js';
export {
  parseFamilyCandidates,
  SUPPORTED_CANDIDATES_V,
  CANDIDATES_SHARD_SCHEMA,
} from './advise-family-nominations.js';

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

/** Inputs beyond the graph that the live nomination sources need. */
export interface NominationSources {
  /** Injected UTC clock — the engine keeps no `Date.now`; the overdue source
   *  compares `review_by` against this. */
  todayUtc: Date;
  /** Risky suppress markers gathered live at the CLI boundary. Absent → none. */
  suppressAnomalies?: SuppressAnomaly[];
  /**
   * Drill-result telemetry (T0-local drill MISS). Absent → none. The CLI boundary
   * pre-filters this to ACTIONABLE lines only — an in-repo (`dev`) run whose
   * `(aspect, case)` still lives in the aspect's current `drills/` corpus (see
   * drill-runner.filterInCorpusDevDrills). Holdout measurements and orphaned cases
   * (removed / renamed, or an aspect with no corpus) are dropped there, so this
   * engine never nominates a drill the graph can no longer re-run or retire.
   */
  drillResults?: DrillResultLine[];
  /**
   * Refusal-expecting (`violates-*`) cases committed in each aspect's drill
   * corpus (aspectId → count). Drill evidence that survives a clone, unlike the
   * gitignored drill-result telemetry; a rule with any is never nominated for
   * demotion as having "no regression drill on record".
   */
  committedViolatesCasesByAspect?: Map<string, number>;
  /** Verdict-event telemetry (T1 promotion / sharpen / decorative-rule). Absent → none. */
  verdictEvents?: VerdictEvent[];
  /**
   * Current expected units per aspect (aspectId → unit keys), from the graph's
   * pairs. Required for the decorative-rule source's shrinking-attach-set signal;
   * absent → that source does not run (fail-safe: no demotion nominated).
   */
  currentUnitsByAspect?: Map<string, Set<string>>;
  /**
   * Live non-wildcard suppress-marker counts per aspect. Required for the
   * decorative-rule source's no-suppress-history signal; absent → that source does
   * not run.
   */
  suppressCountsByAspect?: Map<string, number>;
  /**
   * Per-node churn (window commit counts + a capped file sample) assembled at the
   * CLI boundary from git history, paired with `churnWindow` (the window those
   * counts were measured over). BOTH absent → churn is UNKNOWN (no git / shallow
   * clone) → the uncovered-hot-spot class is SILENT, never fabricated as
   * zero-and-fired or churn-present. Both present → the class runs.
   */
  churnByNode?: Map<string, { churn: number; files: string[] }>;
  /** The window size (commits) the churn counts were measured over; see churnByNode. */
  churnWindow?: number;
  /**
   * The FRESH family-without-law candidates (T2 class A), read + freshness-gated at
   * the CLI boundary via `parseFamilyCandidates`. Absent (no file, or a stale/garbled
   * one) → the class is silently omitted. Present-but-empty → the class runs and
   * produces nothing.
   */
  familyCandidates?: FamilyCandidatesData | FamilyCandidatesData[];
  /**
   * The non-trivial structural-quotient cycles (T2 class B), computed at the CLI
   * boundary from the committed graph's DECLARED relations only (no relation pass —
   * reproducible across machines). Absent / empty → no architecture-cut items.
   */
  architectureCutCycles?: ArchitectureCutCycle[];
  /**
   * The type-level classification lattice (coverage.type_level), classified once
   * for this `yg advise` invocation — the SAME object `gatherCurrentUnits` feeds
   * into its own `computeExpectedPairs` call. Threaded into the dead-attach
   * source (`checkAspectEffectiveNowhere`) so it agrees with `yg check`: a rule
   * effective only on files enforced by their architecture type (no owning
   * component) is live law, not a false dead-attach nomination that would offer
   * to park a rule `yg check` reports enforced. Absent (flag off, or
   * classification failed) ⇒ the one-argument call every existing caller made,
   * unchanged.
   */
  typeCoverage?: TypeCoverageInput;
  /**
   * Installed packages whose source publishes a version this repository does not
   * have, read at the CLI boundary. Absent → none, and the class is silent.
   *
   * A package whose source could NOT be reached must be absent from this list
   * entirely, never present with an empty version list: an unreachable source
   * knows nothing, and an item claiming there is no newer version would be a
   * finding this run never actually made.
   */
  packageUpdates?: PackageUpdateSignal[];
  /**
   * Proposals another tool measured and handed over, read from the committed
   * register at the CLI boundary. Absent → none, and the class is silent.
   * Importing is not accepting: these arrive in the feed as proposals with the
   * same standing as one the graph nominated itself, and every decision about
   * them stays the user's.
   */
  importedAdvice?: ImportedAdvice[];
  /**
   * Per-type-covered-file churn (window commit count + the file's matched
   * classifying type), assembled at the CLI boundary from the SAME git history
   * `churnByNode` uses, keyed by file path directly — a type-covered file has no
   * owning node, so it cannot be counted via `churnByNode`'s owner-keyed map (see
   * `countChurnByTypeCoveredFile`'s own doc for the trap this avoids). Absent →
   * churn is UNKNOWN (no git, or the type-level tier is off) → the
   * type-covered-churn class is SILENT, never fabricated. Present (even empty) →
   * the class runs.
   */
  typeCoveredChurnByFile?: Map<string, { churn: number; typeId: string }>;
  /**
   * Same-type import edges among type-covered files (the live type-relation
   * gate, restricted to pairs where BOTH endpoints are type-covered and share the
   * SAME matched type) — evidence that a CLUSTER of files, not just one churning
   * file, carries real weight the type tier alone must enforce. Absent or empty →
   * the class still runs on single-file evidence, just without the cluster
   * upgrade to its `why`.
   */
  typeCoveredEdges?: Array<{ from: string; to: string }>;
  /**
   * The subset of `typeCoveredChurnByFile`'s files whose matched type genuinely
   * enforces something on THEM — at least one non-draft rule that is attached,
   * whose `when` is satisfied, and that actually applies at file granularity
   * (the SAME fact `yg owner --file` answers with "Enforced by its architecture
   * type" versus "nothing from it enforces on this file"). A file absent from
   * this set matches a type that carries no enforcement for it, so nominating a
   * component there would claim the type tier is carrying something it is not.
   * Required (alongside `typeCoveredChurnByFile`) for the class to run at all —
   * absent (classification failed) ⇒ SILENT, never fabricated as enforced or
   * unenforced for a file this run could not verify.
   */
  typeEnforcedFiles?: Set<string>;
}

/**
 * Class precedence per source (lower = higher priority). Spec §7.2:
 *   drill-MISS > suppress anomaly > dead-attach > orphaned > overdue review_by,
 * with EVERY T1 class (promotion, sharpen, decorative-rule, uncovered-hot-spot)
 * below EVERY T0 class.
 */
export const CLASS_RANK = {
  drillMiss: 10,
  suppressAnomaly: 20,
  deadAttach: 30,
  orphaned: 40,
  overdueReviewBy: 50,
  // --- T1: below all T0 ---
  promotion: 60,
  sharpen: 70,
  decorativeRule: 80,
  uncoveredHotSpot: 90,
  typeCoveredChurnCluster: 95,
  // --- T2: below all T0 and all T1 (spec §7.2). Both classes share T1's decision
  //     stream (λ) and the joint cap; family ranks above architecture-cut. ---
  familyWithoutLaw: 100,
  architectureCut: 110,
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

/** Promotion needs at least this many recorded clean approvals to be nominated. */
const PROMOTION_MIN_APPROVED = 1;
/** Below this many recorded verdicts, a T1 item carries the `small-N` honesty label. */
const THIN_DATA_N = 20;
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
function neutralizeControls(raw: string): string {
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

/** Join thin-data honesty labels into a ` [a; b]` suffix, or '' when none apply. */
function honestySuffix(labels: string[]): string {
  return labels.length > 0 ? ` [${labels.join('; ')}]` : '';
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

/** The aspect id an aspect-scoped validation issue carries on its `aspects/<id>` nodePath. */
function aspectIdFromIssue(issue: ValidationIssue): string | undefined {
  const nodePath = issue.nodePath;
  if (typeof nodePath !== 'string') return undefined;
  const prefix = 'aspects/';
  return nodePath.startsWith(prefix) ? nodePath.slice(prefix.length) : undefined;
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

/** The rule-source filename that carries an aspect's current hash. */
function ruleFilenameFor(aspect: AspectDef): 'content.md' | 'check.mjs' {
  return aspect.reviewer?.type === 'deterministic' ? 'check.mjs' : 'content.md';
}

// ---------------------------------------------------------------------------
// T0-local — drill MISS (from the local drill-results telemetry sidecar)
// ---------------------------------------------------------------------------

/**
 * Keep only the LATEST drill line per (aspect, case) — the sidecar is append-only,
 * so a case re-run after a fix leaves an old MISS behind that must not resurface.
 * "Latest" is by `ts` (append order breaks ties: a later element wins).
 */
function latestDrillPerCase(results: DrillResultLine[]): DrillResultLine[] {
  const latest = new Map<string, DrillResultLine>();
  for (const r of results) {
    const key = `${r.aspect}\u0000${r.case}`;
    const prev = latest.get(key);
    if (prev === undefined || r.ts >= prev.ts) latest.set(key, r);
  }
  return [...latest.values()];
}

/** A drill line is a MISS iff a case that MUST be refused was instead satisfied. */
function isDrillMiss(line: DrillResultLine): boolean {
  return line.expect === 'refused' && line.got === 'satisfied';
}

/**
 * Turn recorded drill MISSes into T0-local nominations. The caller has already
 * dropped every non-actionable line (holdout measurements and orphaned cases — see
 * NominationSources.drillResults), so every line reaching here names a case that
 * still lives in the aspect's current corpus. A MISS is a live alarm ONLY while the
 * drill's recorded `ruleHash` still matches the current rule source; once the rule
 * has changed the recorded outcome no longer reflects it, so the item renders as a
 * benign `stale — re-run yg drill` note rather than an alarm (never a false live
 * signal). Always labeled `local diagnostic result` — a diagnostic outcome, never a
 * live rule verdict.
 */
function drillMissNominations(graph: Graph, results: DrillResultLine[]): Nomination[] {
  const out: Nomination[] = [];
  for (const line of latestDrillPerCase(results)) {
    if (!isDrillMiss(line)) continue;

    const aspect = graph.aspects.find((a) => a.id === line.aspect);
    // Fresh iff the aspect still exists AND its current rule source hashes to the
    // hash recorded at drill time. A vanished aspect or a changed rule ⇒ stale.
    const fresh =
      aspect !== undefined && ruleHashFor(aspect, ruleFilenameFor(aspect)) === line.ruleHash;

    const aspectQ = quoteData(line.aspect);
    const caseQ = quoteData(line.case);
    const sinceLabel = `local diagnostic result since ${quoteData(line.ts)}`;

    const what = fresh
      ? `A regression case for rule '${aspectQ}' is no longer caught.`
      : `A recorded regression MISS for rule '${aspectQ}' is stale.`;
    const why = fresh
      ? `${sinceLabel}: case '${caseQ}' expects a refusal but the current rule returned satisfied — a MISS. This is a recorded drill outcome, not a live rule verdict.`
      : `${sinceLabel}: case '${caseQ}' recorded a MISS, but the rule source has changed since, so the result no longer reflects the current rule.`;
    const next = fresh
      ? asApprovalNext(
          `Re-examine rule '${aspectQ}' against case '${caseQ}' — tighten the rule so it catches this case again, or retire the case if it no longer applies.`,
        )
      : asApprovalNext(`stale — re-run yg drill for rule '${aspectQ}' to refresh this result.`);

    out.push({
      id: `drill-miss:${line.aspect}/${line.case}`,
      classRank: CLASS_RANK.drillMiss,
      what,
      why,
      next,
      // Bind to the recorded rule hash: when the rule changes a fresh drill run
      // records a new hash, so a dismissed MISS returns as new evidence.
      evidenceHash: hashEvidence({
        source: 'drill-miss',
        aspect: line.aspect,
        case: line.case,
        ruleHash: line.ruleHash,
        fresh: fresh ? 1 : 0,
      }),
      evidenceTs: line.ts,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — promotion (advisory rule with a clean recorded record)
// ---------------------------------------------------------------------------

/**
 * Nominate an ADVISORY rule for promotion to enforced when its recorded fill
 * telemetry is clean: at least `PROMOTION_MIN_APPROVED` approvals and ZERO
 * refusals. Thin data is never hidden — every item carries `local telemetry
 * since <ts>`, `small-N` when the sample is under `THIN_DATA_N`, and `regime
 * unknown` when an LLM aspect's telemetry lacks the judge identity (RZ-21). This
 * is the F1/F2 advisory→enforced exit path; the signature stays human.
 */
function promotionNominations(graph: Graph, events: VerdictEvent[]): Nomination[] {
  const out: Nomination[] = [];
  for (const aspect of graph.aspects) {
    if ((aspect.status ?? 'enforced') !== 'advisory') continue;

    const fills = events.filter((e) => e.source === 'fill' && e.aspectId === aspect.id);
    if (fills.length === 0) continue;

    let approved = 0;
    let refused = 0;
    let firstTs: string | undefined;
    let lastTs = '';
    let judgeMissing = false;
    for (const e of fills) {
      if (e.disposition === 'approved') approved += 1;
      else if (e.disposition === 'refused') refused += 1;
      if (typeof e.ts === 'string') {
        if (firstTs === undefined || e.ts < firstTs) firstTs = e.ts;
        if (e.ts > lastTs) lastTs = e.ts;
      }
      if (e.kind === 'llm' && e.judge === undefined) judgeMissing = true;
    }
    if (refused !== 0 || approved < PROMOTION_MIN_APPROVED) continue;

    const labels: string[] = [`local telemetry since ${quoteData(firstTs ?? lastTs)}`];
    if (approved < THIN_DATA_N) labels.push('small-N');
    if (judgeMissing) labels.push('reviewer unknown');

    const aspectQ = quoteData(aspect.id);
    out.push({
      id: `promotion:${aspect.id}`,
      classRank: CLASS_RANK.promotion,
      what: `Advisory rule '${aspectQ}' has a clean recorded record.`,
      why: `${approved} approved and 0 refused verdicts recorded for rule '${aspectQ}' while advisory${honestySuffix(labels)}.`,
      next: asApprovalNext(
        `Propose promoting rule '${aspectQ}' from advisory to enforced, citing these numbers.`,
      ),
      // Numbers are the evidence: a new refusal or more approvals moves the hash,
      // so a dismissed promotion returns when the record changes.
      evidenceHash: hashEvidence({
        source: 'promotion',
        aspectId: aspect.id,
        approved,
        refused,
      }),
      evidenceTs: lastTs !== '' ? lastTs : (firstTs ?? ''),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — sharpen (a rule the reviewer judged the same input inconsistently)
// ---------------------------------------------------------------------------

/** Per-(aspect, unit, input, judge) vote tally from diagnostic telemetry. */
interface DiagTally {
  aspectId: string;
  unitKey: string;
  promptHash: string;
  satisfied: number;
  total: number;
  lastTs: string;
  judgeMissing: boolean;
}

/**
 * Nominate `sharpen-content.md` when the reviewer judged the SAME prompt
 * inconsistently across `yg aspect-test` runs — a stable split vote is
 * measured rule ambiguity (wave-3 C6.3a). Reads ONLY `source:'diag'` events
 * (mixing regimes would corrupt the statistic), and counts votes together only
 * when they were cast on the same input by the same judge: the tally key is
 * (aspect, unit, promptHash, judge). Without the hash, the ordinary fix loop —
 * refused, fix the code, satisfied — read as a split vote on one input, and
 * nominated a rule that had judged consistently. A diag line with no
 * promptHash (written before the field existed) cannot say what it judged,
 * and is left out. One nomination per aspect, citing its most-ambiguous
 * input; thin-data honesty labels as for promotion.
 */
function sharpenNominations(events: VerdictEvent[]): Nomination[] {
  const tallies = new Map<string, DiagTally>();
  for (const e of events) {
    if (e.source !== 'diag' || e.votes === undefined) continue;
    if (typeof e.promptHash !== 'string' || e.promptHash === '') continue;
    const judgeKey = e.judge !== undefined ? `${e.judge.provider}/${e.judge.model}` : '';
    const key = `${e.aspectId}\u0000${e.unitKey}\u0000${e.promptHash}\u0000${judgeKey}`;
    let t = tallies.get(key);
    if (t === undefined) {
      t = {
        aspectId: e.aspectId,
        unitKey: e.unitKey,
        promptHash: e.promptHash,
        satisfied: 0,
        total: 0,
        lastTs: '',
        judgeMissing: false,
      };
      tallies.set(key, t);
    }
    t.satisfied += e.votes.satisfied;
    t.total += e.votes.total;
    if (typeof e.ts === 'string' && e.ts > t.lastTs) t.lastTs = e.ts;
    if (e.judge === undefined) t.judgeMissing = true;
  }

  // A split vote (0 < satisfied < total, with N >= 2) is the ambiguity signal.
  // Keep, per aspect, the single most-split unit (closest to a 50/50 tie).
  const worstPerAspect = new Map<string, DiagTally>();
  for (const t of tallies.values()) {
    if (t.total < 2 || t.satisfied <= 0 || t.satisfied >= t.total) continue;
    const skew = Math.abs(t.satisfied / t.total - 0.5);
    const cur = worstPerAspect.get(t.aspectId);
    if (cur === undefined || skew < Math.abs(cur.satisfied / cur.total - 0.5)) {
      worstPerAspect.set(t.aspectId, t);
    }
  }

  const out: Nomination[] = [];
  for (const t of worstPerAspect.values()) {
    const labels: string[] = [`local telemetry since ${quoteData(t.lastTs)}`];
    if (t.total < THIN_DATA_N) labels.push('small-N');
    if (t.judgeMissing) labels.push('reviewer unknown');

    const aspectQ = quoteData(t.aspectId);
    const unitQ = quoteData(t.unitKey);
    const refusedVotes = t.total - t.satisfied;
    out.push({
      id: `sharpen:${t.aspectId}`,
      classRank: CLASS_RANK.sharpen,
      what: `Rule '${aspectQ}' judged the same input inconsistently.`,
      why: `reviewed ${t.total} times on unit '${unitQ}' with the same input and the same reviewer, ${t.satisfied} satisfied and ${refusedVotes} refused — a split vote is measured rule ambiguity${honestySuffix(labels)}.`,
      next: asApprovalNext(
        `Propose sharpening the wording of rule '${aspectQ}' so the reviewer judges this case the same way every time.`,
      ),
      evidenceHash: hashEvidence({
        source: 'sharpen',
        aspectId: t.aspectId,
        unitKey: t.unitKey,
        promptHash: t.promptHash,
        satisfied: t.satisfied,
        total: t.total,
      }),
      evidenceTs: t.lastTs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — decorative-rule (an enforceable rule never violated at exposure)
// ---------------------------------------------------------------------------

/**
 * Nominate a rule for a demotion/retire review ONLY when it looks decorative
 * (never once refused across meaningful exposure) AND every independent
 * corroborating signal agrees it is safe to consider demoting: no regression
 * drills, a shrinking attach set, and no suppress history. This gate lives in
 * `computeAspectHealthSignals` as `demotionCorroborated` — never the catch counter
 * alone. The anti-Goodhart covenant is honoured IN THE WHY: zero catches at
 * exposure is ALSO the signature of a perfectly deterring rule, so the item never
 * asserts the rule is useless; it names the corroborating signals as DATA and
 * offers "add a regression drill" as an alternative to demotion. The signature
 * stays human — the item proposes, the user decides.
 */
function decorativeRuleNominations(
  graph: Graph,
  events: VerdictEvent[],
  drillResults: DrillResultLine[],
  currentUnitsByAspect: Map<string, Set<string>>,
  suppressCountsByAspect: Map<string, number>,
  todayIso: string,
  committedViolatesCasesByAspect: Map<string, number> = new Map(),
): Nomination[] {
  const signals = computeAspectHealthSignals(graph, {
    verdictEvents: events,
    drillResults,
    currentUnitsByAspect,
    suppressCountsByAspect,
    committedViolatesCasesByAspect,
  });

  const out: Nomination[] = [];
  for (const aspect of graph.aspects) {
    const sig = signals.get(aspect.id);
    if (sig === undefined || !sig.demotionCorroborated) continue;

    // Most-recent fill timestamp is the item's natural recency key (corroboration
    // requires ≥1 fill, so this is populated; fall back defensively).
    let lastTs = '';
    for (const e of events) {
      if (e.source !== 'fill' || e.aspectId !== aspect.id) continue;
      if (typeof e.ts === 'string' && e.ts > lastTs) lastTs = e.ts;
    }
    const sinceLabel = lastTs !== '' ? ` [local telemetry since ${quoteData(lastTs)}]` : '';

    const aspectQ = quoteData(aspect.id);
    out.push({
      id: `decorative-rule:${aspect.id}`,
      classRank: CLASS_RANK.decorativeRule,
      what: `Rule '${aspectQ}' is enforceable but has never been refused in recorded checks.`,
      why:
        `caught 0 of ${sig.exposure} recorded checks while its attach set is shrinking, with no regression ` +
        `drill on record and no suppress waiver — the independent signals that it may be decorative all agree. ` +
        `Zero catches at this exposure can equally mean the rule is deterring the very violations it would ` +
        `catch; only a regression drill tells the two apart.${sinceLabel}`,
      next: asApprovalNext(
        `Propose demoting rule '${aspectQ}' to advisory or retiring it, citing these numbers — or add a ` +
          `regression drill to confirm it still catches before demoting.`,
      ),
      // Bind to the counts: more checks (or a first catch) moves the hash, so a
      // dismissed item returns when the evidence changes.
      evidenceHash: hashEvidence({
        source: 'decorative-rule',
        aspectId: aspect.id,
        catch: sig.catch,
        exposure: sig.exposure,
      }),
      evidenceTs: lastTs !== '' ? lastTs : todayIso,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — uncovered hot spot (a node that changes often but has no rule covering it)
// ---------------------------------------------------------------------------

/**
 * Nominate a node as an "uncovered hot spot" when its mapped source changed in the
 * window (churn > 0) yet it has ZERO effective non-draft aspects — the code most in
 * motion has the least protection. The zero-aspect test reuses the single canonical
 * effective-aspect query (hasNonDraftEffectiveAspects), so the full 7-channel
 * cascade, every `when` predicate, and draft semantics are honoured exactly as the
 * verifier sees them: a node whose ONLY aspect is draft still counts as uncovered
 * (draft enforces nothing). Self-clearing — the item disappears the moment a rule or
 * coverage lands (the node stops being zero-aspect) OR its churn ages out of the
 * window. The churn evidence (count, capped file sample, provenance) is rendered as
 * QUOTED DATA (RZ-5), never as an instruction. The signature stays human — the item
 * proposes adding coverage; the user decides.
 */
function hotSpotNominations(
  graph: Graph,
  churnByNode: Map<string, { churn: number; files: string[] }>,
  window: number,
  todayIso: string,
): Nomination[] {
  const out: Nomination[] = [];
  for (const [nodeId, { churn, files }] of churnByNode) {
    if (churn <= 0) continue;
    const node = graph.nodes.get(nodeId);
    if (node === undefined) continue; // ownerOf resolved a live node; defensive only
    if (hasNonDraftEffectiveAspects(node, graph)) continue; // a live rule covers it ⇒ not a hot spot

    const nodeQ = quoteData(nodeId);
    const fileSample = files.map((f) => quoteData(f)).join(', ');
    const provenance = `last ${window} commits, from git history`;
    const evidence = fileSample !== '' ? `${fileSample} (${provenance})` : provenance;

    out.push({
      id: `uncovered-hot-spot:${nodeId}`,
      classRank: CLASS_RANK.uncoveredHotSpot,
      what: `Node '${nodeQ}' is changing but has no rule covering it.`,
      why:
        `${churn} of the last ${window} commits touched this node's files, yet no rule beyond ` +
        `drafts verifies any of them — an uncovered hot spot: the code most in motion has the ` +
        `least protection.`,
      next:
        `Consider adding a rule or coverage for node '${nodeQ}' — propose an aspect or a coverage ` +
        `node to the user. Evidence: ${evidence}. Ask the user to approve it first.`,
      // Bind to churn + window + the file sample: a new commit (churn up), a widened
      // window, or a changed file set moves the hash, so a dismissed hot spot returns
      // when the evidence moves; a landed rule removes the item outright (it stops
      // being emitted, never re-surfaced by a stale decision).
      evidenceHash: hashEvidence({
        source: 'uncovered-hot-spot',
        nodeId,
        churn,
        window,
        files: files.join('|'),
      }),
      evidenceTs: todayIso,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1.5 — type-covered churn (a churning type-covered file with no owning node —
// the type tier alone carries its enforcement)
// ---------------------------------------------------------------------------

/**
 * The minimum churn a type-covered file needs before it is nominated, counted
 * over the window `NominationSources.typeCoveredChurnByFile` reads. A file's
 * FIRST appearance in that window already counts as a touch, so churn exactly
 * 1 may be nothing but the creating commit — not churn, merely existing.
 * Requiring more than that one touch (churn >= 2) is the minimal floor for
 * THAT shape; a higher floor would need its own justification this constant
 * does not have.
 *
 * NOT the converse: below this floor is not proof of no edits, only no proof
 * of one inside the window. A creating commit scrolled out of the window, a
 * rename (git's name-only log lists only the destination path on the rename
 * commit), or a merge that introduced the file with no listed files of its
 * own (`parseNameOnlyLog`'s doc, in `cli/advise.ts`) can each hide real edits
 * behind a churn of 1 or 0 — why docs/cli-reference.md and CHANGELOG.md state
 * this as "at least two of the last N commits," never "has ever been edited."
 */
const MIN_TYPE_COVERED_CHURN = 2;

/**
 * True iff `file` clears BOTH gates a nominee needs: edited beyond its
 * creating commit (`churn >= MIN_TYPE_COVERED_CHURN`) AND its matched type
 * genuinely enforces something on it (`typeEnforcedFiles` — the same fact
 * `yg owner --file` answers). Shared by the main loop and `clusterPartnersOf`,
 * so a cluster PARTNER is held to the same bar as a nominee — a file that
 * would not qualify on its own can never be cited as evidence for one that
 * does.
 */
function qualifiesForTypeCoveredChurn(
  entry: { churn: number; typeId: string } | undefined,
  file: string,
  typeEnforcedFiles: ReadonlySet<string>,
): entry is { churn: number; typeId: string } {
  return entry !== undefined && entry.churn >= MIN_TYPE_COVERED_CHURN && typeEnforcedFiles.has(file);
}

/**
 * For every same-type edge between two QUALIFYING type-covered files (each
 * clearing `qualifiesForTypeCoveredChurn`), record each endpoint as the
 * other's "cluster partner" (symmetric — an import in either direction is
 * evidence the two files carry real, shared weight, not evidence of which
 * one is "the cluster"). An edge whose target does not qualify, or whose two
 * endpoints match DIFFERENT types (defensive — the CLI boundary already
 * restricts `typeCoveredEdges` to same-type pairs, but this engine re-checks
 * any injected invariant it can cheaply verify), contributes no partnership.
 */
function clusterPartnersOf(
  churnByFile: Map<string, { churn: number; typeId: string }>,
  typeEnforcedFiles: ReadonlySet<string>,
  edges: Array<{ from: string; to: string }>,
): Map<string, Set<string>> {
  const partners = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let set = partners.get(a);
    if (set === undefined) {
      set = new Set<string>();
      partners.set(a, set);
    }
    set.add(b);
  };
  for (const { from, to } of edges) {
    const fromEntry = churnByFile.get(from);
    const toEntry = churnByFile.get(to);
    if (!qualifiesForTypeCoveredChurn(fromEntry, from, typeEnforcedFiles)) continue;
    if (!qualifiesForTypeCoveredChurn(toEntry, to, typeEnforcedFiles)) continue;
    if (fromEntry.typeId !== toEntry.typeId) continue; // defensive: never a cross-type cluster
    link(from, to);
    link(to, from);
  }
  return partners;
}

/**
 * Nominate graduating a type-covered file to its own node when it has been
 * EDITED beyond its own creating commit (churn >= MIN_TYPE_COVERED_CHURN) AND
 * its matched type genuinely enforces something on it — a type-covered file
 * has NO owning node by construction, so no node-level rule can ever attach to
 * it; the type tier alone carries whatever enforcement it gets, and this class
 * exists to say so only where that enforcement is real (see
 * `typeEnforcedFiles`'s own doc — the same fact `yg owner --file` answers).
 * Self-clearing exactly like `hotSpotNominations`: the moment a real node
 * claims the file, `computeTypeCoverage` no longer classifies it as
 * type-covered at all, so the CLI boundary naturally stops supplying an entry
 * for it and the item disappears — no explicit "still exists" check is needed
 * here (unlike hot-spot's defensive `graph.nodes.get` skip, there is no node id
 * to look up in the first place). When a same-type import edge connects two
 * churning type-covered files, the evidence upgrades from "one busy file" to
 * "a cluster" — every file in it carrying real weight together, worded to match
 * however many files that actually is (never a hardcoded "both"). The evidence
 * hash binds the matched type too: if the architecture re-buckets the file to a
 * different type between runs, the "create a node of type X" advice is now
 * about a different X, so a stale dismiss must not survive the re-bucketing.
 * Ranked, within the class, by churn descending (`rankWithinClass`) — the
 * busiest file first, so a display cap shows the strongest signals rather than
 * whichever file happens to sort first alphabetically.
 */
function typeCoveredChurnNominations(
  churnByFile: Map<string, { churn: number; typeId: string }>,
  typeEnforcedFiles: ReadonlySet<string>,
  edges: Array<{ from: string; to: string }>,
  window: number | undefined,
  todayIso: string,
): Nomination[] {
  const partnersOf = clusterPartnersOf(churnByFile, typeEnforcedFiles, edges);
  const out: Nomination[] = [];

  for (const [file, entry] of churnByFile) {
    // Same gate a cluster partner must clear — see qualifiesForTypeCoveredChurn.
    if (!qualifiesForTypeCoveredChurn(entry, file, typeEnforcedFiles)) continue;
    const { churn, typeId } = entry;

    const fileQ = quoteData(file);
    const typeQ = quoteData(typeId);
    const partners = [...(partnersOf.get(file) ?? [])].sort().map((p) => quoteData(p));
    // Mirrors hotSpotNominations' own "N of the last W commits" phrasing (never "N
    // commits", which would need singular/plural agreement) — window undefined
    // (pure-engine callers with no CLI-supplied window) falls back to a bare count.
    const commitsPhrase =
      window !== undefined
        ? `${churn} of the last ${window} commits`
        : `${churn} commit${churn === 1 ? '' : 's'}`;
    // Total files the cluster sentence names: this file plus every partner —
    // "both" is only true at exactly 2; three or more must say how many.
    const clusterSizePhrase = partners.length === 1 ? 'both files' : `all ${count(partners.length + 1, 'file')}`;

    const why =
      partners.length > 0
        ? `${commitsPhrase} touched '${fileQ}', which matches only type '${typeQ}' and has no owning node — ` +
          `it also imports (or is imported by) ${partners.map((p) => `'${p}'`).join(', ')}: a same-type cluster, ` +
          `${clusterSizePhrase} carrying real weight the type tier alone cannot enforce narrowly.`
        : `${commitsPhrase} touched '${fileQ}', which matches only type '${typeQ}' and has no owning ` +
          `node — with nothing narrower to attach a node-level rule to, the type tier alone carries whatever ` +
          `enforcement this file gets.`;

    out.push({
      id: `type-covered-churn:${file}`,
      classRank: CLASS_RANK.typeCoveredChurnCluster,
      // Negative churn: ascending sort (lower value first) puts the highest
      // churn first, matching classRank's own "lower sorts first" convention.
      rankWithinClass: -churn,
      what: `File '${fileQ}' (matched type '${typeQ}') is changing but has no node of its own.`,
      why,
      next:
        `Create an explicit node for '${fileQ}' (or widen an existing one's mapping to cover it), so the type tier is no ` +
        `longer carrying all of its enforcement — propose it to the user. Ask the user to approve it first.`,
      // Bind to churn + window + typeId + the partner set: a new commit, a widened
      // window, a re-bucketed type, or a changed cluster moves the hash, so a
      // dismissed item returns when the evidence moves; graduating the file (a
      // node claims it) removes the item outright (it stops being supplied).
      evidenceHash: hashEvidence({
        source: 'type-covered-churn',
        file,
        churn,
        typeId,
        window: window ?? -1,
        partners: partners.join('|'),
      }),
      evidenceTs: todayIso,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildNominations
// ---------------------------------------------------------------------------

/**
 * Build the live nominations from the current graph plus the injected telemetry.
 * Pure and deterministic given `graph` and `sources` (the only clock is the
 * injected `sources.todayUtc`). Ordered by `classRank`, then `rankWithinClass`
 * (ascending, only set by classes that need finer-than-evidenceTs ordering —
 * see its own doc), then `evidenceTs` (newest first), then `id` (lexicographic)
 * so callers get a stable ordering without re-sorting.
 */
export function buildNominations(graph: Graph, sources: NominationSources): Nomination[] {
  const nominations: Nomination[] = [];
  const todayIso = sources.todayUtc.toISOString();

  // --- T0-local: drill MISS (highest precedence) ---
  nominations.push(...drillMissNominations(graph, sources.drillResults ?? []));

  // --- suppress-marker anomalies: risky waivers (wildcard / typo / inert / unbounded) ---
  for (const anomaly of sources.suppressAnomalies ?? []) {
    const provenance = `${quoteData(anomaly.file)}:${anomaly.line}`;
    const markerQ = quoteData(anomaly.aspectId);
    const reasonQuote = anomaly.reason
      ? ` suppress reason: "${quoteData(anomaly.reason)}".`
      : '';
    nominations.push({
      id: `suppress-anomaly:${anomaly.file}:${anomaly.line}`,
      classRank: CLASS_RANK.suppressAnomaly,
      what: `A suppress marker at ${provenance} is risky (${anomaly.risk}).`,
      why:
        `marker '${markerQ}' at ${provenance} is classified ${anomaly.risk}, ` +
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

  // --- dead-attach: a rule source effective on zero nodes (looks enforced, isn't) ---
  // sources.typeCoverage is the SAME classification `yg check` and `gatherCurrentUnits`
  // use — without it, a rule effective ONLY on files enforced by their architecture
  // type would read as dead here while yg check reports it enforced.
  for (const issue of checkAspectEffectiveNowhere(graph, sources.typeCoverage)) {
    const aspectId = aspectIdFromIssue(issue);
    if (aspectId === undefined) continue;
    nominations.push({
      id: `dead-attach:${aspectId}`,
      classRank: CLASS_RANK.deadAttach,
      // Validator messages embed the aspect id (dir-name-constrained, so bounded)
      // amid authored prose. On the always-on feed every repo-derived string is
      // uniformly neutralized — control-byte-only (no length bound), so the full
      // authored what/why/next survives while any injected byte cannot.
      what: neutralizeControls(issue.messageData.what),
      why: neutralizeControls(issue.messageData.why),
      next: asApprovalNext(neutralizeControls(issue.messageData.next)),
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
      what: neutralizeControls(issue.messageData.what),
      why: neutralizeControls(issue.messageData.why),
      next: asApprovalNext(neutralizeControls(issue.messageData.next)),
      evidenceHash: hashEvidence({ source: 'orphaned-aspect', aspectId }),
      evidenceTs: todayIso,
    });
  }

  // --- overdue review_by: an aspect running past its standing review date ---
  for (const issue of checkReviewOverdue(graph, sources.todayUtc)) {
    const aspectId = aspectIdFromIssue(issue);
    if (aspectId === undefined) continue;
    const aspect = graph.aspects.find((a) => a.id === aspectId);
    const reviewBy = aspect?.reviewBy ?? '';
    nominations.push({
      id: `overdue-review-by:${aspectId}`,
      classRank: CLASS_RANK.overdueReviewBy,
      what: neutralizeControls(issue.messageData.what),
      why: neutralizeControls(issue.messageData.why),
      next: asApprovalNext(neutralizeControls(issue.messageData.next)),
      evidenceHash: hashEvidence({ source: 'overdue-review-by', aspectId, reviewBy }),
      // The review-by day is the item's natural recency key.
      evidenceTs: reviewBy !== '' ? `${reviewBy}T00:00:00.000Z` : todayIso,
    });
  }

  // --- T1: promotion + sharpen (below all T0) ---
  const events = sources.verdictEvents ?? [];
  nominations.push(...promotionNominations(graph, events));
  nominations.push(...sharpenNominations(events));

  // --- T1: decorative-rule (runs only when the CLI supplied both attach-set and
  //     suppress-count context — fail-safe: absent context ⇒ no demotion nominated) ---
  if (sources.currentUnitsByAspect !== undefined && sources.suppressCountsByAspect !== undefined) {
    nominations.push(
      ...decorativeRuleNominations(
        graph,
        events,
        sources.drillResults ?? [],
        sources.currentUnitsByAspect,
        sources.suppressCountsByAspect,
        todayIso,
        sources.committedViolatesCasesByAspect,
      ),
    );
  }

  // --- T1: uncovered hot spot (churn × zero-aspect nodes) — runs only when the CLI
  //     supplied BOTH the churn map and the window it was measured over; no git /
  //     shallow clone ⇒ omitted ⇒ SILENT (never fabricated as zero-and-fired) ---
  if (sources.churnByNode !== undefined && sources.churnWindow !== undefined) {
    nominations.push(
      ...hotSpotNominations(graph, sources.churnByNode, sources.churnWindow, todayIso),
    );
  }

  // --- T1.5: type-covered churn (below uncovered-hot-spot, above T2) — runs only
  //     when the CLI supplied BOTH a churn-by-file map AND which of those files
  //     their matched type actually enforces; no git / flag off / unresolved
  //     enforcement classification ⇒ omitted ⇒ SILENT (never fabricated as
  //     zero-and-fired, and never claiming enforcement this run could not verify) ---
  if (sources.typeCoveredChurnByFile !== undefined && sources.typeEnforcedFiles !== undefined) {
    nominations.push(
      ...typeCoveredChurnNominations(
        sources.typeCoveredChurnByFile,
        sources.typeEnforcedFiles,
        sources.typeCoveredEdges ?? [],
        sources.churnWindow,
        todayIso,
      ),
    );
  }

  // --- T2: family-without-law (below all T1) — runs only when the CLI supplied a
  //     FRESH candidates payload; absent / stale / garbled ⇒ silently omitted ---
  if (sources.familyCandidates !== undefined) {
    const files = Array.isArray(sources.familyCandidates) ? sources.familyCandidates : [sources.familyCandidates];
    for (const data of files) nominations.push(...familyNominations(data));
  }

  // --- T2: architecture-cut (below family) — one item per non-trivial quotient
  //     cycle (declared-only, reproducible); absent / acyclic ⇒ nothing ---
  nominations.push(...architectureCutNominations(sources.architectureCutCycles ?? []));

  // --- Imported: proposals another tool measured, below everything the graph
  //     derives itself. Absent ⇒ silent. ---
  nominations.push(...importedNominations(sources.importedAdvice ?? []));

  nominations.push(...packageUpdateNominations(sources.packageUpdates ?? [], todayIso));

  nominations.sort((a, b) => {
    if (a.classRank !== b.classRank) return a.classRank - b.classRank;
    const ar = a.rankWithinClass ?? 0;
    const br = b.rankWithinClass ?? 0;
    if (ar !== br) return ar - br;
    if (a.evidenceTs !== b.evidenceTs) return a.evidenceTs < b.evidenceTs ? 1 : -1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return nominations;
}

// ---------------------------------------------------------------------------
// buildAttention — one aggregate line per signal class (no per-instance ranking)
// ---------------------------------------------------------------------------

/** Plain-data inputs the attention aggregation needs (all computed at the boundary). */
export interface AttentionSources {
  /** C7 tunnel count — structural edges in the deduped universe (graph-metrics). */
  tunnelCount: number;
  /**
   * C8 live structural-deviation count — how many files the local feature-field
   * index still records as structural outliers under the exact-bytes match rule
   * `yg context` uses (a file changed since the index was written is NOT counted).
   * Computed at the boundary (the index read lives there); 0 omits the line.
   */
  deviationCount: number;
  /**
   * Total incidents recorded in the committed ledger (`.yggdrasil/incidents.md`),
   * counted at the boundary; 0 when the ledger is absent. Unlike the structural
   * lines this is the tower's only EXTERNAL oracle, so its reality-counter line is
   * always shown — even at 0 (an empty ledger is honest, not hidden).
   */
  incidentCount: number;
  /**
   * How many recorded incidents are tagged `wrong-rule` — evidence that the rules
   * themselves may be miscalibrated (it joins the catch/exposure health story). The
   * evidence line is shown only when this is > 0.
   */
  wrongRuleIncidentCount: number;
}

/**
 * The Attention section: ONE aggregate line per signal class, with NO per-instance
 * ranking (per-instance rankings stay inside the instrument commands — a ranked
 * list in a feed read every session is a to-do list regardless of exit codes). A
 * structural class with a zero count omits its line entirely (no "0 items" noise);
 * the incident reality-counter is the one exception — always shown, even at 0.
 * Three classes, emitted in this order:
 *   - incidents on record — the reality-counter for the committed incident ledger,
 *     the tower's only EXTERNAL oracle. ALWAYS shown (0 or N): an empty ledger is
 *     honest, not hidden, and its presence keeps the tower aware it has an outside
 *     reference at all. When any incident is tagged `wrong-rule` (count > 0) an
 *     extra aggregate line notes the rules themselves may be miscalibrated.
 *   - C7 tunnels — dependencies reaching across distant parts of the architecture;
 *     shown only when the count is > 0, pointing at `yg structure` for the detail.
 *   - C8 structural deviations — files that look unusual among their neighbours;
 *     shown only when the count is > 0. A bare count pointing at `yg context` for
 *     the per-file detail, never a ranking or a list (per-instance detail stays in
 *     `yg context`, read on demand).
 */
export function buildAttention(sources: AttentionSources): string[] {
  const lines: string[] = [];
  // The reality counter — the tower's ONLY external oracle. Always shown (0 or N):
  // an empty ledger is honest, not hidden, and its very presence keeps the tower
  // aware it has an outside reference at all. RZ-5 quoted-data: a count plus a fixed
  // sentence, with the ledger's own provenance — never a narrator-voice instruction.
  // With none recorded there is usually no ledger file at all, so pointing at it
  // would send the reader to a file that does not exist; name the command that
  // starts it instead.
  lines.push(
    sources.incidentCount === 0
      ? 'no incidents on record — incidents are the only evidence from outside the graph that a rule missed something; record one with yg incident add when something escapes enforcement'
      : `${sources.incidentCount} incident${sources.incidentCount === 1 ? '' : 's'} on record — the only evidence from outside the graph that a rule missed something; see .yggdrasil/incidents.md`,
  );
  // wrong-rule-tagged incidents are evidence the rules themselves may be
  // miscalibrated — the external counterpart to the catch/exposure health story.
  // Shown only when such evidence exists (K > 0); AGGREGATE only (no per-aspect
  // attribution in v1 — that is a future maintainer decision, not invented here).
  if (sources.wrongRuleIncidentCount > 0) {
    lines.push(
      `${sources.wrongRuleIncidentCount} wrong-rule incident${sources.wrongRuleIncidentCount === 1 ? '' : 's'} recorded — rules may be miscalibrated; see incidents.md`,
    );
  }
  if (sources.tunnelCount > 0) {
    lines.push(
      `${sources.tunnelCount} dependencies jump across distant parts of the architecture — run yg structure to see them`,
    );
  }
  if (sources.deviationCount > 0) {
    lines.push(
      `${count(sources.deviationCount, 'file')} ${sources.deviationCount === 1 ? 'deviates' : 'deviate'} structurally from their neighbors — shown in yg context when you work there.`,
    );
  }
  return lines;
}
