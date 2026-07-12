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
