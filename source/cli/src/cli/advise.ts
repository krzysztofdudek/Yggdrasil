import type { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import {
  buildNominations,
  buildAttention,
  quoteData,
  type Nomination,
  type NominationSources,
  type SuppressAnomaly,
} from '../core/advise-nominations.js';
import { applyDecisions, type VisibleNomination } from '../core/advise-feed.js';
import { appendDecision, readDecisions, type AdviseDecision } from '../io/advise-decisions-store.js';
import { readDrillResults } from '../io/drill-results-reader.js';
import { readVerdictEvents } from '../io/events-reader.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { runSuppressionsScan, scanPortalSuppressions } from '../portal/api/suppress-scan.js';
import { collectMappingEntries } from '../portal/api/suppress-eligibility.js';
import { computeDetectedEdges } from '../portal/api/boundary.js';
import {
  edgeUniverse,
  tunnelSpans,
  depthOfPath,
  lcaDepthOfPaths,
  TOP_TUNNELS,
  type DeclaredRelation,
} from '../core/graph-metrics.js';
import { isValidReviewByDate } from '../io/aspect-parser.js';
import type { Graph } from '../model/graph.js';

/** The hard cap on rendered nominations (spec §7.2). `--all` removes it. */
const NOMINATION_CAP = 10;

function handleError(error: unknown): never {
  debugWrite(`[advise] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running advise command');
}

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: { what: string; why: string; next: string }): never {
  process.stderr.write(chalk.red(buildIssueMessage(msg)) + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Source gathering (all the I/O lives here, at the CLI boundary — the core
// nomination/attention engine is pure and receives this as plain-data params).
// ---------------------------------------------------------------------------

/** True iff `a` and `b` are the same node or one is an ancestor of the other. */
function isLineage(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Fold the graph's declared relations into the plain-data shape the metrics core
 * consumes — the SAME adaptation `yg structure` performs (non-node and lineage
 * pairs dropped; event relations pass through, `edgeUniverse` filters them). Kept
 * in step with cli/structure.ts's collectDeclaredRelations.
 */
function collectDeclaredRelations(graph: Graph): DeclaredRelation[] {
  const out: DeclaredRelation[] = [];
  for (const [nodeId, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) continue;
      if (isLineage(nodeId, rel.target)) continue;
      out.push({ from: nodeId, to: rel.target, type: rel.type, consumes: rel.consumes ?? [] });
    }
  }
  return out;
}

/**
 * The C7 tunnel count for the Attention line. `yg structure` ranks the structural
 * edge universe (declared structural relations ∪ statically detected dependencies;
 * event relations excluded) by span and DISPLAYS only the widest TOP_TUNNELS of
 * them. The attention line points the reader straight at that view — "run yg
 * structure to see them" — so it must report exactly what structure lists, not the
 * full edge universe: the count is min(TOP_TUNNELS, number of tunnels), using the
 * SAME shared constant structure slices by, so the two can never drift. Any
 * failure degrades to 0 (the line is simply omitted) so the attention computation
 * can never break the exit-0 invariant (G4).
 */
async function computeTunnelCount(graph: Graph): Promise<number> {
  try {
    const projectRoot = path.dirname(graph.rootPath);
    const detected = (await computeDetectedEdges(graph, projectRoot)) ?? new Map();
    const edges = edgeUniverse(collectDeclaredRelations(graph), detected);
    const tunnels = tunnelSpans(edges, depthOfPath, lcaDepthOfPaths).length;
    return Math.min(TOP_TUNNELS, tunnels);
  } catch (error) {
    debugWrite(`[advise] tunnel-count degraded to 0: ${(error as Error).message}`);
    return 0;
  }
}

/** Gather the risky suppress markers live (repo walk + comment-aware scan). */
async function gatherSuppressAnomalies(graph: Graph, projectRoot: string): Promise<SuppressAnomaly[]> {
  try {
    const gitFiles = await walkRepoFiles(projectRoot);
    const knownAspectIds = new Set(graph.aspects.map((a) => a.id));
    const draftAspectIds = new Set(
      graph.aspects.filter((a) => (a.status ?? 'enforced') === 'draft').map((a) => a.id),
    );
    const report = await runSuppressionsScan(
      projectRoot,
      gitFiles,
      knownAspectIds,
      collectMappingEntries(graph),
    );
    const out: SuppressAnomaly[] = [];
    for (const m of scanPortalSuppressions(report, knownAspectIds, draftAspectIds)) {
      if (!m.risk) continue; // only the risky markers become nominations
      out.push({
        file: m.file,
        line: m.line,
        aspectId: m.aspectId,
        risk: m.risk,
        ...(m.reason !== undefined ? { reason: m.reason } : {}),
      });
    }
    return out;
  } catch (error) {
    debugWrite(`[advise] suppress scan degraded to empty: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Gather every non-graph input `buildNominations` needs, at the CLI boundary:
 * risky suppress markers (live scan), drill-result telemetry, and verdict-event
 * telemetry. The core engine imports NONE of these readers — telemetry crosses
 * the boundary as plain data only.
 */
async function gatherNominationSources(graph: Graph, todayUtc: Date): Promise<NominationSources> {
  const projectRoot = path.dirname(graph.rootPath);
  const suppressAnomalies = await gatherSuppressAnomalies(graph, projectRoot);
  const drillResults = readDrillResults(graph.rootPath).results;
  const verdictEvents = readVerdictEvents(graph.rootPath).events;
  return { todayUtc, suppressAnomalies, drillResults, verdictEvents };
}

// ---------------------------------------------------------------------------
// Rendering — two fixed sections (Attention, Nominations)
// ---------------------------------------------------------------------------

/** Render the Attention section: one aggregate line per class, no ranking. */
function renderAttention(lines: string[]): string {
  const body =
    lines.length === 0
      ? ['  No attention items right now.']
      : lines.map((l) => `  ${l}`);
  return [chalk.bold('Attention'), '', ...body].join('\n');
}

/** Render one nomination as a WHAT / WHY / NEXT block, optionally with its id. */
function renderNomination(nom: VisibleNomination, showIds: boolean): string[] {
  const out: string[] = [];
  const note = nom.note ? chalk.dim(` (${nom.note})`) : '';
  out.push(`  ${nom.what}${note}`);
  out.push(`    ${nom.why}`);
  out.push(`    ${nom.next}`);
  // The id embeds raw repo strings (a file path, a drill-case name). Sanitize the
  // RENDERED form only — the canonical id stays intact for evidence-hash matching
  // and for the committed decision line — so no control byte reaches this surface.
  if (showIds) out.push(chalk.dim(`    id: ${quoteData(nom.id)}`));
  return out;
}

/**
 * Render the Nominations section: `visible` capped at 10 (unless `all`), each as
 * a WHAT / WHY / NEXT block; a footer counts what the cap hid; `--all` also lists
 * the currently-suppressed (dismissed / deferred) items.
 */
function renderNominations(
  visible: VisibleNomination[],
  hidden: Nomination[],
  showIds: boolean,
  showAll: boolean,
): string {
  const parts: string[] = [chalk.bold('Nominations'), ''];

  if (visible.length === 0) {
    parts.push('  No nominations right now.');
  } else {
    const cap = showAll ? visible.length : NOMINATION_CAP;
    const shown = visible.slice(0, cap);
    for (const nom of shown) {
      parts.push(...renderNomination(nom, showIds));
      parts.push('');
    }
    if (parts[parts.length - 1] === '') parts.pop();

    const hiddenByCap = visible.length - shown.length;
    if (hiddenByCap > 0) {
      parts.push('');
      parts.push(
        chalk.dim(
          `  … and ${hiddenByCap} more nomination${hiddenByCap === 1 ? '' : 's'} not shown — run yg advise --all to see ${hiddenByCap === 1 ? 'it' : 'them all'}.`,
        ),
      );
    }
  }

  if (showAll && hidden.length > 0) {
    parts.push('');
    parts.push(chalk.dim(`Dismissed / deferred (${hidden.length}):`));
    for (const nom of hidden) {
      parts.push(chalk.dim(`  ${nom.what}`));
      if (showIds) parts.push(chalk.dim(`    id: ${quoteData(nom.id)}`));
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// dismiss / defer helpers (resolve against the SAME live nominations the feed
// renders, so every rendered item is dismissable / deferrable)
// ---------------------------------------------------------------------------

/**
 * Resolve an attention-item id against the current LIVE nominations, or fail with
 * a what/why/next error that names the known ids. Resolving at ack time captures
 * the nomination's CURRENT evidence snapshot, so the decision binds to exactly the
 * evidence the item carries now.
 */
function resolveNominationOrFail(noms: Nomination[], id: string): Nomination {
  // Match on the RAW id — the canonical id is what decisions bind to; only the
  // rendered forms below are sanitized (the id embeds raw repo strings, and both
  // the echoed argument and the known-id list must stay injection-safe).
  const nomination = noms.find((n) => n.id === id);
  if (nomination === undefined) {
    const knownIds = noms.map((n) => quoteData(n.id));
    failWith({
      what: `No current attention item has id '${quoteData(id)}'.`,
      why:
        knownIds.length > 0
          ? 'A dismiss or defer must name a live attention item, but this id matches none of the current items.'
          : 'There are no current attention items, so there is nothing to dismiss or defer.',
      next:
        knownIds.length > 0
          ? `Name one of the current ids: ${knownIds.join(', ')}.`
          : "Run 'yg advise' to see the current items — nothing needs acting on right now.",
    });
  }
  return nomination;
}

/** Reject an empty (or whitespace-only) reason before anything is written. */
function requireNonEmptyReason(reason: string, action: 'dismiss' | 'defer'): void {
  if (reason.trim() !== '') return;
  failWith({
    what: `A ${action} needs a non-empty --reason.`,
    why: 'Each recorded decision is committed precedent, so it must carry a human-signed justification; an empty reason records nothing meaningful.',
    next: `Re-run with --reason "<why you are choosing to ${action} this item>".`,
  });
}

/** Append one decision to the committed register and print a success line. */
async function recordDecision(
  graph: Graph,
  decision: AdviseDecision,
  summary: string,
): Promise<void> {
  await appendDecision(graph.rootPath, decision);
  process.stdout.write(chalk.green(`${summary}\n`));
}

export function registerAdviseCommand(program: Command): void {
  const advise = program
    .command('advise')
    .description(
      'Read-only attention feed: one line per signal class plus up to ten ranked, evidence-backed nominations (never gates; exits 0 when the graph loads)',
    )
    .option('--all', 'Show every nomination (remove the cap) and list dismissed / deferred items')
    .option('--ids', 'Print the stable id under each nomination (for dismiss / defer)')
    .action(async (opts: { all?: boolean; ids?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        // Injected UTC clock at the boundary (Task 1 pattern) — the engine keeps
        // no Date.now of its own.
        const now = new Date();
        const sources = await gatherNominationSources(graph, now);
        const noms = buildNominations(graph, sources);
        const { visible, hidden } = applyDecisions(noms, readDecisions(graph.rootPath).decisions, now);

        const tunnelCount = await computeTunnelCount(graph);
        const attention = buildAttention({ tunnelCount });

        const output = [
          renderAttention(attention),
          '',
          renderNominations(visible, hidden, opts.ids ?? false, opts.all ?? false),
          '',
        ].join('\n');
        process.stdout.write(output);
        // Always exit 0 when the graph loads — this is a read-only attention layer,
        // never a gate (G4).
      } catch (error) {
        handleError(error);
      }
    });

  advise
    .command('dismiss')
    .description('Dismiss an attention item (hidden until its underlying evidence changes)')
    .argument('<id>', 'Attention-item id to dismiss')
    .requiredOption('--reason <text>', 'Human-signed justification (mandatory)')
    .action(async (id: string, opts: { reason: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        requireNonEmptyReason(opts.reason, 'dismiss');
        const now = new Date();
        const noms = buildNominations(graph, await gatherNominationSources(graph, now));
        const nomination = resolveNominationOrFail(noms, id);
        const decision: AdviseDecision = {
          v: 1,
          ts: now.toISOString(),
          id: nomination.id,
          action: 'dismiss',
          evidenceHash: nomination.evidenceHash,
          reason: opts.reason,
        };
        await recordDecision(
          graph,
          decision,
          `Dismissed '${quoteData(nomination.id)}'. It stays hidden until its underlying evidence changes.`,
        );
      } catch (error) {
        handleError(error);
      }
    });

  advise
    .command('defer')
    .description('Defer an attention item until a date, then it returns to the feed')
    .argument('<id>', 'Attention-item id to defer')
    .requiredOption('--until <date>', 'Bare ISO date (YYYY-MM-DD) to hide the item until')
    .requiredOption('--reason <text>', 'Human-signed justification (mandatory)')
    .action(async (id: string, opts: { until: string; reason: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        requireNonEmptyReason(opts.reason, 'defer');
        if (!isValidReviewByDate(opts.until)) {
          failWith({
            what: `--until '${opts.until}' is not a valid calendar date.`,
            why: 'A defer window is a bare ISO calendar day (YYYY-MM-DD); a mis-shaped or impossible date has no defined return point.',
            next: 'Re-run with --until in YYYY-MM-DD form, e.g. --until 2027-01-31.',
          });
        }
        const now = new Date();
        const noms = buildNominations(graph, await gatherNominationSources(graph, now));
        const nomination = resolveNominationOrFail(noms, id);
        const decision: AdviseDecision = {
          v: 1,
          ts: now.toISOString(),
          id: nomination.id,
          action: 'defer',
          evidenceHash: nomination.evidenceHash,
          until: opts.until,
          reason: opts.reason,
        };
        await recordDecision(
          graph,
          decision,
          `Deferred '${quoteData(nomination.id)}' until ${opts.until}. It returns to the feed on or after that date.`,
        );
      } catch (error) {
        handleError(error);
      }
    });
}
