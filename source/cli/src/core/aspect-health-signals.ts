/**
 * source/cli/src/core/aspect-health-signals.ts
 *
 * The SHARED per-aspect health signal, read by BOTH `yg aspects --health` (the
 * rendered catch/exposure view) and the advise decorative-rule nomination source.
 * Producing it here — once — keeps the two surfaces telling the same story.
 *
 * PURE and deterministic: every input arrives as a plain-data PARAMETER —
 *   - verdict-event telemetry (the append-only fill sidecar),
 *   - drill-result telemetry (regression-case outcomes),
 *   - the current per-aspect unit set (from the graph's expected pairs), and
 *   - per-aspect live suppress-marker counts.
 * This module lives under core/** and therefore MUST NOT import the verdict-events
 * reader or the drill-results reader (the `events-reader-boundary` G1 rule bans a
 * core→reader import): pulling a telemetry reader into the engine would let local,
 * gitignored observability influence a verdict. The CLI boundary owns that I/O and
 * hands the telemetry in as parameters, exactly as the advise engine does.
 *
 * ── What catch / exposure mean (binding definitions) ──────────────────────────
 *   catch    = a fill event with disposition 'refused' — the rule caught a
 *              violation that a human would otherwise have shipped.
 *   exposure = a fill event with disposition 'approved' OR 'refused' — a real
 *              opportunity to catch, where the reviewer actually rendered a
 *              verdict.
 * INFRA-class dispositions ('infra', 'companion-runtime-error', 'runtime-error',
 * 'malformed-suppress') are opportunities the reviewer never got to judge, so they
 * are EXCLUDED from BOTH counts. Only source:'fill' events count — drill and
 * diagnostic (`--repeat`) events run under different regimes and would corrupt the
 * statistic (this is why every event line carries a `source` discriminator).
 *
 * Counted over DISTINCT (aspectId, unitKey, hash) triples. A cached re-render
 * emits no event, so it can never double-count; and a single unit's
 * refused→fixed→approved history is two DIFFERENT input hashes, so it reads as ONE
 * catch and TWO exposures — the rule genuinely caught one violation across two
 * opportunities.
 *
 * ── The estimate and its uncertainty ─────────────────────────────────────────
 * The point estimate is a beta-binomial (empirical-Bayes) shrink of the raw catch
 * rate computed WITHIN the aspect's kind stratum — deterministic and LLM rules
 * generate false positives by different mechanisms, so their rates are NEVER
 * pooled together. A raw-count small-sample flag (`uncertaintyWide`) accompanies
 * it; the CLI renders that flag in PLAIN WORDS ("uncertainty range is wide — few
 * observations"). Method names (beta-binomial, empirical Bayes) live in these
 * comments and the docs only, never in CLI output.
 *
 * ── The anti-Goodhart covenant (`covenantLine`) ──────────────────────────────
 * A rule that is enforceable yet has never been violated at high exposure looks
 * decorative — but that is ALSO the exact signature of a perfectly DETERRING rule
 * (its presence prevents the very violations it would catch). So the `decorative?`
 * reading is never rendered as "useless"; it is cross-referenced against drill
 * status inline, and a demotion is proposed ONLY when several independent signals
 * corroborate it, never on the zero catch counter alone.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { VerdictEvent } from '../io/events-store.js';
import type { DrillResultLine } from '../io/drill-results-store.js';

/**
 * One aspect's health signal. `catch` / `exposure` are the raw distinct-triple
 * counts (the ground truth); `pointEstimate` is their within-kind beta-binomial
 * shrink; `uncertaintyWide` is the raw-count small-sample flag; `label` is the
 * coarse reading; `demotionCorroborated` gates the advise decorative-rule
 * nomination (never true on the catch counter alone — see the module header).
 */
export interface AspectHealthSignal {
  /** Distinct-triple fill refusals — violations the rule caught. */
  catch: number;
  /** Distinct-triple fill opportunities the reviewer actually judged (approved + refused). */
  exposure: number;
  /** Within-kind beta-binomial-shrunk catch rate in [0, 1]. */
  pointEstimate: number;
  /** True when the sample is too small for a tight range (raw-count small-N). */
  uncertaintyWide: boolean;
  /** Coarse reading: 'active' (catches), 'quiet' (thin data), 'decorative?' (never caught at exposure). */
  label: 'active' | 'quiet' | 'decorative?';
  /**
   * True ONLY when the rule looks decorative AND three independent signals all
   * agree it is safe to propose demoting: no regression drills, a shrinking attach
   * set, and no suppress history. If any one fails, this is false — a merely-quiet
   * rule is never nominated for demotion, and neither is a rule with any evidence
   * it deters.
   */
  demotionCorroborated: boolean;
}

/** Drill evidence for one aspect's ability to still catch a violation. */
export type DrillStatus = 'none' | 'proves-catch' | 'miss';

/** Plain-data telemetry + graph-derived inputs the signal needs (all resolved at the CLI boundary). */
export interface AspectHealthSignalInputs {
  /** All verdict events (any source); this module filters to source:'fill' itself. */
  verdictEvents: VerdictEvent[];
  /** All drill-result lines; used for the drill-status cross-reference + demotion gate. */
  drillResults: DrillResultLine[];
  /** Current expected units per aspect (aspectId → set of unit keys), from the graph's pairs. */
  currentUnitsByAspect: Map<string, Set<string>>;
  /** Live non-wildcard suppress-marker counts per aspect (aspectId → count). */
  suppressCountsByAspect: Map<string, number>;
}

/** Below this many exposures the raw-count range around the estimate is wide ("few observations"). */
export const THIN_DATA_EXPOSURE = 20;

/**
 * At or above this exposure, zero catches is a real signal (a `decorative?`
 * reading) rather than thin data. Held equal to the thin-data threshold so there
 * is a single boundary between "too few to tell" and "enough that never-caught
 * means something".
 */
const DECORATIVE_MIN_EXPOSURE = THIN_DATA_EXPOSURE;

/**
 * Beta prior pseudo-count for the within-kind shrink. A modest strength: a handful
 * of observations already move the estimate off the stratum base rate, while a
 * single observation is still heavily shrunk toward it.
 */
const PRIOR_STRENGTH = 5;

/** Fill dispositions that count toward exposure (the reviewer actually judged). */
const EXPOSURE_DISPOSITIONS = new Set(['approved', 'refused']);

/** Field separator for composite map keys (an escaped code point, never a raw control byte). */
const SEP = '\0';

interface CatchExposure {
  catch: number;
  exposure: number;
}

/**
 * The kind stratum an aspect's rate is pooled within, or undefined for an
 * aggregate (which has no own reviewer and therefore no verdicts). Read from the
 * declared reviewer kind — a plain field access, never a graph-query helper.
 */
function kindStratum(aspect: AspectDef): 'llm' | 'deterministic' | undefined {
  const t = aspect.reviewer.type;
  return t === 'llm' || t === 'deterministic' ? t : undefined;
}

/**
 * Count catch and exposure per aspect over DISTINCT (aspectId, unitKey, hash)
 * triples. Only source:'fill' events with an approved/refused disposition are
 * considered, so infra-class outcomes and drill/diag events are excluded from
 * both counts. A triple is a catch iff ANY of its events refused (a re-emitted
 * identical verdict for the same inputs cannot inflate the count — the triple is
 * seen once).
 */
function countCatchExposure(events: VerdictEvent[]): Map<string, CatchExposure> {
  const tripleAspect = new Map<string, string>();
  const tripleRefused = new Map<string, boolean>();
  for (const e of events) {
    if (e.source !== 'fill') continue;
    if (!EXPOSURE_DISPOSITIONS.has(e.disposition)) continue;
    const hash = e.hash ?? '';
    const key = `${e.aspectId}${SEP}${e.unitKey}${SEP}${hash}`;
    tripleAspect.set(key, e.aspectId);
    tripleRefused.set(key, (tripleRefused.get(key) ?? false) || e.disposition === 'refused');
  }

  const counts = new Map<string, CatchExposure>();
  for (const [key, aspectId] of tripleAspect) {
    let c = counts.get(aspectId);
    if (c === undefined) {
      c = { catch: 0, exposure: 0 };
      counts.set(aspectId, c);
    }
    c.exposure += 1;
    if (tripleRefused.get(key) === true) c.catch += 1;
  }
  return counts;
}

/**
 * Pool the raw catch rate WITHIN each kind stratum: the base rate a small sample
 * is shrunk toward. Deterministic and LLM aspects are pooled separately and never
 * mixed. An empty stratum yields a base rate of 0 (nothing to borrow from — a raw
 * sample then stands on its own).
 */
function poolBaseRatesByKind(
  graph: Graph,
  counts: Map<string, CatchExposure>,
): Map<'llm' | 'deterministic', number> {
  const pooled = new Map<'llm' | 'deterministic', CatchExposure>();
  for (const aspect of graph.aspects) {
    const kind = kindStratum(aspect);
    if (kind === undefined) continue;
    const c = counts.get(aspect.id);
    if (c === undefined) continue;
    let p = pooled.get(kind);
    if (p === undefined) {
      p = { catch: 0, exposure: 0 };
      pooled.set(kind, p);
    }
    p.catch += c.catch;
    p.exposure += c.exposure;
  }
  const rates = new Map<'llm' | 'deterministic', number>();
  for (const [kind, p] of pooled) {
    rates.set(kind, p.exposure > 0 ? p.catch / p.exposure : 0);
  }
  return rates;
}

/**
 * Beta-binomial (empirical-Bayes) posterior mean of a rule's catch rate. Models
 * the rate with a Beta prior whose mean is the WITHIN-KIND pooled `baseRate` and
 * whose strength is PRIOR_STRENGTH pseudo-observations
 * (α = PRIOR_STRENGTH·baseRate, β = PRIOR_STRENGTH·(1−baseRate)); the posterior
 * mean is (catch + α) / (exposure + PRIOR_STRENGTH). Small samples are pulled
 * toward the stratum base rate, while a large sample dominates the prior. Exported
 * so tests can assert the exact closed form. NEVER pool across kinds.
 */
export function betaBinomialShrink(catchCount: number, exposure: number, baseRate: number): number {
  const alpha = PRIOR_STRENGTH * baseRate;
  return (catchCount + alpha) / (exposure + PRIOR_STRENGTH);
}

/** Keep only the latest drill line per (aspect, case) — the sidecar is append-only. */
function latestDrillPerCase(results: DrillResultLine[]): DrillResultLine[] {
  const latest = new Map<string, DrillResultLine>();
  for (const r of results) {
    const key = `${r.aspect}${SEP}${r.case}`;
    const prev = latest.get(key);
    if (prev === undefined || r.ts >= prev.ts) latest.set(key, r);
  }
  return [...latest.values()];
}

/**
 * Resolve one aspect's drill evidence about whether it can still catch a violation:
 *   'miss'         — a refusal-expecting case is no longer caught (the rule may be weakening).
 *   'proves-catch' — a refusal-expecting case is still caught (the rule demonstrably works).
 *   'none'         — no informative refusal-expecting drill outcome on record.
 * Only refusal-expecting cases (`expect: 'refused'`) bear on deterrence; a MISS
 * dominates (worst evidence wins). Freshness against the current rule hash is a
 * concern of the drill-MISS alarm, not of this coarse status.
 */
export function computeDrillStatus(aspectId: string, drillResults: DrillResultLine[]): DrillStatus {
  const latest = latestDrillPerCase(drillResults.filter((r) => r.aspect === aspectId));
  let provesCatch = false;
  for (const r of latest) {
    if (r.expect !== 'refused') continue;
    if (r.got === 'satisfied') return 'miss';
    if (r.got === 'refused') provesCatch = true;
  }
  return provesCatch ? 'proves-catch' : 'none';
}

/**
 * The plain-words drill cross-reference for a `decorative?` rule — the
 * anti-Goodhart covenant. When a regression drill proves the rule still catches,
 * the reading is that it may be DETERRING the very violations it would catch, not
 * that it is useless. When no drill confirms it, the value is honestly
 * "unconfirmed" (a drill would settle it); a MISS says the rule may be weakening.
 * The proves-catch wording is verbatim contract text — do not paraphrase it.
 */
export function covenantLine(drillStatus: DrillStatus): string {
  switch (drillStatus) {
    case 'proves-catch':
      return 'enforceable but never violated — may be deterring violations';
    case 'miss':
      return 'enforceable but never violated, and a regression case is no longer caught — the rule may be weakening rather than deterring';
    case 'none':
    default:
      return 'enforceable but never violated — no regression drill confirms it can still catch, so whether it deters or is decorative is unconfirmed';
  }
}

/** Coarse reading from the raw counts alone (the estimate refines, never overrides, this). */
function labelFor(catchCount: number, exposure: number): AspectHealthSignal['label'] {
  if (catchCount > 0) return 'active';
  if (exposure >= DECORATIVE_MIN_EXPOSURE) return 'decorative?';
  return 'quiet';
}

/**
 * True when the aspect's attach set has SHRUNK: it still applies somewhere now,
 * yet the fill telemetry records at least one unit it used to be checked on that
 * it no longer applies to. Detachment from a unit it once covered is the shrink
 * signal; a rule that applies nowhere now is a dead-attach concern (a separate,
 * higher-priority nomination), not a demotion candidate, so an empty current set
 * is never "shrinking".
 */
function isAttachSetShrinking(
  aspectId: string,
  fillEvents: VerdictEvent[],
  currentUnitsByAspect: Map<string, Set<string>>,
): boolean {
  const current = currentUnitsByAspect.get(aspectId);
  if (current === undefined || current.size === 0) return false;
  for (const e of fillEvents) {
    if (e.source !== 'fill' || e.aspectId !== aspectId) continue;
    if (!current.has(e.unitKey)) return true;
  }
  return false;
}

/**
 * Compute the health signal for every aspect in the graph. Aspects with no fill
 * telemetry get a zero/zero signal (label 'quiet'), which the CLI renders as an
 * empty row rather than a false clean pass. Deterministic given the inputs.
 */
export function computeAspectHealthSignals(
  graph: Graph,
  inputs: AspectHealthSignalInputs,
): Map<string, AspectHealthSignal> {
  const counts = countCatchExposure(inputs.verdictEvents);
  const baseRates = poolBaseRatesByKind(graph, counts);

  const out = new Map<string, AspectHealthSignal>();
  for (const aspect of graph.aspects) {
    const kind = kindStratum(aspect);
    const c = counts.get(aspect.id) ?? { catch: 0, exposure: 0 };
    const baseRate = kind !== undefined ? (baseRates.get(kind) ?? 0) : 0;
    const pointEstimate = betaBinomialShrink(c.catch, c.exposure, baseRate);
    const label = labelFor(c.catch, c.exposure);

    const drillStatus = computeDrillStatus(aspect.id, inputs.drillResults);
    const shrinking = isAttachSetShrinking(aspect.id, inputs.verdictEvents, inputs.currentUnitsByAspect);
    const suppressCount = inputs.suppressCountsByAspect.get(aspect.id) ?? 0;

    // The catch counter alone never demotes: a demotion is proposed ONLY when the
    // rule looks decorative AND all three independent corroborating signals agree.
    const demotionCorroborated =
      label === 'decorative?' && drillStatus === 'none' && shrinking && suppressCount === 0;

    out.set(aspect.id, {
      catch: c.catch,
      exposure: c.exposure,
      pointEstimate,
      uncertaintyWide: c.exposure > 0 && c.exposure < THIN_DATA_EXPOSURE,
      label,
      demotionCorroborated,
    });
  }
  return out;
}

/**
 * Group expected pairs into the current unit set per aspect (aspectId → set of
 * unit keys). Both the `--health` path (from verified pairs) and the advise path
 * (from expected pairs) build the shrink input the same way, so the attach-set
 * comparison stays consistent across surfaces.
 */
export function groupUnitsByAspect(
  pairs: ReadonlyArray<{ aspectId: string; unitKey: string }>,
): Map<string, Set<string>> {
  const byAspect = new Map<string, Set<string>>();
  for (const p of pairs) {
    let set = byAspect.get(p.aspectId);
    if (set === undefined) {
      set = new Set<string>();
      byAspect.set(p.aspectId, set);
    }
    set.add(p.unitKey);
  }
  return byAspect;
}

// ============================================================
// The false-block (fp) signal — refusals a human later waived or overturned
// ============================================================

/**
 * One aspect's false-block signal: how often the rule's REFUSALS were later
 * waived or overturned by a human, a coarse "this rule may block wrongly" read
 * feeding a HUMAN retirement ritual (the false-block budget) — NEVER a gate.
 *
 * ── What counts as a false block (binding definitions) ───────────────────────
 *   block     = a distinct refused (aspectId, unitKey) pair on record (source:'fill'
 *               event with disposition 'refused') — an opportunity for the rule to
 *               have blocked WRONGLY.
 *   fp        = a block a human later waived or overturned, by EITHER:
 *     (a) SUPPRESSED — a LIVE, non-wildcard `yg-suppress` marker for THIS aspect now
 *         covers the refused unit (a file the unit owns). The human waived it.
 *     (b) OVERTURNED — the block later flipped to approved (a source:'fill' approved
 *         event post-dating a refusal for the same pair) AND a live marker now
 *         covers the unit — the overturn rode a suppress-range change, not a rule
 *         fix. A refused→approved flip with NO covering marker is a genuine code
 *         FIX (the rule working), so requiring the live marker excludes the
 *         SYSTEMATIC false positive: a genuine code fix is never counted.
 * A wildcard `*` marker silences every aspect and is never attributed to one — it
 * mirrors the `suppresses` column and keeps fp attribution precise.
 *
 * ── A residual, coincidence-only over-count (honest limitation) ───────────────
 * Coverage is resolved at FILE / NODE granularity, not per LINE (a refusal event
 * records no line). So a RESIDUAL over-count remains: if a same-aspect marker
 * waives one violation in a unit's file while an UNRELATED genuine refusal — or a
 * genuine-fix flip — for a different site occurs on the SAME unit, that unrelated
 * block is tallied as a false block, defaming a rule that did its job. It is
 * coincidence-gated (needs a same-aspect waiver co-located on the very unit), it
 * rides the thin-data honesty label, and it NEVER gates — so it is disclosed here
 * rather than engineered away (line-level attribution would need line-carrying
 * events, a schema change unjustified for a non-gating signal). Weigh a lone hit
 * accordingly; the column feeds a human review, never an automatic block.
 *
 * ── The estimate and its uncertainty ─────────────────────────────────────────
 * `shrunkRate` is a beta-binomial (empirical-Bayes) shrink of the raw false-block
 * rate (fp / blocks) computed WITHIN the aspect's kind stratum — deterministic and
 * LLM rules generate false positives by different mechanisms, so their rates are
 * NEVER pooled together. `thinData` is the raw-count small-sample flag; the CLI
 * renders it in PLAIN WORDS ("few observations"). Method names live in comments
 * and docs only, never in CLI output.
 *
 * Counted over DISTINCT (aspectId, unitKey) PAIRS — a unit that was blocked and
 * waived counts once regardless of how many hash-states it passed through.
 */
export interface AspectFalsePositiveSignal {
  /** Distinct blocks a human later waived or overturned (suppressed + overturned). */
  fp: number;
  /** Distinct refused (aspectId, unitKey) pairs on record — the blocks (denominator). */
  blocks: number;
  /** Of `fp`, blocks still refused but now covered by a live suppress marker (criterion a). */
  suppressed: number;
  /** Of `fp`, blocks that flipped refused→approved with a live covering marker (criterion b). */
  overturned: number;
  /** Within-kind beta-binomial-shrunk false-block rate in [0, 1] (fp / blocks). */
  shrunkRate: number;
  /** True when the block sample is too small for a tight rate (raw-count small-N). */
  thinData: boolean;
}

/** Plain-data telemetry + the live-suppress coverage the fp signal needs (resolved at the CLI boundary). */
export interface AspectFalsePositiveInputs {
  /** All verdict events (any source); this module filters to source:'fill' itself. */
  verdictEvents: VerdictEvent[];
  /**
   * aspectId → the set of unit keys currently covered by a LIVE non-wildcard
   * suppress marker for that aspect. Resolved at the CLI boundary from the live
   * suppress scan + the graph's file→node ownership (the engine never runs the
   * scan or touches the graph's mapping I/O here), exactly as the other telemetry
   * arrives — as plain data.
   */
  suppressedUnitsByAspect: Map<string, Set<string>>;
}

/** Per-aspect refusal/approval facts folded from the fill event stream. */
interface PairFacts {
  /** Earliest refusal timestamp for the pair (ISO 8601, lexicographically ordered). */
  earliestRefusal?: string;
  /** Latest approval timestamp for the pair (ISO 8601). */
  latestApproval?: string;
}

/**
 * Fold the fill event stream into per (aspectId, unitKey) refusal/approval facts.
 * Only source:'fill' events with an approved/refused disposition are considered —
 * infra-class outcomes and drill/diag events are excluded, mirroring catch/exposure.
 */
function collectPairFacts(events: VerdictEvent[]): Map<string, PairFacts> {
  const facts = new Map<string, PairFacts>();
  for (const e of events) {
    if (e.source !== 'fill') continue;
    if (e.disposition !== 'approved' && e.disposition !== 'refused') continue;
    const key = `${e.aspectId}${SEP}${e.unitKey}`;
    let f = facts.get(key);
    if (f === undefined) {
      f = {};
      facts.set(key, f);
    }
    if (e.disposition === 'refused') {
      if (f.earliestRefusal === undefined || e.ts < f.earliestRefusal) f.earliestRefusal = e.ts;
    } else {
      if (f.latestApproval === undefined || e.ts > f.latestApproval) f.latestApproval = e.ts;
    }
  }
  return facts;
}

interface FpAccumulator {
  blocks: number;
  suppressed: number;
  overturned: number;
}

/**
 * Count blocks and false blocks per aspect. A pair is a BLOCK iff it has a refusal
 * event; it is a false block iff it is additionally covered by a live suppress
 * marker for the aspect. A false block is OVERTURNED when a refusal is followed by
 * an approval (the block flipped), else SUPPRESSED (still refused, now waived).
 */
function accumulateFp(
  facts: Map<string, PairFacts>,
  suppressedUnitsByAspect: Map<string, Set<string>>,
): Map<string, FpAccumulator> {
  const acc = new Map<string, FpAccumulator>();
  for (const [key, f] of facts) {
    if (f.earliestRefusal === undefined) continue; // no block on this pair
    const sep = key.indexOf(SEP);
    const aspectId = key.slice(0, sep);
    const unitKey = key.slice(sep + 1);
    let a = acc.get(aspectId);
    if (a === undefined) {
      a = { blocks: 0, suppressed: 0, overturned: 0 };
      acc.set(aspectId, a);
    }
    a.blocks += 1;
    const covered = suppressedUnitsByAspect.get(aspectId)?.has(unitKey) ?? false;
    if (!covered) continue;
    // A refusal followed by a later approval is an OVERTURN; a covered block with no
    // subsequent approval is a still-refused block a human waived (SUPPRESSED).
    if (f.latestApproval !== undefined && f.earliestRefusal < f.latestApproval) a.overturned += 1;
    else a.suppressed += 1;
  }
  return acc;
}

/**
 * Pool the raw false-block rate (fp / blocks) WITHIN each kind stratum — the base
 * rate a small sample is shrunk toward. Deterministic and LLM aspects are pooled
 * separately and never mixed (their false-positive mechanisms differ). An empty
 * stratum yields 0.
 */
function poolFpBaseRatesByKind(
  graph: Graph,
  acc: Map<string, FpAccumulator>,
): Map<'llm' | 'deterministic', number> {
  const pooled = new Map<'llm' | 'deterministic', { fp: number; blocks: number }>();
  for (const aspect of graph.aspects) {
    const kind = kindStratum(aspect);
    if (kind === undefined) continue;
    const a = acc.get(aspect.id);
    if (a === undefined) continue;
    let p = pooled.get(kind);
    if (p === undefined) {
      p = { fp: 0, blocks: 0 };
      pooled.set(kind, p);
    }
    p.fp += a.suppressed + a.overturned;
    p.blocks += a.blocks;
  }
  const rates = new Map<'llm' | 'deterministic', number>();
  for (const [kind, p] of pooled) rates.set(kind, p.blocks > 0 ? p.fp / p.blocks : 0);
  return rates;
}

/**
 * Compute the false-block (fp) signal for every aspect in the graph. Aspects with
 * no recorded block get a zero/zero signal (blocks: 0), which the CLI renders as an
 * empty cell rather than a false clean 0. Deterministic given the inputs; PURE — the
 * live-suppress coverage and telemetry arrive as parameters (see the module header
 * on the G1 boundary).
 */
export function computeAspectFalsePositiveSignals(
  graph: Graph,
  inputs: AspectFalsePositiveInputs,
): Map<string, AspectFalsePositiveSignal> {
  const facts = collectPairFacts(inputs.verdictEvents);
  const acc = accumulateFp(facts, inputs.suppressedUnitsByAspect);
  const baseRates = poolFpBaseRatesByKind(graph, acc);

  const out = new Map<string, AspectFalsePositiveSignal>();
  for (const aspect of graph.aspects) {
    const kind = kindStratum(aspect);
    const a = acc.get(aspect.id) ?? { blocks: 0, suppressed: 0, overturned: 0 };
    const fp = a.suppressed + a.overturned;
    const baseRate = kind !== undefined ? (baseRates.get(kind) ?? 0) : 0;
    out.set(aspect.id, {
      fp,
      blocks: a.blocks,
      suppressed: a.suppressed,
      overturned: a.overturned,
      shrunkRate: betaBinomialShrink(fp, a.blocks, baseRate),
      thinData: a.blocks > 0 && a.blocks < THIN_DATA_EXPOSURE,
    });
  }
  return out;
}
