import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { computeEffectiveAspects, inferAspectDisplayKind } from '../core/graph/aspects.js';
import { computeTypeAspectCascade, isReachableForTypeCoveredFile } from '../core/type-effective.js';
import type { TypeCoverageInput } from '../core/pairs.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import type { Graph, AspectStatus, AspectDef } from '../model/graph.js';
import { readLock } from '../io/lock-store.js';
import { verifyLock } from '../core/verify-lock.js';
import type { VerifiedPair } from '../core/verify-lock.js';
import { walkRepoFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { runSuppressionsScan } from '../portal/api/suppress-scan.js';
import type { SuppressionsReport } from '../portal/api/suppress-scan.js';
import { resolveSuppressedUnitsByAspect } from '../portal/api/suppress-coverage.js';
import { collectMappingEntries, collectTypeCoveredFiles } from '../portal/api/suppress-eligibility.js';
import { getFirstCommitTimestamp } from '../utils/git.js';
import { readVerdictEvents } from '../io/events-reader.js';
import { readDrillResults } from '../io/drill-results-reader.js';
import { filterInCorpusDevDrills } from '../core/drill-runner.js';
import type { DrillResultLine } from '../io/drill-results-store.js';
import { debugWrite } from '../utils/debug-log.js';
import { countWrongRuleIncidentsByAspect } from '../io/incidents-store.js';
import {
  computeAspectHealthSignals,
  computeAspectFalsePositiveSignals,
  groupUnitsByAspect,
  covenantLine,
  computeDrillStatus,
  type AspectHealthSignal,
  type AspectFalsePositiveSignal,
  type DrillStatus,
} from '../core/aspect-health-signals.js';

interface AspectUsage {
  architecture: number;
  own: number;
  implied: number;
  flow: number;
  /** Real component nodes using this aspect — architecture + own + implied + flow. Never includes typeCovered below (a file is not a node). */
  total: number;
  /**
   * Files enforced by their architecture type alone (no owning component) —
   * counted separately from `total` so a caller never mislabels a FILE as a
   * "node" the way `total` names them. A rule live only through this count is
   * still real, enforced law (`yg check` reports it enforced); it must never
   * read as unused just because `total` (node usage) is zero.
   */
  typeCovered: number;
}

/**
 * `typeCoverage`: the type-level classification (coverage.type_level),
 * optional — absent ⇒ today's behavior exactly (typeCovered stays 0 on every
 * aspect, byte-identical to before the tier existed). Present ⇒ a file
 * enforced by its architecture type alone is counted too, so a rule reachable
 * ONLY that way is never reported as unused (0 nodes) when `yg check` already
 * treats it as live.
 */
export function computeAspectUsage(graph: Graph, typeCoverage?: TypeCoverageInput): Map<string, AspectUsage> {
  const usage = new Map<string, AspectUsage>();
  for (const aspect of graph.aspects) {
    usage.set(aspect.id, { architecture: 0, own: 0, implied: 0, flow: 0, total: 0, typeCovered: 0 });
  }

  for (const [, node] of graph.nodes) {
    const effective = computeEffectiveAspects(node, graph);
    const ownAspects = new Set(node.meta.aspects ?? []);
    const flowAspects = new Set<string>();
    for (const flow of graph.flows) {
      if (flow.nodes.includes(node.path)) {
        for (const id of flow.aspects ?? []) flowAspects.add(id);
      }
    }

    const archAspects = new Set<string>();
    if (graph.architecture) {
      const nodeTypeDef = graph.architecture.node_types[node.meta.type];
      for (const id of nodeTypeDef?.aspects ?? []) archAspects.add(id);
    }

    for (const aspectId of effective) {
      const u = usage.get(aspectId);
      if (!u) continue;
      u.total++;
      if (archAspects.has(aspectId)) u.architecture++;
      else if (flowAspects.has(aspectId)) u.flow++;
      else if (ownAspects.has(aspectId)) u.own++;
      else u.implied++;
    }
  }

  // Files enforced by their architecture type alone: the SAME reachability
  // rule the dead-attach linters use (isReachableForTypeCoveredFile) — a
  // whole-unit (per: node) rule is cascade-effective yet has no component to
  // run on for a nodeless file, so it must not count as used there. A cascade
  // that could not be resolved at all (an implies cycle) contributes nothing
  // here; the dead-attach linters name that cause on their own path.
  for (const [file, typeId] of typeCoverage?.covered ?? []) {
    let cascade;
    try {
      cascade = computeTypeAspectCascade(graph, file, typeId, typeCoverage?.edges);
    } catch (error) {
      // An unexpected structural error (not an implies cycle — that is
      // absorbed inside computeTypeAspectCascade itself and returned as
      // cascade.cycle below) must not abort usage counting for every OTHER
      // type-covered file in the run.
      debugWrite(
        `[aspects] type-covered usage skipped for '${file}' (type '${typeId}'): ${(error as Error).message}`,
      );
      continue;
    }
    if (cascade.cycle) continue;
    for (const { aspectId } of cascade.effective) {
      if (!isReachableForTypeCoveredFile(graph, aspectId)) continue;
      const u = usage.get(aspectId);
      if (!u) continue;
      u.typeCovered++;
    }
  }

  return usage;
}

export function formatAspectsOutput(graph: Graph, typeCoverage?: TypeCoverageInput): string {
  const usage = computeAspectUsage(graph, typeCoverage);
  const lines: string[] = [];

  for (const aspect of graph.aspects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const u = usage.get(aspect.id) ?? { architecture: 0, own: 0, implied: 0, flow: 0, total: 0, typeCovered: 0 };
    const displayName = aspect.description ?? aspect.name;
    const status = aspect.status ?? 'enforced';
    lines.push(`${aspect.id} [${status}] — ${displayName}`);
    const reviewerType = aspect.reviewer.type;
    if (reviewerType === 'llm') {
      const tier = aspect.reviewer.tier ?? '(default)';
      lines.push(`  Reviewer: llm — tier: ${tier}`);
    } else {
      lines.push(`  Reviewer: ${reviewerType}`);
    }

    if (u.total === 0 && u.typeCovered === 0) {
      lines.push(chalk.yellow(`  Used by: 0 nodes — orphaned`));
    } else if (u.total === 0) {
      // No component uses it, but files enforced by its architecture type
      // alone do — live law, never orphaned just because no node declares it.
      lines.push(`  Used by: 0 nodes, ${u.typeCovered} type-covered file${u.typeCovered === 1 ? '' : 's'}`);
    } else {
      const parts: string[] = [];
      if (u.architecture) parts.push(`architecture: ${u.architecture}`);
      if (u.own) parts.push(`direct: ${u.own}`);
      if (u.implied) parts.push(`implied: ${u.implied}`);
      if (u.flow) parts.push(`flow: ${u.flow}`);
      if (u.typeCovered) parts.push(`type-covered: ${u.typeCovered}`);
      const fileSuffix = u.typeCovered > 0 ? ` + ${u.typeCovered} type-covered file${u.typeCovered === 1 ? '' : 's'}` : '';
      lines.push(`  Used by: ${u.total} node${u.total === 1 ? '' : 's'}${fileSuffix} (${parts.join(', ')})`);
    }

    if (aspect.implies && aspect.implies.length > 0) {
      lines.push(`  Implies: ${aspect.implies.join(', ')}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// `--health` — per-aspect health projection (C3 slice 1)
// ============================================================

/**
 * Placeholder shown for a cell with no meaningful value (a dormant aspect's
 * refusal count, an aspect with no error-direction label).
 */
const EMPTY_CELL = '—';

/**
 * Rendered when an aspect has pairs with no valid result on record. The word,
 * never a number: a `0` would read as "checked and clean", but an unchecked pair
 * has simply never been reviewed. This is the "unverified ≠ zero" honesty rule.
 */
const UNVERIFIED = 'unverified';

/** One rendered row of the health table. */
export interface AspectHealthRow {
  aspectId: string;
  /** Reviewer kind: 'llm' | 'deterministic' | 'aggregate'. */
  kind: string;
  status: AspectStatus;
  /** Distinct nodes that have a review pair for this aspect. */
  nodes: number;
  /**
   * Distinct type-covered files (nodeless pairs) that have a review pair for
   * this aspect, as a rendered cell: EMPTY_CELL when `coverage.type_level` is
   * off (the question was never asked — `verifyLock` never enumerated a
   * file-level pair to count), otherwise the real count, which may legitimately
   * be `'0'`. Never conflate the two: an unasked question and a zero answer are
   * different facts. Rendered as its own table column (HEALTH_HEADERS), appended
   * after wrong-rule, and OMITTED from the header entirely when the tier is off
   * (see `formatAspectsHealthOutput`) so a flag-off repository's output stays
   * byte-identical to before this column existed.
   */
  filesCell: string;
  /** Total review pairs for this aspect. */
  pairs: number;
  /** Rendered refusal cell — an integer, EMPTY_CELL, or the UNVERIFIED word. */
  refused: string;
  /** Live count of suppress markers targeting this aspect (wildcards excluded). */
  suppresses: number;
  /** Error-direction label ('over' | 'under' | 'exact') or EMPTY_CELL. */
  errs: string;
  /**
   * Coarse age of the aspect's rule source since it was first added to version
   * control (e.g. '3mo', '1y'); the WORD 'unknown' when history is unavailable
   * (shallow clone / no repo / untracked), never a fabricated 0; EMPTY_CELL for a
   * bundle with no rule source to age.
   */
  age: string;
  /**
   * Times this rule caught a violation (a refused fill), or EMPTY_CELL when it has
   * no recorded exposure. A raw count from local telemetry — never a hash input.
   */
  catchCell: string;
  /** Times the reviewer actually judged this rule (approved + refused fills), or EMPTY_CELL. */
  exposureCell: string;
  /** Coarse reading of the catch/exposure record ('active' | 'quiet' | 'decorative?'), or EMPTY_CELL. */
  signalCell: string;
  /**
   * False-block cell — how many of this rule's refusals a human later waived or
   * overturned, as an honest COUNT with a thin-data label (`<n>` or `<n> (thin
   * data)`); EMPTY_CELL when the rule has no recorded block. Never a bare rate,
   * never a gate — a read for the human retirement ritual.
   */
  fpCellValue: string;
  /**
   * Wrong-rule attribution cell — how many committed `wrong-rule` incidents name
   * THIS rule (via `yg incident add --aspect`), as an honest COUNT carrying a
   * `(thin data)` humility label; EMPTY_CELL when none name it. Incidents are sparse
   * human testimony with no exposure denominator, so a nonzero count always wears the
   * thin-data label. Read-only observability from the committed ledger — never a hash
   * input, never a gate.
   */
  wrongRuleCell: string;
}

export interface AspectHealth {
  rows: AspectHealthRow[];
  /** Wildcard suppress markers — summarized once, never attributed per-aspect. */
  wildcardMarkers: number;
  /** True when any row's refusal cell reads as unverified (drives the footer note). */
  hasUnverified: boolean;
  /**
   * Plain-words lines rendered below the table: the anti-Goodhart covenant
   * cross-reference for every `decorative?` rule, and a "few observations"
   * uncertainty note for every thin-sample rule. Empty when no rule has telemetry.
   */
  signalNotes: string[];
  /**
   * Plain-words false-block lines rendered below the table: the "local telemetry
   * since <ts>" honesty line plus, per rule with a waived/overturned block, how
   * many of its blocks turned out false (with a plain-words rate and thin-data
   * caveat — never a bare rate). Empty when no rule has a recorded block.
   */
  fpNotes: string[];
  /**
   * True when at least one aspect has a `wrong-rule` incident attributed to it,
   * driving the plain-words attribution disclosure below the table (the honesty
   * boundary: an unattributed wrong-rule incident counts in `yg advise`'s total but
   * never here).
   */
  hasWrongRuleAttribution: boolean;
  /**
   * `coverage.type_level` as read from the graph this health run was built for.
   * Gates whether `formatAspectsHealthOutput` renders the `files` column at
   * all: off ⇒ the column (header and every row's cell) is omitted outright,
   * not merely em-dashed, so a repository that never turned the tier on keeps
   * byte-identical `--health` output to before the column existed.
   */
  typeLevelEnabled: boolean;
}

/**
 * Render the refusal cell honestly (the "unverified ≠ zero" invariant):
 *   - no pairs        → EMPTY_CELL (dormant: draft / aggregate / unattached).
 *   - all pairs known → the integer refusal count (may legitimately be 0).
 *   - some unknown, 0 refused → UNVERIFIED (cannot claim a clean 0).
 *   - some unknown AND some refused → "N (+M unverified)" (both facts stated).
 * `refused` counts ONLY hash-valid refusals; a stale/absent verdict is `unknown`.
 */
export function renderRefusedCell(pairs: number, refused: number, unknown: number): string {
  if (pairs === 0) return EMPTY_CELL;
  if (unknown === 0) return String(refused);
  if (refused === 0) return UNVERIFIED;
  return `${refused} (+${unknown} ${UNVERIFIED})`;
}

/** Rendered when a rule's creation time cannot be read from version control. */
const UNKNOWN_AGE = 'unknown';

/**
 * Render a coarse, single-token age for a rule source from its first-add
 * timestamp (Unix seconds) and an INJECTED reference now (milliseconds). Coarse
 * buckets keep the health table scannable rather than precise: '<1d' (also covers
 * clock skew where the timestamp reads as future), 'Nd' under a month, 'Nmo' under
 * a year, then 'Ny'. A null timestamp — git unavailable (shallow clone, no repo,
 * untracked) — renders the WORD 'unknown', NEVER a fabricated 0, so a missing
 * track record is never mistaken for a brand-new rule.
 *
 * `now` is a parameter, not a Date.now() read, so a fixed now yields a stable,
 * testable bucket (the age of a given commit relative to a fixed now is constant).
 */
export function renderRuleAge(firstAddSeconds: number | null, nowMs: number): string {
  if (firstAddSeconds === null) return UNKNOWN_AGE;
  const ageSeconds = Math.floor(nowMs / 1000) - firstAddSeconds;
  const ageDays = Math.floor(ageSeconds / 86400);
  if (ageDays < 1) return '<1d';
  if (ageDays < 30) return `${ageDays}d`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}mo`;
  return `${Math.floor(ageDays / 365)}y`;
}

/**
 * The rule-source filename an aspect ships (content.md for an LLM aspect,
 * check.mjs for a deterministic one), or null for a bundle that ships neither and
 * so has no rule to age. Read off the already-loaded artifacts — no disk access —
 * mirroring how the display kind is inferred from rule-source presence.
 */
function ruleSourceFilename(aspect: AspectDef): string | null {
  const has = (filename: string): boolean => aspect.artifacts.some((a) => a.filename === filename);
  if (has('content.md')) return 'content.md';
  if (has('check.mjs')) return 'check.mjs';
  return null;
}

/**
 * Resolve each aspect's rule-source age string for the health view, keyed by
 * aspect id. For every aspect that ships a rule source, query version control for
 * when that file was FIRST added and render a coarse duration from the injected
 * reference now; aspects with no rule source (implies-only bundles) have nothing
 * to age → EMPTY_CELL. Git-unavailable resolves to 'unknown', never a zero.
 *
 * Runs one git subprocess per rule-bearing aspect, so it is invoked ONLY on the
 * --health path — the default `yg aspects` listing never calls this and therefore
 * runs zero git subprocesses.
 */
export function resolveRuleAges(
  graph: Graph,
  projectRoot: string,
  nowMs: number,
): Map<string, string> {
  const ages = new Map<string, string>();
  for (const aspect of graph.aspects) {
    const ruleFile = ruleSourceFilename(aspect);
    if (ruleFile === null) {
      ages.set(aspect.id, EMPTY_CELL);
      continue;
    }
    const relPath = `.yggdrasil/aspects/${aspect.id}/${ruleFile}`;
    const firstAdd = getFirstCommitTimestamp(projectRoot, relPath);
    ages.set(aspect.id, renderRuleAge(firstAdd, nowMs));
  }
  return ages;
}

/**
 * Fold the verified-pair classification, the graph, and a live suppress scan into
 * one health row per aspect (sorted by id). Pure — no I/O; every input is already
 * resolved by the caller so this stays unit-testable.
 *
 * A pair is `refused` ONLY when its stored verdict still hashes valid against
 * current inputs (verifyLock's 'refused' state); any other non-verified state
 * (unverified / prompt-too-large / companion-error) is counted as `unknown`, so a
 * stale or absent verdict can never masquerade as a clean pass.
 */
/**
 * Render a signal's three table cells. A rule with no recorded exposure has no
 * catch/exposure/reading to show — EMPTY_CELL across the board, never a `0` that
 * would read as "checked and clean" (the same unverified-≠-zero honesty the
 * refused cell follows).
 */
function signalCells(sig: AspectHealthSignal | undefined): {
  catchCell: string;
  exposureCell: string;
  signalCell: string;
} {
  if (sig === undefined || sig.exposure === 0) {
    return { catchCell: EMPTY_CELL, exposureCell: EMPTY_CELL, signalCell: EMPTY_CELL };
  }
  return { catchCell: String(sig.catch), exposureCell: String(sig.exposure), signalCell: sig.label };
}

/**
 * Render the false-block (fp) cell. A rule with no recorded block has nothing to
 * show — EMPTY_CELL, never a `0` that would read as "checked and clean" (the same
 * unverified-≠-zero honesty the refused/catch cells follow). Otherwise the raw
 * COUNT of waived/overturned blocks, with a plain-words `(thin data)` label when
 * the block sample is small — never a bare rate.
 */
function fpCell(sig: AspectFalsePositiveSignal | undefined): string {
  if (sig === undefined || sig.blocks === 0) return EMPTY_CELL;
  return sig.thinData ? `${sig.fp} (thin data)` : String(sig.fp);
}

/**
 * Render the wrong-rule attribution cell. No incident naming this rule → EMPTY_CELL,
 * never a `0` that would read as "checked and clean" (the same unverified-≠-zero
 * honesty the refused/catch/fp cells follow). Otherwise the raw COUNT of committed
 * `wrong-rule` incidents attributed to the rule, always with the `(thin data)` label:
 * incident testimony is a sparse, qualitative signal with no exposure denominator to
 * grow out of thin-ness, so even a handful is weighed as anecdote, never a rate.
 */
function wrongRuleCell(count: number): string {
  if (count === 0) return EMPTY_CELL;
  return `${count} (thin data)`;
}

/**
 * Build the plain-words lines rendered below the table. For a `decorative?` rule
 * the anti-Goodhart covenant cross-reference (drill-status-dependent, so a
 * never-violated rule proven to still catch reads as possibly DETERRING, not
 * useless); for any other thin-sample rule, a "few observations" uncertainty note.
 * Method names never appear — the uncertainty is stated in plain words only.
 */
function buildSignalNotes(
  sortedAspects: AspectDef[],
  signals: ReadonlyMap<string, AspectHealthSignal>,
  drillStatuses: ReadonlyMap<string, DrillStatus>,
): string[] {
  const notes: string[] = [];
  for (const aspect of sortedAspects) {
    const sig = signals.get(aspect.id);
    if (sig === undefined || sig.exposure === 0) continue;
    const pct = Math.round(sig.pointEstimate * 100);
    if (sig.label === 'decorative?') {
      const cross = covenantLine(drillStatuses.get(aspect.id) ?? 'none');
      notes.push(
        `${aspect.id}: ${cross} (0 of ${sig.exposure} recorded checks; estimated catch rate ~${pct}%).`,
      );
    } else if (sig.uncertaintyWide && sig.catch > 0) {
      // Caveat only where there is a real catch rate to over-trust; a never-caught
      // thin rule's story is already told by its catch=0 / signal=quiet cells.
      notes.push(
        `${aspect.id}: estimated catch rate ~${pct}% — uncertainty range is wide (few observations).`,
      );
    }
  }
  return notes;
}

/**
 * Build the plain-words false-block lines rendered below the table. When ANY rule
 * has a recorded block, a leading "local telemetry since <ts>" honesty line (plus
 * the committed-stream caveat when teammate events contribute); then, per rule with
 * a waived/overturned block, how many of its blocks turned out false — stated as a
 * count with a plain-words rate and a thin-data caveat, NEVER a bare rate. Returns
 * [] when no rule has a recorded block (nothing to disclose). Method names never
 * appear — the uncertainty is stated in plain words only.
 */
function buildFpNotes(
  sortedAspects: AspectDef[],
  fpSignals: ReadonlyMap<string, AspectFalsePositiveSignal>,
  telemetrySince: string | undefined,
  committedNote: string | undefined,
): string[] {
  const detail: string[] = [];
  let hasBlocks = false;
  for (const aspect of sortedAspects) {
    const sig = fpSignals.get(aspect.id);
    if (sig === undefined || sig.blocks === 0) continue;
    hasBlocks = true;
    if (sig.fp === 0) continue;
    const pct = Math.round(sig.shrunkRate * 100);
    // Distinguish a plain waiver (still refused) from an overturn (re-approved after
    // a suppress-range change) — both are false blocks, but the human action differs.
    const how =
      sig.overturned > 0 && sig.suppressed > 0
        ? 'waived or overturned'
        : sig.overturned > 0
          ? 'overturned after a suppress range changed'
          : 'waived by a suppress marker';
    const thin = sig.thinData ? ', few observations' : '';
    detail.push(
      `${aspect.id}: ${sig.fp} of ${sig.blocks} recorded block${sig.blocks === 1 ? '' : 's'} later ${how} (estimated false-block rate ~${pct}%${thin}).`,
    );
  }
  if (!hasBlocks) return [];
  const since = telemetrySince ?? 'the first recorded event';
  const caveat = committedNote ? ` Shared LLM events included (${committedNote}).` : '';
  return [`Local telemetry since ${since}.${caveat}`, ...detail];
}

export function computeAspectHealth(
  graph: Graph,
  verifiedPairs: VerifiedPair[],
  suppressReport: SuppressionsReport,
  ruleAges: ReadonlyMap<string, string> = new Map(),
  signals: ReadonlyMap<string, AspectHealthSignal> = new Map(),
  drillStatuses: ReadonlyMap<string, DrillStatus> = new Map(),
  fpSignals: ReadonlyMap<string, AspectFalsePositiveSignal> = new Map(),
  telemetrySince: string | undefined = undefined,
  committedNote: string | undefined = undefined,
  wrongRuleByAspect: ReadonlyMap<string, number> = new Map(),
): AspectHealth {
  interface Agg {
    pairs: number;
    refused: number;
    unknown: number;
    nodes: Set<string>;
    /** Distinct type-covered files (nodeless pairs) — tracked separately so a
     *  file never inflates the "nodes" count by a phantom component. Rendered
     *  as its own table column, appended after wrong-rule. */
    files: Set<string>;
  }
  const byAspect = new Map<string, Agg>();
  const aggFor = (id: string): Agg => {
    let a = byAspect.get(id);
    if (!a) {
      a = { pairs: 0, refused: 0, unknown: 0, nodes: new Set<string>(), files: new Set<string>() };
      byAspect.set(id, a);
    }
    return a;
  };

  for (const vp of verifiedPairs) {
    const a = aggFor(vp.pair.aspectId);
    a.pairs++;
    if (vp.pair.nodePath !== undefined) a.nodes.add(vp.pair.nodePath);
    else a.files.add(vp.pair.unitKey);
    if (vp.state.kind === 'refused') a.refused++;
    else if (vp.state.kind !== 'verified') a.unknown++;
  }

  // Suppress markers per aspect from the LIVE scan. `enable` markers are range
  // terminators (not waivers); wildcard markers are counted separately and never
  // attributed to one aspect.
  const suppressByAspect = new Map<string, number>();
  let wildcardMarkers = 0;
  for (const { markers } of suppressReport.fileEntries) {
    for (const m of markers) {
      if (m.kind === 'enable') continue;
      if (m.wildcard) {
        wildcardMarkers++;
        continue;
      }
      suppressByAspect.set(m.aspectId, (suppressByAspect.get(m.aspectId) ?? 0) + 1);
    }
  }

  // Whether the `files` question was even askable this run. Read once, from the
  // same graph field `verifyLock`'s own caller (`computeTypeCoverageForAspects`)
  // gates on — never per-row, since it is a whole-run fact, not a per-aspect one.
  const typeLevelEnabled = graph.config.coverage?.typeLevel === true;

  const rows: AspectHealthRow[] = [];
  let hasUnverified = false;
  let hasWrongRuleAttribution = false;
  const sorted = [...graph.aspects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const aspect of sorted) {
    const agg = byAspect.get(aspect.id);
    const pairs = agg?.pairs ?? 0;
    const refused = renderRefusedCell(pairs, agg?.refused ?? 0, agg?.unknown ?? 0);
    if (refused.includes(UNVERIFIED)) hasUnverified = true;
    const cells = signalCells(signals.get(aspect.id));
    const wrongRuleCount = wrongRuleByAspect.get(aspect.id) ?? 0;
    if (wrongRuleCount > 0) hasWrongRuleAttribution = true;
    rows.push({
      aspectId: aspect.id,
      kind: inferAspectDisplayKind(aspect),
      status: aspect.status ?? 'enforced',
      nodes: agg?.nodes.size ?? 0,
      filesCell: typeLevelEnabled ? String(agg?.files.size ?? 0) : EMPTY_CELL,
      pairs,
      refused,
      suppresses: suppressByAspect.get(aspect.id) ?? 0,
      errs: aspect.errs ?? EMPTY_CELL,
      age: ruleAges.get(aspect.id) ?? EMPTY_CELL,
      catchCell: cells.catchCell,
      exposureCell: cells.exposureCell,
      signalCell: cells.signalCell,
      fpCellValue: fpCell(fpSignals.get(aspect.id)),
      wrongRuleCell: wrongRuleCell(wrongRuleCount),
    });
  }

  const signalNotes = buildSignalNotes(sorted, signals, drillStatuses);
  const fpNotes = buildFpNotes(sorted, fpSignals, telemetrySince, committedNote);
  return { rows, wildcardMarkers, hasUnverified, signalNotes, fpNotes, hasWrongRuleAttribution, typeLevelEnabled };
}

/** Column order is fixed by contract; other waves append columns to the right. */
const HEALTH_HEADERS = [
  'aspect',
  'kind',
  'status',
  'nodes',
  'pairs',
  'refused',
  'suppresses',
  'errs',
  'age',
  'catch',
  'exposure',
  'signal',
  'fp',
  'wrong-rule',
] as const;

/**
 * `files` is appended after `wrong-rule` (contract: other waves append columns
 * to the right) ONLY once `coverage.type_level` is on. A repository that never
 * turns the tier on gets exactly `HEALTH_HEADERS` — no trailing column at all —
 * so its `--health` output stays byte-identical to before this column existed,
 * rather than a whole column of fabricated em-dashes or zeros.
 */
export function formatAspectsHealthOutput(health: AspectHealth): string {
  const headers = health.typeLevelEnabled ? [...HEALTH_HEADERS, 'files'] : [...HEALTH_HEADERS];
  const table: string[][] = [
    headers,
    ...health.rows.map((r) => {
      const row = [
        r.aspectId,
        r.kind,
        r.status,
        String(r.nodes),
        String(r.pairs),
        r.refused,
        String(r.suppresses),
        r.errs,
        r.age,
        r.catchCell,
        r.exposureCell,
        r.signalCell,
        r.fpCellValue,
        r.wrongRuleCell,
      ];
      if (health.typeLevelEnabled) row.push(r.filesCell);
      return row;
    }),
  ];

  const widths = headers.map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const lastCol = headers.length - 1;

  const lines = table.map((row) =>
    row.map((cell, c) => (c === lastCol ? cell : cell.padEnd(widths[c]))).join('  '),
  );

  if (health.hasUnverified) {
    lines.push('');
    lines.push(`"${UNVERIFIED}" = not yet checked; run \`yg check --approve\` to resolve.`);
  }
  if (health.wildcardMarkers > 0) {
    lines.push('');
    lines.push(
      `Note: ${health.wildcardMarkers} wildcard suppress marker${health.wildcardMarkers === 1 ? '' : 's'} ${health.wildcardMarkers === 1 ? 'applies' : 'apply'} to every aspect and ${health.wildcardMarkers === 1 ? 'is' : 'are'} not counted per-aspect above.`,
    );
  }

  if (health.signalNotes.length > 0) {
    lines.push('');
    lines.push('Signal detail (catch = violations caught; exposure = times the reviewer judged):');
    for (const note of health.signalNotes) lines.push(`  ${note}`);
  }

  if (health.fpNotes.length > 0) {
    lines.push('');
    lines.push(
      'False-block signal (fp = refusals a human later waived or overturned; a read for a human retirement ritual, never a gate):',
    );
    for (const note of health.fpNotes) lines.push(`  ${note}`);
  }

  if (health.hasWrongRuleAttribution) {
    lines.push('');
    lines.push(
      'Wrong-rule attribution (wrong-rule = committed incidents recorded against this specific rule via `yg incident add --aspect`; ' +
        "a wrong-rule incident recorded WITHOUT --aspect counts in `yg advise`'s total but not here):",
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Assemble the `--health` view: read the lock, verify every pair against current
 * inputs (read-only — no writes, no reviewer calls), run a live suppress scan,
 * resolve each rule's creation age from version control, and fold them into the
 * health table. Reuses the exact core read-only functions the check path uses, so
 * refusal validity is computed identically.
 *
 * `nowMs` is the injected reference instant for the coarse age column (an
 * observability timestamp — it records how long ago each rule was created, not
 * what any verdict is), threaded from the command boundary so the pure renderers
 * stay clock-free and testable.
 */
/** Per-aspect count of active (non-enable, non-wildcard) suppress markers from a live scan. */
function countSuppressesByAspect(report: SuppressionsReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { markers } of report.fileEntries) {
    for (const m of markers) {
      if (m.kind === 'enable' || m.wildcard) continue;
      counts.set(m.aspectId, (counts.get(m.aspectId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The drill-result telemetry the health signal consumes, filtered to the lines that
 * are ACTIONABLE: an in-repo (`dev`) drill run whose `(aspect, case)` still lives in
 * the aspect's CURRENT `drills/` corpus. A holdout (`--dir`) measurement, or a case
 * since removed / renamed (or an aspect with no corpus at all), is an ORPHAN — so it
 * never contributes a drill status (proves-catch / miss) or a demotion-corroboration
 * signal for a corpus that no longer exists. Fail-open: any corpus-discovery failure
 * degrades to an empty list so the read-only `--health` view can never break, and an
 * orphaned drill signal never resurfaces on a discovery hiccup.
 */
async function gatherInCorpusDrillResults(
  graph: Graph,
  projectRoot: string,
): Promise<DrillResultLine[]> {
  try {
    return await filterInCorpusDevDrills(readDrillResults(graph.rootPath).results, projectRoot);
  } catch (error) {
    debugWrite(
      `[aspects] drill telemetry filtered to empty (corpus discovery failed): ${(error as Error).message}`,
    );
    return [];
  }
}

async function buildAspectsHealthOutput(graph: Graph, nowMs: number): Promise<string> {
  const projectRoot = path.dirname(graph.rootPath);

  const lock = readLock(graph.rootPath);
  // Same per-command hoist `formatAspectsOutput`'s branch below already does
  // (computeTypeCoverageForAspects): without threading this through, verifyLock
  // enumerates a component-only pair universe, so a file enforced by its
  // architecture type alone (no owning component) is invisible here — its
  // pairs are never counted and a real refusal recorded against it can never
  // read as refused.
  const typeCoverage = await computeTypeCoverageForAspects(graph, projectRoot);
  const verification = await verifyLock(graph, lock, typeCoverage);

  const repoFiles = await walkRepoFiles(projectRoot);
  const knownAspectIds = new Set(graph.aspects.map((a) => a.id));
  const underApproximatingAspectIds = new Set(
    graph.aspects.filter((a) => a.errs === 'under').map((a) => a.id),
  );
  const suppressReport = await runSuppressionsScan(
    projectRoot,
    repoFiles,
    knownAspectIds,
    collectMappingEntries(graph),
    underApproximatingAspectIds,
    // Reuse the SAME classification `verifyLock` just consumed above — no
    // second pass over every uncovered file.
    collectTypeCoveredFiles(typeCoverage?.covered),
    graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
  );

  // Local, gitignored telemetry — read HERE at the CLI boundary (aspects.ts is on
  // the events-reader allow-list) and handed to the pure signal engine as plain
  // data, so core/aspect-health-signals never imports a reader (G1 boundary). The
  // union stream (local + committed) drives both catch/exposure and the fp join.
  const eventsResult = readVerdictEvents(graph.rootPath);
  const verdictEvents = eventsResult.events;
  const drillResults = await gatherInCorpusDrillResults(graph, projectRoot);

  const currentUnitsByAspect = groupUnitsByAspect(verification.pairs.map((vp) => vp.pair));
  const suppressCountsByAspect = countSuppressesByAspect(suppressReport);
  const signals = computeAspectHealthSignals(graph, {
    verdictEvents,
    drillResults,
    currentUnitsByAspect,
    suppressCountsByAspect,
  });
  const drillStatuses = new Map<string, DrillStatus>(
    graph.aspects.map((a) => [a.id, computeDrillStatus(a.id, drillResults)]),
  );

  // The fp (false-block) signal: past refusals (union event stream) joined against
  // the LIVE suppress coverage. Both inputs are resolved here at the boundary and
  // handed to the pure engine as plain data.
  const suppressedUnitsByAspect = resolveSuppressedUnitsByAspect(graph, suppressReport);
  const fpSignals = computeAspectFalsePositiveSignals(graph, {
    verdictEvents,
    suppressedUnitsByAspect,
  });

  // Committed human testimony — read HERE at the CLI boundary (aspects.ts is a
  // presentation command, permitted to read the incident ledger) and handed to the
  // pure health builder as plain per-aspect counts, exactly as the events telemetry
  // is threaded in. The core health-signal engine never touches this reader.
  const wrongRuleByAspect = countWrongRuleIncidentsByAspect(graph.rootPath);

  const ruleAges = resolveRuleAges(graph, projectRoot, nowMs);
  const health = computeAspectHealth(
    graph,
    verification.pairs,
    suppressReport,
    ruleAges,
    signals,
    drillStatuses,
    fpSignals,
    eventsResult.firstTs,
    eventsResult.committedNote,
    wrongRuleByAspect,
  );
  return formatAspectsHealthOutput(health);
}

/**
 * The type-level classification lattice (coverage.type_level), classified for
 * this one `yg aspects` invocation — mirrors the same per-command hoist
 * `yg impact`/`yg advise` each do their own. Undefined when the flag is off,
 * so computeAspectUsage counts exactly the component-only universe it always
 * has.
 */
async function computeTypeCoverageForAspects(graph: Graph, projectRoot: string): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const gitFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

export function registerAspectsCommand(program: Command): void {
  program
    .command('aspects')
    .description('List aspects with usage stats')
    .option(
      '--health',
      'per-aspect health: pairs, hash-valid refusals, suppress markers, error direction, rule age, catch/exposure counts and reading, false-block (fp) count, and wrong-rule incidents attributed to the rule',
    )
    .action(async (options: { health?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        if (options.health) {
          // Injected reference instant for the coarse rule-age column. Read once
          // here at the command boundary (an observability timestamp — it records
          // how long ago each rule was created, not what any verdict is) and
          // threaded down so the pure renderers never read the clock themselves.
          process.stdout.write(await buildAspectsHealthOutput(graph, Date.now()));
        } else {
          const typeCoverage = await computeTypeCoverageForAspects(graph, path.dirname(graph.rootPath));
          process.stdout.write(formatAspectsOutput(graph, typeCoverage));
        }
      } catch (error) {
        abortOnUnexpectedError(error, 'listing aspects');
      }
    });
}
