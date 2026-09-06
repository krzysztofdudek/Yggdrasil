import path from 'node:path';
import type { Dirent } from 'node:fs';
import { cp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import type { Graph } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * `yg adopt`'s file-level half: recognizing a proposal directory, reading the
 * provenance a generator left beside it, describing a graph that is already
 * here, and moving the accepted graph into place as a TRANSACTION that can be
 * undone whole.
 *
 * The command file owns wording, flags and exit codes; everything here is
 * mechanism. Accepting a graph is the one moment a repository gains a body of
 * law it did not write, so nothing here is allowed to half-happen: either the
 * repository ends with the proposed graph and any previous one preserved beside
 * it, or it ends exactly as it started.
 */

/** The directory name a graph always lives under, at the root of the repository it governs. */
export const GRAPH_DIR = '.yggdrasil';

/** The metadata file a generator writes beside the graph it proposes. */
const PROPOSAL_METADATA_FILE = 'proposal.json';

/** The per-rule record a generator writes inside the rule's own directory. */
const PROVENANCE_FILE = 'provenance.json';

/** Where a replaced graph is moved to, so accepting a new one never destroys the old one. */
export const REPLACED_DIR_PREFIX = '.yggdrasil.replaced-';

/** A proposal directory, resolved to the two paths everything else needs. */
export interface ResolvedProposal {
  /** The staging directory the user named — where proposal.json and the human documents live. */
  root: string;
  /** The graph inside it, the directory that becomes the repository's own `.yggdrasil/`. */
  graphDir: string;
}

/** What a generator recorded about the run that produced this proposal. */
export interface ProposalProvenance {
  schema?: string;
  engine?: string;
  instrument?: string;
  /** The commit the proposal was derived from. */
  asOf?: string;
  /** How many files the generator read. */
  files?: number;
  /** True when the metadata declares one of Grain's own proposal schemas. */
  mined: boolean;
}

/** How many sites each rule already refuses in this repository, as its generator measured them. */
export interface ExistingViolations {
  /** Rules that carry the measurement at all. */
  measured: number;
  /** Sum across every rule that carries it. */
  total: number;
  /** Per rule, highest first — only rules with at least one site. */
  byAspect: Array<{ aspectId: string; count: number }>;
}

/** A graph already present in the repository, described well enough to name in a refusal. */
export interface ExistingGraphSummary {
  components: number;
  rules: number;
  flows: number;
  /** True when a committed verdict record is present — the graph has been used, not just written. */
  hasRecordedVerdicts: boolean;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (err) {
    debugWrite(`[adopt] not a directory: ${target} (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    debugWrite(`[adopt] absent: ${target} (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/** True when a graph directory is present at this path. */
export async function graphDirExists(target: string): Promise<boolean> {
  return isDirectory(target);
}

/**
 * Recognize the two shapes a proposal can be handed over in: the staging
 * directory that CONTAINS a graph (what a generator writes), or the graph
 * directory itself (what someone gets after unpacking one). Anything else is
 * refused by name rather than guessed at — walking upward for a graph, the way
 * every other command legitimately does, would find the repository's OWN graph
 * and quietly propose to adopt it over itself.
 */
export async function resolveProposal(target: string): Promise<ResolvedProposal | null> {
  const abs = path.resolve(target);
  if (!(await isDirectory(abs))) return null;
  const nested = path.join(abs, GRAPH_DIR);
  if (await isDirectory(nested)) return { root: abs, graphDir: nested };
  if (path.basename(abs) === GRAPH_DIR) return { root: path.dirname(abs), graphDir: abs };
  return null;
}

/** True when the directory looks like a graph at all — the two files every graph has. */
export async function looksLikeGraph(graphDir: string): Promise<boolean> {
  return (
    (await exists(path.join(graphDir, 'yg-config.yaml'))) &&
    (await exists(path.join(graphDir, 'yg-architecture.yaml')))
  );
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    debugWrite(`[adopt] unreadable json ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * What the generator recorded about its own run. Absent metadata is ordinary,
 * not an error: a graph written by hand carries none, and adopting one is a
 * legitimate use of this command. Unreadable metadata is treated the same way —
 * provenance is something to REPORT, never something the acceptance depends on.
 */
export async function readProvenance(proposal: ResolvedProposal): Promise<ProposalProvenance | undefined> {
  const raw = await readJson(path.join(proposal.root, PROPOSAL_METADATA_FILE));
  if (raw === undefined) return undefined;
  const schema = asString(raw.schema);
  return {
    schema,
    engine: asString(raw.engine),
    instrument: asString(raw.instrument),
    asOf: asString(raw.asOf),
    files: asNumber(raw.files),
    mined: schema !== undefined && schema.startsWith('grain-proposal/'),
  };
}

/**
 * How much of the code already here each rule refuses, as measured by whoever
 * produced the proposal. This is the number an adopter is actually asking for
 * and the one nothing else can supply: a rule earns its status from evidence
 * about how the code is USUALLY written, never from a check that the repository
 * is clean today, so a graph can be perfectly well-formed and still refuse
 * hundreds of files the moment it is switched on.
 *
 * Read per rule from the record beside it. A rule with no record contributes
 * nothing and is not counted as a zero — "not measured" and "measured as none"
 * are different claims, and `measured` is what keeps them apart.
 */
export async function readExistingViolations(graphDir: string): Promise<ExistingViolations> {
  const aspectsDir = path.join(graphDir, 'aspects');
  let entries: string[];
  try {
    entries = (await readdir(aspectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    debugWrite(`[adopt] no aspects directory in ${graphDir}: ${err instanceof Error ? err.message : String(err)}`);
    return { measured: 0, total: 0, byAspect: [] };
  }

  let measured = 0;
  let total = 0;
  const byAspect: Array<{ aspectId: string; count: number }> = [];
  for (const aspectId of entries) {
    const raw = await readJson(path.join(aspectsDir, aspectId, PROVENANCE_FILE));
    if (raw === undefined) continue;
    const count = asNumber(raw.existingViolations);
    if (count === undefined) continue;
    measured++;
    total += count;
    if (count > 0) byAspect.push({ aspectId, count });
  }
  byAspect.sort((a, b) => b.count - a.count || (a.aspectId < b.aspectId ? -1 : 1));
  return { measured, total, byAspect };
}

async function countDirectories(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
  } catch (err) {
    debugWrite(`[adopt] cannot count ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function countNodeFiles(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[adopt] cannot walk ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countNodeFiles(path.join(dir, entry.name));
    else if (entry.name === 'yg-node.yaml') total++;
  }
  return total;
}

/**
 * Describe a graph the repository already has, WITHOUT loading it. A refusal to
 * overwrite has to say what is there, and it has to be able to say it even when
 * what is there no longer loads — which is exactly the state someone reaching
 * for a fresh proposal is most likely to be in.
 */
export async function describeExistingGraph(graphDir: string): Promise<ExistingGraphSummary> {
  return {
    components: await countNodeFiles(path.join(graphDir, 'model')),
    rules: await countDirectories(path.join(graphDir, 'aspects')),
    flows: await countDirectories(path.join(graphDir, 'flows')),
    hasRecordedVerdicts: await exists(path.join(graphDir, 'yg-lock.nondeterministic.json')),
  };
}

/** How many rules the graph declares at each status — the shape of what is being switched on. */
export function countRulesByStatus(graph: Graph): { enforced: number; advisory: number; draft: number } {
  const counts = { enforced: 0, advisory: 0, draft: 0 };
  for (const aspect of graph.aspects) {
    const status = aspect.status ?? 'enforced';
    counts[status]++;
  }
  return counts;
}

/**
 * The component an acceptance is recorded against: the shallowest one in the
 * graph, ties broken by name so the choice is the same on every machine. A
 * graph with no components has nowhere to record it, and the caller says so
 * rather than inventing a component to hold the entry.
 */
export function rootComponentPath(graph: Graph): string | undefined {
  const paths = [...graph.nodes.keys()].map((p) => toPosixPath(p));
  if (paths.length === 0) return undefined;
  return paths.sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    return depth !== 0 ? depth : a < b ? -1 : 1;
  })[0];
}

/**
 * The move-into-place step, and everything needed to undo it.
 *
 * A previous graph is never deleted: it is renamed aside, under a name that
 * says what happened to it, and the caller reports where it went. That keeps
 * `--replace` a decision about which graph GOVERNS, not a decision to destroy
 * one — including for a repository that never committed the old one.
 */
export interface InstallTransaction {
  /** Where a previous graph was moved to, when one was. */
  movedAsideTo?: string;
  /** Undo everything this transaction did. Safe to call twice; never throws. */
  rollback: () => Promise<void>;
}

export async function installGraph(
  repoRoot: string,
  proposal: ResolvedProposal,
  now: () => Date,
): Promise<InstallTransaction> {
  const destination = path.join(repoRoot, GRAPH_DIR);
  let movedAsideTo: string | undefined;

  if (await exists(destination)) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    movedAsideTo = path.join(repoRoot, `${REPLACED_DIR_PREFIX}${stamp}`);
    await rename(destination, movedAsideTo);
  }

  try {
    await cp(proposal.graphDir, destination, { recursive: true });
  } catch (err) {
    // The copy failed halfway: put back whatever was here before re-throwing, so
    // a failed acceptance never leaves the repository with neither graph.
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    if (movedAsideTo !== undefined) await rename(movedAsideTo, destination).catch(() => {});
    throw err;
  }

  let undone = false;
  return {
    movedAsideTo,
    rollback: async (): Promise<void> => {
      if (undone) return;
      undone = true;
      try {
        await rm(destination, { recursive: true, force: true });
        if (movedAsideTo !== undefined) await rename(movedAsideTo, destination);
      } catch (err) {
        debugWrite(`[adopt] rollback: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
