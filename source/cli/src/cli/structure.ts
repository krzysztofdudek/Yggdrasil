import type { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import type { Graph } from '../model/graph.js';
import { computeDetectedEdges } from '../portal/api/boundary.js';
import {
  edgeUniverse,
  tunnelSpans,
  quotientAtDepth,
  changeReach,
  depthOfPath,
  lcaDepthOfPaths,
  ancestorAtDepth,
  TOP_TUNNELS,
  type DeclaredRelation,
  type StructEdge,
} from '../core/graph-metrics.js';

/**
 * `yg structure` — a READ-ONLY structural dashboard over the graph.
 *
 * It never reads or writes the lock and never calls a reviewer: it exits 0
 * whenever the graph LOADS (including a red `yg check` state), and only the
 * loader itself produces a non-zero exit when the graph does not load. This is
 * an instrument, not a gate — its ranking never reaches an exit code or the
 * issue-emission / suggestedNext path (a fence aspect enforces that boundary).
 *
 * The structural edge universe it reports is the union of DECLARED structural
 * relations (calls / uses / extends / implements) and STATICALLY DETECTED code
 * dependencies; event relations (emits / listens) are excluded. It renders three
 * sections computed by the pure core in `core/graph-metrics`:
 *   - Tunnels     — the dependencies that reach farthest across the hierarchy.
 *   - Modules     — how component groups at each level of the tree depend on one another.
 *   - Change reach — how much of the system an average component can reach.
 *
 * Plain language only: the output never names the underlying methods (lowest
 * common ancestor, strongly-connected components, spectral partitioning) — those
 * live in code comments and docs, never in what a person reads.
 */

/** Verbatim edge-universe legend — printed on every run, no matter the graph. */
const EDGE_UNIVERSE_LEGEND =
  'edges = declared structural relations ∪ statically detected dependencies; event relations excluded; weights not computed';

/** How many group names to list before collapsing the tail into a count. */
const MAX_GROUP_NAMES = 12;

/** True iff `a` and `b` are the same node or one is an ancestor of the other. */
function isLineage(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Fold the graph's declared relations into the plain-data shape the metrics core
 * consumes. Only relations whose target is a real node and which are NOT a
 * lineage pair (parent/child/self) are kept — mirroring the detected-edge
 * semantics (an edge is always between two distinct, unrelated nodes). Event
 * relations pass through unfiltered here; `edgeUniverse` drops the ones that are
 * neither structural nor a port contract.
 */
function collectDeclaredRelations(graph: Graph): DeclaredRelation[] {
  const out: DeclaredRelation[] = [];
  for (const [nodeId, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) continue;
      if (isLineage(nodeId, rel.target)) continue;
      out.push({
        from: nodeId,
        to: rel.target,
        type: rel.type,
        consumes: rel.consumes ?? [],
      });
    }
  }
  return out;
}

/** `1 level` / `N levels`, so the span always reads as words, never a bare number. */
function levelsPhrase(span: number): string {
  return span === 1 ? '1 level' : `${span} levels`;
}

/** Join a sorted group list, collapsing a long tail into a plain count. */
function renderGroupList(blocks: string[]): string {
  if (blocks.length <= MAX_GROUP_NAMES) return blocks.join(', ');
  const shown = blocks.slice(0, MAX_GROUP_NAMES).join(', ');
  const rest = blocks.length - MAX_GROUP_NAMES;
  return `${shown} (+${rest} more)`;
}

/**
 * Positive, jargon-free description of whether the crossings between groups form
 * cycles. `sccOutsideShare` is the fraction of crossings that flow between
 * distinct components (i.e. one-way); 1.0 means the whole level is acyclic.
 */
export function cyclePhrase(interBlockCount: number, sccOutsideShare: number): string {
  if (interBlockCount === 0) return 'No dependencies between these groups.';
  const cycleShare = 1 - sccOutsideShare;
  // Only an EXACT-zero cycle share is truly acyclic; any positive share has cycles.
  if (cycleShare <= 0) return 'All dependencies between groups flow one way (no cycles).';
  // Floor: a nonzero cycle share must never round DOWN to "0%" — that would read as
  // "no cycles" when cycles exist (e.g. a 0.3% share). Below the 0.5% rounding
  // threshold it renders "<1%"; only the exact-zero branch above says "one way".
  const rounded = Math.round(cycleShare * 100);
  const cyclePct = rounded === 0 ? '<1' : String(rounded);
  return (
    `${cyclePct}% of the dependencies between groups are part of a cycle ` +
    `(groups that depend on each other); the rest flow one way.`
  );
}

/** Section 1 — the widest-spanning tunnels, named in words. */
function renderTunnels(edges: StructEdge[]): string[] {
  const lines: string[] = [];
  lines.push('Tunnels — dependencies that reach farthest across the hierarchy');
  lines.push('');

  if (edges.length === 0) {
    lines.push('  No structural dependencies between components yet.');
    return lines;
  }

  const spanned = tunnelSpans(edges, depthOfPath, lcaDepthOfPaths);
  // Widest span first; ties broken by (from, to) so the ranking is stable.
  const ranked = [...spanned].sort((a, b) => {
    if (b.span !== a.span) return b.span - a.span;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });

  for (const e of ranked.slice(0, TOP_TUNNELS)) {
    const contract = e.viaContract ? 'via declared contract' : 'no declared contract';
    lines.push(`  ${e.from} → ${e.to} — jumps ${levelsPhrase(e.span)} across the tree, ${contract}`);
  }
  return lines;
}

/** Section 2 — how groups at each depth of the tree depend on one another. */
function renderModules(edges: StructEdge[]): string[] {
  const lines: string[] = [];
  lines.push('Modules — how component groups at each level depend on one another');
  lines.push('');

  if (edges.length === 0) {
    lines.push('  No dependencies between component groups yet.');
    return lines;
  }

  // Beyond the deepest endpoint the quotient stops collapsing, so iterate only
  // up to that depth. A level renders only when it has 2+ groups.
  let maxDepth = 1;
  for (const e of edges) {
    maxDepth = Math.max(maxDepth, depthOfPath(e.from), depthOfPath(e.to));
  }

  let rendered = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const q = quotientAtDepth(edges, depth, ancestorAtDepth);
    if (q.blocks.length < 2) continue;
    rendered++;
    const groupWord = q.blocks.length === 1 ? 'group' : 'groups';
    const depName = q.interBlockEdges.length === 1 ? 'dependency' : 'dependencies';
    lines.push(`  At depth ${depth}:`);
    lines.push(`    ${q.blocks.length} ${groupWord}: ${renderGroupList(q.blocks)}`);
    lines.push(`    ${q.interBlockEdges.length} ${depName} between groups`);
    lines.push(`    ${cyclePhrase(q.interBlockEdges.length, q.sccOutsideShare)}`);
    lines.push('');
  }

  if (rendered === 0) {
    lines.push('  Not enough grouping to show module structure.');
  } else {
    // Trailing blank from the last block — drop it for a tidy join.
    if (lines[lines.length - 1] === '') lines.pop();
  }
  return lines;
}

/** Section 3 — the average forward reachability across the system. */
function renderChangeReach(edges: StructEdge[], nodeIds: string[]): string[] {
  const { mean } = changeReach(edges, nodeIds);
  const pct = Math.round(mean * 100);
  return [
    'Change reach',
    '',
    `  From an average component, ${pct}% of the system is reachable through dependencies.`,
  ];
}

/**
 * Assemble the full dashboard from the loaded graph and the (possibly empty)
 * detected-edge map. Pure — no I/O — so it is unit-testable and deterministic:
 * every collection the metrics core returns is sorted by node id.
 */
export function renderStructure(graph: Graph, detected: Map<string, Set<string>>): string {
  const declared = collectDeclaredRelations(graph);
  const edges = edgeUniverse(declared, detected);
  const nodeIds = [...graph.nodes.keys()];

  const sections: string[][] = [
    ['Structure', '', EDGE_UNIVERSE_LEGEND],
    renderTunnels(edges),
    renderModules(edges),
    renderChangeReach(edges, nodeIds),
  ];

  return sections.map((s) => s.join('\n')).join('\n\n') + '\n';
}

/**
 * The authoritative structural edge universe `yg structure` reports, exposed as
 * plain data so an out-of-band, offline structural report can consume the EXACT
 * same universe the dashboard computes — never a second, drifting graph reader.
 *
 * This is a read-only DATA accessor, not a command handler: it loads the graph and
 * runs the relation pass through the read-only portal facade (parse + resolve; no
 * verdict written, no lock touched), then returns the node ids plus the deduped
 * structural edges (declared structural relations ∪ statically detected
 * dependencies; event relations excluded) — identical to what `registerStructureCommand`
 * assembles before rendering. `fromDir` is the directory to search upward from for
 * the `.yggdrasil/` graph (the project root); a graph-load failure is handled by
 * `loadGraphOrAbort` (the canonical what/why/next message + exit), exactly as the
 * command does.
 */
export async function computeStructuralEdgeUniverse(
  fromDir: string,
): Promise<{ nodeIds: string[]; edges: StructEdge[] }> {
  const graph = await loadGraphOrAbort(fromDir);
  const projectRoot = path.dirname(graph.rootPath);
  const detected = (await computeDetectedEdges(graph, projectRoot)) ?? new Map();
  const declared = collectDeclaredRelations(graph);
  const edges = edgeUniverse(declared, detected);
  const nodeIds = [...graph.nodes.keys()];
  return { nodeIds, edges };
}

export function registerStructureCommand(program: Command): void {
  program
    .command('structure')
    .description(
      'Read-only structural dashboard: dependency tunnels, module groups, and change reach (never gates)',
    )
    .action(async () => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        // Detected code dependencies come through the read-only facade. If the
        // relation parse fails, degrade to the declared-relations-only view
        // (still an honest subset of the universe) rather than fail the command.
        const projectRoot = path.dirname(graph.rootPath);
        const detected = (await computeDetectedEdges(graph, projectRoot)) ?? new Map();

        process.stdout.write(renderStructure(graph, detected));
      } catch (error) {
        abortOnUnexpectedError(error, 'rendering the structural dashboard');
      }
    });
}
