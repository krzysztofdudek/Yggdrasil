import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import {
  buildNominations,
  buildAttention,
  quoteData,
  parseFamilyCandidates,
  type Nomination,
  type NominationSources,
  type SuppressAnomaly,
  type ArchitectureCutCycle,
  type FamilyCandidatesData,
} from '../core/advise-nominations.js';
import { countChurnByNode, ownerOfForGraph } from '../core/node-churn.js';
import { applyDecisions, type VisibleNomination } from '../core/advise-feed.js';
import { groupUnitsByAspect } from '../core/aspect-health-signals.js';
import { computeExpectedPairs } from '../core/pairs.js';
import type { TypeCoverageInput } from '../core/pairs.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverage } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { appendDecision, readDecisions, type AdviseDecision } from '../io/advise-decisions-store.js';
import { readDrillResults } from '../io/drill-results-reader.js';
import { filterInCorpusDevDrills } from '../core/drill-runner.js';
import type { DrillResultLine } from '../io/drill-results-store.js';
import { readVerdictEvents } from '../io/events-reader.js';
import { countIncidents } from '../io/incidents-store.js';
import { walkRepoFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { runSuppressionsScan, scanPortalSuppressions } from '../portal/api/suppress-scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from '../portal/api/suppress-eligibility.js';
import { computeDetectedEdges } from '../portal/api/boundary.js';
import {
  edgeUniverse,
  tunnelSpans,
  depthOfPath,
  lcaDepthOfPaths,
  quotientAtDepth,
  ancestorAtDepth,
  quotientSccs,
  TOP_TUNNELS,
  type DeclaredRelation,
} from '../core/graph-metrics.js';
import { isValidReviewByDate } from '../io/aspect-parser.js';
import { countLiveDeviationFiles } from '../core/feature-index-read.js';
import type { Graph } from '../model/graph.js';

/** The hard cap on rendered nominations (spec §7.2). `--all` removes it. */
const NOMINATION_CAP = 10;

/**
 * How many recent commits the uncovered-hot-spot churn signal looks back over.
 *
 * CHANGE POLICY: this window is a deliberate PARAMETER, not an incidental default.
 * The churn count and the "last N commits" provenance are folded into each hot-spot
 * nomination's evidence hash, so changing this value re-bases the whole class —
 * counts shift and any hot spot previously dismissed/deferred returns to the feed as
 * new (its bound evidence no longer matches). That is correct (a different window is
 * a different measurement), but treat a change as a deliberate re-baseline of the
 * class, not a silent tweak: prefer it only when the repo's commit cadence makes 200
 * commits span too little or too much wall-clock history to be a useful "recent"
 * horizon.
 */
const CHURN_WINDOW = 200;

function handleError(error: unknown): never {
  debugWrite(`[advise] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running advise command');
}

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: { what: string; why: string; next: string }): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
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

/**
 * The family-without-law candidates (T2 class A) at the CLI boundary: read the
 * offline miner's `.family-candidates.json` PRESENT-OR-OMIT, then hand the parsed
 * value to the pure core freshness gate — a moved format / schema-lineage, a bad
 * timestamp, or a garbled / unreadable file all degrade to undefined so the class
 * is silently omitted and the exit-0 invariant (G4) can never break. (The gate keys
 * on the file's own format version, which is anchored to the live shard schema by a
 * build-time coupling test — see `CANDIDATES_SHARD_SCHEMA` — so this read-only
 * command's layer never has to import the relation-analysis subsystem.) The
 * candidates file is telemetry the miner writes; nothing here writes or runs it.
 */
function readFamilyCandidatesSource(graph: Graph): FamilyCandidatesData | undefined {
  try {
    const file = path.join(graph.rootPath, '.family-candidates.json');
    if (!existsSync(file)) return undefined; // present-or-omit — absence is silent
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return parseFamilyCandidates(parsed);
  } catch (error) {
    debugWrite(`[advise] family candidates omitted: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The architecture-cut cycles (T2 class B) at the CLI boundary. Builds the
 * structural edge universe from the committed graph's DECLARED relations ONLY
 * (empty detected map — the AST relation pass is NEVER run here, so the result is
 * reproducible across machines from the committed graph alone), then collects
 * every non-trivial (size ≥ 2) strongly-connected group of the quotient at each
 * depth via the shared `quotientSccs` helper. A loop is reported at the COARSEST
 * depth it first becomes visible; a finer re-manifestation of an already-reported
 * loop is suppressed (a depth-d group whose blocks project onto ≥ 2 blocks of a
 * shallower reported group is that same loop at finer grain). Any failure degrades
 * to an empty list so the exit-0 invariant (G4) can never break.
 */
function computeArchitectureCutCycles(graph: Graph): ArchitectureCutCycle[] {
  try {
    const edges = edgeUniverse(collectDeclaredRelations(graph), new Map());
    let maxDepth = 0;
    for (const e of edges) maxDepth = Math.max(maxDepth, depthOfPath(e.from), depthOfPath(e.to));
    const out: ArchitectureCutCycle[] = [];
    const emitted: Array<{ depth: number; blocks: Set<string> }> = [];
    for (let d = 1; d <= maxDepth; d++) {
      const q = quotientAtDepth(edges, d, ancestorAtDepth);
      for (const scc of quotientSccs(q.blocks, q.interBlockEdges)) {
        if (scc.length < 2) continue; // trivial component — no loop
        const covered = emitted.some((prev) => {
          const proj = new Set(scc.map((b) => ancestorAtDepth(b, prev.depth)));
          return proj.size >= 2 && [...proj].every((p) => prev.blocks.has(p));
        });
        if (covered) continue; // finer view of a loop already reported coarser
        const blocks = [...scc].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        emitted.push({ depth: d, blocks: new Set(blocks) });
        out.push({ depth: d, blocks });
      }
    }
    return out;
  } catch (error) {
    debugWrite(`[advise] architecture-cut cycles omitted: ${(error as Error).message}`);
    return [];
  }
}

/**
 * The C8 live structural-deviation count for the Attention line: how many files the
 * local `.feature-field.json` index still records as structural outliers under the
 * exact-bytes match rule `yg context --file` uses (a file whose bytes changed since
 * the index was written is not counted). The index read is the reader's job — this
 * only threads the repo root (the parent of the `.yggdrasil/` dir) to it. The reader
 * is already tolerant (a missing / garbled index yields 0), and any unexpected
 * failure degrades to 0 here too, so the attention computation can never break the
 * exit-0 invariant (G4). It publishes a bare aggregate that points the reader at
 * `yg context` for the per-file detail — never a ranking, a list, or a nomination.
 */
function computeDeviationCount(graph: Graph): number {
  try {
    const projectRoot = path.dirname(graph.rootPath);
    return countLiveDeviationFiles(graph.rootPath, projectRoot);
  } catch (error) {
    debugWrite(`[advise] deviation-count degraded to 0: ${(error as Error).message}`);
    return 0;
  }
}

/**
 * One live suppress scan → both the risky-marker anomalies (nomination inputs) and
 * the per-aspect non-wildcard marker counts (the decorative-rule no-suppress-history
 * signal). A single scan feeds both so the walk runs once. On any failure the whole
 * thing degrades to undefined — the caller then omits BOTH, so the decorative-rule
 * source (which must NOT run on an unknown suppress state) simply does not fire.
 */
interface SuppressData {
  anomalies: SuppressAnomaly[];
  counts: Map<string, number>;
}

async function gatherSuppressData(
  graph: Graph,
  projectRoot: string,
  typeCoverage: TypeCoverageInput | undefined,
): Promise<SuppressData | undefined> {
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
      // No under-approximating warnings wanted here (unchanged) — advise's own
      // scan only ever consumed anomalies/counts, never `report.warnings`.
      undefined,
      collectTypeCoveredFiles(typeCoverage?.covered),
      graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
    );
    const anomalies: SuppressAnomaly[] = [];
    for (const m of scanPortalSuppressions(report, knownAspectIds, draftAspectIds)) {
      if (!m.risk) continue; // only the risky markers become nominations
      anomalies.push({
        file: m.file,
        line: m.line,
        aspectId: m.aspectId,
        risk: m.risk,
        ...(m.reason !== undefined ? { reason: m.reason } : {}),
      });
    }
    const counts = new Map<string, number>();
    for (const { markers } of report.fileEntries) {
      for (const mk of markers) {
        if (mk.kind === 'enable' || mk.wildcard) continue;
        counts.set(mk.aspectId, (counts.get(mk.aspectId) ?? 0) + 1);
      }
    }
    return { anomalies, counts };
  } catch (error) {
    debugWrite(`[advise] suppress scan degraded to empty: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The type-level classification lattice (coverage.type_level), classified ONCE
 * for this one `yg advise` invocation and shared by every source that needs it
 * (the decorative-rule signal's expected-pairs pass, the dead-attach source,
 * and the suppress scan's file eligibility — a live waiver on a file enforced
 * by its architecture type alone must be inventoried too), so no downstream
 * caller classifies the repo's files a second time. Undefined when the flag is
 * off, so a caller's own computeExpectedPairs/checkAspectEffectiveNowhere call
 * enumerates exactly the component-only universe it always has, and the
 * suppress scan's noise filter applies to type-covered extensions exactly as
 * it always has.
 */
async function computeTypeCoverageForAdvise(graph: Graph, projectRoot: string): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const gitFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  const result = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/**
 * `computeTypeCoverageForAdvise`, fail-safe: classification is best-effort at
 * this boundary, so a failure degrades to undefined (the component-only
 * universe) rather than aborting the whole `yg advise` run — mirroring
 * `gatherCurrentUnits`'s own degrade-on-failure contract below.
 */
async function gatherTypeCoverageForAdvise(graph: Graph, projectRoot: string): Promise<TypeCoverageInput | undefined> {
  try {
    return await computeTypeCoverageForAdvise(graph, projectRoot);
  } catch (error) {
    debugWrite(`[advise] type coverage classification degraded to component-only: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The current expected units per aspect (aspectId → unit keys) — the decorative-rule
 * shrinking-attach-set signal compares this against the units the fill telemetry
 * recorded. Fail-safe: any failure degrades to undefined so no demotion is nominated.
 * `typeCoverage` is the SAME classification the caller already gathered
 * (`gatherTypeCoverageForAdvise`) — never reclassified here.
 */
async function gatherCurrentUnits(graph: Graph, typeCoverage: TypeCoverageInput | undefined): Promise<Map<string, Set<string>> | undefined> {
  try {
    const { pairs } = await computeExpectedPairs(graph, { typeCoverage });
    return groupUnitsByAspect(pairs);
  } catch (error) {
    debugWrite(`[advise] expected-pairs degraded to empty: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Parse `git log --name-only --format=%H` output into one touch set per commit.
 * Each commit block is a full-length commit-hash line (40 hex for sha-1, 64 for
 * sha-256), a blank line, then the changed files (one repo-relative POSIX path per
 * line) until the next hash. Blank lines separate the header from the file list and
 * are ignored; an empty commit (e.g. a merge with no listed files) yields an empty
 * touch set, which contributes no churn. Pure — string in, per-commit path arrays
 * out.
 */
function parseNameOnlyLog(output: string): string[][] {
  const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // sha-1 (40) or sha-256 (64)
  const commits: string[][] = [];
  let current: string[] | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') continue;
    if (HASH.test(line)) {
      current = [];
      commits.push(current);
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  return commits;
}

/**
 * Assemble the per-node churn signal for the uncovered-hot-spot nomination: run a
 * READ-ONLY `git log` over the recent window, parse it to per-commit touch sets, and
 * count per node via the SAME owner index the checker uses. This is the only impure
 * step in the churn path (the counting core is pure). HONESTY LAW ([RZ-21]): churn is
 * used ONLY when git is present AND the repo has its FULL history; otherwise this
 * returns undefined so the caller OMITS the churn source entirely and the hot-spot
 * class stays SILENT rather than fabricating a signal over history it could not read.
 * Two silence gates:
 *   - shallow clone — `git log -n 200` on a shallow repo exits 0 and returns a
 *     TRUNCATED window, which would undercount churn while the "last 200 commits"
 *     provenance overstates it; `--is-shallow-repository` catches that before any
 *     count is trusted.
 *   - no readable history — git missing, not a repo, or the subprocess fails for any
 *     reason (the shallow probe throwing counts here too: an unconfirmed history is
 *     honest silence).
 * An empty map (git present, full history, but no window commit touched any node) is
 * a DIFFERENT, honest outcome: the class runs and simply produces nothing.
 */
async function gatherChurnByNode(
  graph: Graph,
  projectRoot: string,
): Promise<Map<string, { churn: number; files: string[] }> | undefined> {
  const gitOpts = {
    cwd: projectRoot,
    encoding: 'utf-8' as const,
    // Mutable element type (NOT `as const`): execFileSync's stdio option is a
    // mutable array, so a readonly tuple fails the overload.
    stdio: ['pipe', 'pipe', 'pipe'] as ('pipe' | 'inherit' | 'ignore')[],
  };
  try {
    // Gate 1: a shallow clone has a truncated history — never count over a partial
    // window. A missing git / non-repo makes this throw → the catch turns it into
    // honest silence too.
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], gitOpts).trim();
    if (shallow === 'true') {
      debugWrite('[advise] churn signal silent (shallow clone — truncated history would miscount)');
      return undefined;
    }
    const out = execFileSync('git', ['log', '-n', String(CHURN_WINDOW), '--name-only', '--format=%H'], {
      ...gitOpts,
      maxBuffer: 64 * 1024 * 1024,
    });
    return countChurnByNode(parseNameOnlyLog(out), await ownerOfForGraph(graph));
  } catch (error) {
    debugWrite(`[advise] churn signal silent (no readable git history): ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The drill-result telemetry the drill-MISS nomination consumes, filtered to the
 * lines that are ACTIONABLE: an in-repo (`dev`) drill run whose `(aspect, case)`
 * still lives in the aspect's CURRENT `drills/` corpus. A holdout (`--dir`)
 * measurement, or a case since removed / renamed (or an aspect with no corpus at
 * all), is an ORPHAN — there is nothing here left to re-drill or retire — so it is
 * dropped rather than surfaced as a dead "regression no longer caught" alarm or a
 * stale re-drill note. Fail-open (G4): any corpus-discovery failure degrades to an
 * empty list, so the read-only feed keeps its exit-0 invariant and an orphan never
 * resurfaces on a discovery hiccup.
 */
async function gatherInCorpusDrillResults(
  graph: Graph,
  projectRoot: string,
): Promise<DrillResultLine[]> {
  try {
    return await filterInCorpusDevDrills(readDrillResults(graph.rootPath).results, projectRoot);
  } catch (error) {
    debugWrite(
      `[advise] drill telemetry filtered to empty (corpus discovery failed): ${(error as Error).message}`,
    );
    return [];
  }
}

/**
 * Gather every non-graph input `buildNominations` needs, at the CLI boundary:
 * risky suppress markers (live scan), drill-result telemetry, verdict-event
 * telemetry, and per-node churn (git history). The core engine imports NONE of
 * these readers — telemetry and history cross the boundary as plain data only.
 */
async function gatherNominationSources(graph: Graph, todayUtc: Date): Promise<NominationSources> {
  const projectRoot = path.dirname(graph.rootPath);
  // Classified once here, then shared by every source below that needs it —
  // no downstream helper repeats the classification pass. In particular, the
  // suppress scan below needs it too: a live waiver on a file enforced by its
  // architecture type alone (no owning component) must be inventoried exactly
  // like one on a mapped node source.
  const typeCoverage = await gatherTypeCoverageForAdvise(graph, projectRoot);
  const suppressData = await gatherSuppressData(graph, projectRoot, typeCoverage);
  const drillResults = await gatherInCorpusDrillResults(graph, projectRoot);
  const verdictEvents = readVerdictEvents(graph.rootPath).events;
  const currentUnitsByAspect = await gatherCurrentUnits(graph, typeCoverage);
  const churnByNode = await gatherChurnByNode(graph, projectRoot);
  const familyCandidates = readFamilyCandidatesSource(graph);
  const architectureCutCycles = computeArchitectureCutCycles(graph);

  const sources: NominationSources = {
    todayUtc,
    suppressAnomalies: suppressData?.anomalies ?? [],
    drillResults,
    verdictEvents,
    typeCoverage,
  };
  // The decorative-rule source needs BOTH the current attach sets and the suppress
  // counts; supply them only when both resolved, so an unknown suppress state or an
  // unreadable graph can never let a demotion be nominated on incomplete evidence.
  if (currentUnitsByAspect !== undefined && suppressData !== undefined) {
    sources.currentUnitsByAspect = currentUnitsByAspect;
    sources.suppressCountsByAspect = suppressData.counts;
  }
  // The uncovered-hot-spot source needs both the churn map and the window it was
  // measured over; supply them only when churn is KNOWN (git history readable), so a
  // no-git / shallow clone leaves the class silent instead of fabricating churn.
  if (churnByNode !== undefined) {
    sources.churnByNode = churnByNode;
    sources.churnWindow = CHURN_WINDOW;
  }
  // T2 class A: a FRESH family-candidates payload (present-or-omit + freshness
  // gate) enables the family-without-law class; absent/stale ⇒ left unset ⇒ omitted.
  if (familyCandidates !== undefined) {
    sources.familyCandidates = familyCandidates;
  }
  // T2 class B: the reproducible declared-only quotient cycles; empty ⇒ left unset.
  if (architectureCutCycles.length > 0) {
    sources.architectureCutCycles = architectureCutCycles;
  }
  return sources;
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
        // The C8 structural-deviation line points the reader at `yg context --file`,
        // the exact surface that `signals.attention: false` silences (absent `signals`
        // ⇒ ON, mirroring cli/build-context.ts). Honor the SAME off-switch here: when
        // attention is disabled, skip the index read and pass 0 so buildAttention omits
        // the C8 line rather than pointing at a surface the user turned off. The C7
        // tunnels line is unrelated to signals.attention and is always shown.
        const deviationCount =
          graph.config.signals?.attention !== false ? computeDeviationCount(graph) : 0;
        // The incident reality-counter is the tower's only EXTERNAL oracle, not a
        // structural signal — it is always read and always shown (0 or N), never
        // gated by signals.attention (which governs the internal structural lines).
        const { total: incidentCount, wrongRule: wrongRuleIncidentCount } = countIncidents(
          graph.rootPath,
        );
        const attention = buildAttention({
          tunnelCount,
          deviationCount,
          incidentCount,
          wrongRuleIncidentCount,
        });

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
            what: `--until '${quoteData(opts.until)}' is not a valid calendar date.`,
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
          `Deferred '${quoteData(nomination.id)}' until ${quoteData(opts.until)}. It returns to the feed on or after that date.`,
        );
      } catch (error) {
        handleError(error);
      }
    });
}
