import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { computeEffectiveAspects } from '../core/graph/aspects.js';
import type { Graph, AspectStatus } from '../model/graph.js';
import { readLock } from '../io/lock-store.js';
import { verifyLock } from '../core/verify-lock.js';
import type { VerifiedPair } from '../core/verify-lock.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { runSuppressionsScan } from '../portal/api/suppress-scan.js';
import type { SuppressionsReport } from '../portal/api/suppress-scan.js';
import { collectMappingEntries } from '../portal/api/suppress-eligibility.js';

interface AspectUsage {
  architecture: number;
  own: number;
  implied: number;
  flow: number;
  total: number;
}

export function computeAspectUsage(graph: Graph): Map<string, AspectUsage> {
  const usage = new Map<string, AspectUsage>();
  for (const aspect of graph.aspects) {
    usage.set(aspect.id, { architecture: 0, own: 0, implied: 0, flow: 0, total: 0 });
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

  return usage;
}

export function formatAspectsOutput(graph: Graph): string {
  const usage = computeAspectUsage(graph);
  const lines: string[] = [];

  for (const aspect of graph.aspects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const u = usage.get(aspect.id) ?? { architecture: 0, own: 0, implied: 0, flow: 0, total: 0 };
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

    if (u.total === 0) {
      lines.push(chalk.yellow(`  Used by: 0 nodes — orphaned`));
    } else {
      const parts: string[] = [];
      if (u.architecture) parts.push(`architecture: ${u.architecture}`);
      if (u.own) parts.push(`direct: ${u.own}`);
      if (u.implied) parts.push(`implied: ${u.implied}`);
      if (u.flow) parts.push(`flow: ${u.flow}`);
      lines.push(`  Used by: ${u.total} node${u.total === 1 ? '' : 's'} (${parts.join(', ')})`);
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
  /** Total review pairs for this aspect. */
  pairs: number;
  /** Rendered refusal cell — an integer, EMPTY_CELL, or the UNVERIFIED word. */
  refused: string;
  /** Live count of suppress markers targeting this aspect (wildcards excluded). */
  suppresses: number;
  /** Error-direction label ('over' | 'under' | 'exact') or EMPTY_CELL. */
  errs: string;
}

export interface AspectHealth {
  rows: AspectHealthRow[];
  /** Wildcard suppress markers — summarized once, never attributed per-aspect. */
  wildcardMarkers: number;
  /** True when any row's refusal cell reads as unverified (drives the footer note). */
  hasUnverified: boolean;
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
export function computeAspectHealth(
  graph: Graph,
  verifiedPairs: VerifiedPair[],
  suppressReport: SuppressionsReport,
): AspectHealth {
  interface Agg {
    pairs: number;
    refused: number;
    unknown: number;
    nodes: Set<string>;
  }
  const byAspect = new Map<string, Agg>();
  const aggFor = (id: string): Agg => {
    let a = byAspect.get(id);
    if (!a) {
      a = { pairs: 0, refused: 0, unknown: 0, nodes: new Set<string>() };
      byAspect.set(id, a);
    }
    return a;
  };

  for (const vp of verifiedPairs) {
    const a = aggFor(vp.pair.aspectId);
    a.pairs++;
    a.nodes.add(vp.pair.nodePath);
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

  const rows: AspectHealthRow[] = [];
  let hasUnverified = false;
  const sorted = [...graph.aspects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const aspect of sorted) {
    const agg = byAspect.get(aspect.id);
    const pairs = agg?.pairs ?? 0;
    const refused = renderRefusedCell(pairs, agg?.refused ?? 0, agg?.unknown ?? 0);
    if (refused.includes(UNVERIFIED)) hasUnverified = true;
    rows.push({
      aspectId: aspect.id,
      kind: aspect.reviewer.type,
      status: aspect.status ?? 'enforced',
      nodes: agg?.nodes.size ?? 0,
      pairs,
      refused,
      suppresses: suppressByAspect.get(aspect.id) ?? 0,
      errs: aspect.errs ?? EMPTY_CELL,
    });
  }

  return { rows, wildcardMarkers, hasUnverified };
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
] as const;

/** Render the health rows as a left-aligned, two-space-gap text table. */
export function formatAspectsHealthOutput(health: AspectHealth): string {
  const table: string[][] = [
    [...HEALTH_HEADERS],
    ...health.rows.map((r) => [
      r.aspectId,
      r.kind,
      r.status,
      String(r.nodes),
      String(r.pairs),
      r.refused,
      String(r.suppresses),
      r.errs,
    ]),
  ];

  const widths = HEALTH_HEADERS.map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const lastCol = HEALTH_HEADERS.length - 1;

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

  return lines.join('\n') + '\n';
}

/**
 * Assemble the `--health` view: read the lock, verify every pair against current
 * inputs (read-only — no writes, no reviewer calls), run a live suppress scan,
 * and fold the three into the health table. Reuses the exact core read-only
 * functions the check path uses, so refusal validity is computed identically.
 */
export async function buildAspectsHealthOutput(graph: Graph): Promise<string> {
  const projectRoot = path.dirname(graph.rootPath);

  const lock = readLock(graph.rootPath);
  const verification = await verifyLock(graph, lock);

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
  );

  const health = computeAspectHealth(graph, verification.pairs, suppressReport);
  return formatAspectsHealthOutput(health);
}

export function registerAspectsCommand(program: Command): void {
  program
    .command('aspects')
    .description('List aspects with usage stats')
    .option(
      '--health',
      'per-aspect health: pairs, hash-valid refusals, suppress markers, error direction',
    )
    .action(async (options: { health?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        if (options.health) {
          process.stdout.write(await buildAspectsHealthOutput(graph));
        } else {
          process.stdout.write(formatAspectsOutput(graph));
        }
      } catch (error) {
        abortOnUnexpectedError(error, 'listing aspects');
      }
    });
}
