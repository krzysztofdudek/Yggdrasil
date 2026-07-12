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
 *     (an advisory rule with a clean recorded record) and sharpen (a rule the
 *     reviewer judged the SAME input inconsistently under --repeat). Every T1
 *     class ranks BELOW every T0 class.
 */

import type { Graph } from '../model/graph.js';
import type { AspectDef } from '../model/graph.js';
import type { ValidationIssue } from '../model/validation.js';
import { checkReviewOverdue, checkAspectEffectiveNowhere } from './checks/aspect-contracts.js';
import { checkOrphanedAspects } from './checks/aspects.js';
import { ruleHashFor } from './pair-inputs.js';
import { hashString } from '../io/hash.js';
import type { DrillResultLine } from '../io/drill-results-store.js';
import type { VerdictEvent } from '../io/events-store.js';

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
  /** Drill-result telemetry (T0-local drill MISS). Absent → none. */
  drillResults?: DrillResultLine[];
  /** Verdict-event telemetry (T1 promotion / sharpen). Absent → none. */
  verdictEvents?: VerdictEvent[];
}

/**
 * Class precedence per source (lower = higher priority). Spec §7.2:
 *   drill-MISS > suppress anomaly > dead-attach > orphaned > overdue review_by,
 * with EVERY T1 class (promotion, sharpen) below EVERY T0 class.
 */
const CLASS_RANK = {
  drillMiss: 10,
  suppressAnomaly: 20,
  deadAttach: 30,
  orphaned: 40,
  overdueReviewBy: 50,
  // --- T1: below all T0 ---
  promotion: 60,
  sharpen: 70,
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
 * Turn recorded drill MISSes into T0-local nominations. A MISS is a live alarm
 * ONLY while the drill's recorded `ruleHash` still matches the current rule
 * source; once the rule has changed the recorded outcome no longer reflects it,
 * so the item renders as a benign `stale — re-run yg drill` note rather than an
 * alarm (never a false live signal). Always labeled `local diagnostic result` —
 * a diagnostic outcome, never a live rule verdict.
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
    const sinceLabel = `local diagnostic result since ${line.ts}`;

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

    const labels: string[] = [`local telemetry since ${firstTs ?? lastTs}`];
    if (approved < THIN_DATA_N) labels.push('small-N');
    if (judgeMissing) labels.push('regime unknown');

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

/** Per-(aspect,unit) vote tally from `--repeat` diagnostic telemetry. */
interface DiagTally {
  aspectId: string;
  unitKey: string;
  satisfied: number;
  total: number;
  lastTs: string;
  judgeMissing: boolean;
}

/**
 * Nominate `sharpen-content.md` when the reviewer judged the SAME prompt
 * inconsistently across `yg aspect-test --repeat` runs — a stable split vote is
 * measured rule ambiguity (wave-3 C6.3a). Reads ONLY `source:'diag'` events
 * (mixing regimes would corrupt the statistic). One nomination per aspect,
 * citing its most-ambiguous unit; thin-data honesty labels as for promotion.
 */
function sharpenNominations(events: VerdictEvent[]): Nomination[] {
  const tallies = new Map<string, DiagTally>();
  for (const e of events) {
    if (e.source !== 'diag' || e.votes === undefined) continue;
    const key = `${e.aspectId}\u0000${e.unitKey}`;
    let t = tallies.get(key);
    if (t === undefined) {
      t = {
        aspectId: e.aspectId,
        unitKey: e.unitKey,
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
    const labels: string[] = [`local telemetry since ${t.lastTs}`];
    if (t.total < THIN_DATA_N) labels.push('small-N');
    if (t.judgeMissing) labels.push('regime unknown');

    const aspectQ = quoteData(t.aspectId);
    const unitQ = quoteData(t.unitKey);
    const refusedVotes = t.total - t.satisfied;
    out.push({
      id: `sharpen:${t.aspectId}`,
      classRank: CLASS_RANK.sharpen,
      what: `Rule '${aspectQ}' judged the same input inconsistently.`,
      why: `reviewed ${t.total} times on unit '${unitQ}', ${t.satisfied} satisfied and ${refusedVotes} refused — a split vote is measured rule ambiguity${honestySuffix(labels)}.`,
      next: asApprovalNext(
        `Propose sharpening the wording of rule '${aspectQ}' so the reviewer judges this case the same way every time.`,
      ),
      evidenceHash: hashEvidence({
        source: 'sharpen',
        aspectId: t.aspectId,
        unitKey: t.unitKey,
        satisfied: t.satisfied,
        total: t.total,
      }),
      evidenceTs: t.lastTs,
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
 * injected `sources.todayUtc`). Ordered by `classRank`, then `evidenceTs`
 * (newest first), then `id` (lexicographic) so callers get a stable ordering
 * without re-sorting.
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
  for (const issue of checkAspectEffectiveNowhere(graph)) {
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

// ---------------------------------------------------------------------------
// buildAttention — one aggregate line per signal class (no per-instance ranking)
// ---------------------------------------------------------------------------

/** Plain-data inputs the attention aggregation needs (all computed at the boundary). */
export interface AttentionSources {
  /** C7 tunnel count — structural edges in the deduped universe (graph-metrics). */
  tunnelCount: number;
}

/**
 * The Attention section: ONE aggregate line per signal class, with NO per-instance
 * ranking (per-instance rankings stay inside the instrument commands — a ranked
 * list in a feed read every session is a to-do list regardless of exit codes).
 * v1 has a single class: C7 tunnels. A zero count omits the line entirely.
 */
export function buildAttention(sources: AttentionSources): string[] {
  const lines: string[] = [];
  if (sources.tunnelCount > 0) {
    lines.push(
      `${sources.tunnelCount} dependencies jump across distant parts of the architecture — run yg structure to see them`,
    );
  }
  return lines;
}
