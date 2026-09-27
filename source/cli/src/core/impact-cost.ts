/**
 * What `yg impact` answers, computed: which pairs an edit to a file
 * invalidates, what re-verifying a component, a rule, a type or a type-covered
 * file costs, and the blast radius of a change to a rule, a flow or a type.
 * Facts only, returned as data (model/impact.ts); the command decides what to
 * refuse and the formatter (formatters/impact-text.ts) words the answer.
 *
 * Never runs repository code: a companion is resolved only by
 * `yg check --approve`, so a cold companion pair is counted as a potential
 * invalidation, the same upper bound a cold script pair gets.
 */
import { join } from 'node:path';
import { collectAncestors } from './context-builder.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import { collectDescendants } from './graph/traversal.js';
import { classifyInvalidations, collectIndirectDependents, nodesWithRefusedVerdict } from './graph/impact-graph.js';
import type { ImpactSet } from './graph/impact-graph.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { walkRepoFiles, resolveGraphExclusionSet, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { scanStrictBackward } from './checks/mapping.js';
import { computeExpectedPairs } from './pairs.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { scanUncoveredFiles } from './check.js';
import { computeTypeCoverageCached } from './type-coverage.js';
import { selectTierForAspect } from './tier-selection.js';
import type { AspectDef, Graph, GraphNode } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type {
  AspectFillCost,
  AspectImpact,
  AspectImpactRow,
  FlowImpact,
  GraduationPreview,
  ImpactNodeRow,
  ImpactSummary,
  NodeFillCost,
  StrictCoverageGap,
  TypeCoveredFileRow,
  TypeVerdictImpact,
  UnresolvedUnit,
} from '../model/impact.js';

/**
 * The type-level classification lattice (coverage.type_level), classified for
 * this one command invocation — mirrors runCheck's own hoist (core/check.ts),
 * but at the scale of a single `yg impact` call rather than a whole check run.
 * Undefined when the flag is off, so computeExpectedPairs enumerates exactly
 * the component-only universe it always has.
 */
async function computeTypeCoverageForImpact(graph: Graph, projectRoot: string): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const repoFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, repoFiles);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/** The reviewer calls one LLM pair of `aspectId` bills: its resolved tier's consensus, else one. */
function callsPerPair(graph: Graph, aspectId: string): number {
  const reviewer = graph.config.reviewer;
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
  return tier?.ok ? tier.tier.consensus : 1;
}

// ============================================================
// collectInvalidatedPairs — never runs repository code
// ============================================================

/**
 * collectInvalidatedPairs' own ImpactSet, plus the full expected-pair universe
 * and type-coverage classification this ONE invocation already computed —
 * exposed so a caller needing more than the invalidation set (e.g. the
 * graduation preview for a nodeless `--file` target) can reuse them instead of
 * paying a second computeExpectedPairs/computeTypeCoverage enumeration in the
 * same command run — a whole-repository pair enumeration is expensive enough
 * that no single command invocation should ever pay for it twice.
 */
export interface CollectedImpact extends ImpactSet {
  allPairs: ExpectedPair[];
  typeCoverage: TypeCoverageInput | undefined;
}

export async function collectInvalidatedPairs(
  graph: Graph,
  repoRelative: string,
  lock: LockFile,
  projectRoot: string,
): Promise<CollectedImpact> {
  const typeCoverage = await computeTypeCoverageForImpact(graph, projectRoot);
  const { pairs } = await computeExpectedPairs(graph, { typeCoverage });
  const { pairs: admitted, coldCompanionCandidates } = classifyInvalidations(pairs, graph, repoRelative, lock);
  // A cold companion pair (no verdict yet, this file within what its companion
  // may read) is admitted as a POTENTIAL invalidation, the same upper bound a
  // cold deterministic pair gets — its companion.mjs is not run to narrow it.
  // `yg impact` is a read-only question, and a companion is repository code: it
  // runs only under `yg check --approve`, never to answer "what would this cost".
  const unresolved: UnresolvedUnit[] = [];
  for (const p of coldCompanionCandidates) {
    admitted.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, kind: p.kind, reasons: ['cold-potential-companion'], mode: 'potential' });
  }
  return { pairs: admitted, unresolved, allPairs: pairs, typeCoverage };
}

/** Every descendant of a node, as sorted paths; empty for a path the graph does not hold. */
export function descendantPaths(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  return collectDescendants(node).map((d) => d.path).sort();
}

// ============================================================
// A rule
// ============================================================

/** The channel a rule reaches a component through: its own list, an ancestor, a flow, or an implication. */
function aspectSource(graph: Graph, node: GraphNode, nodePath: string, aspectId: string): string {
  if ((node.meta.aspects ?? []).includes(aspectId)) return 'own';
  let anc = node.parent;
  while (anc) {
    if ((anc.meta.aspects ?? []).includes(aspectId)) return `hierarchy from ${anc.path}`;
    anc = anc.parent;
  }
  const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
  const flow = graph.flows.find(
    (f) =>
      (f.aspects ?? []).includes(aspectId) &&
      f.nodes.some((n) => ancestorPaths.has(n)),
  );
  return flow ? `flow: ${flow.name}` : 'implied';
}

/**
 * The blast radius of a change to `aspect`: every component it reaches and
 * through which channel, the structural dependents of those, the flows that
 * propagate it, what implies it and what it implies, and what re-filling its
 * pairs costs.
 */
export async function aspectImpactOf(graph: Graph, aspect: AspectDef, lock: LockFile, projectRoot: string): Promise<AspectImpact> {
  const aspectId = aspect.id;
  // Nodes currently holding a refused verdict for this aspect (lock scan). Guarded
  // against the graph's own exclusion set so a stale refused verdict on a file the
  // graph no longer counts as covered (excluded after the verdict was recorded,
  // before the next --approve's GC prunes it) is never shown here as a live
  // refusal every other ownership surface already calls excluded.
  const exclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  const refusedNodes = nodesWithRefusedVerdict(graph, lock, aspectId, exclusion);

  const affected: AspectImpactRow[] = [];
  for (const [nodePath, node] of graph.nodes) {
    if (!computeEffectiveAspects(node, graph).has(aspectId)) continue;
    const status = computeEffectiveAspectStatuses(node, graph).get(aspectId) ?? aspect.status ?? 'enforced';
    affected.push({ path: nodePath, source: aspectSource(graph, node, nodePath, aspectId), status, refused: refusedNodes.has(nodePath) });
  }
  affected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { indirectPaths, chains } = collectIndirectDependents(graph, affected.map((a) => a.path));

  return {
    aspectId,
    affected,
    indirectPaths,
    chains,
    propagatingFlows: graph.flows.filter((f) => (f.aspects ?? []).includes(aspectId)).map((f) => f.name),
    impliedBy: graph.aspects.filter((a) => (a.implies ?? []).includes(aspectId)).map((a) => a.id),
    implies: aspect.implies ?? [],
    // Cost: how many pairs of THIS aspect would become unverified, and (for an LLM
    // aspect) the reviewer calls a re-fill would cost. per: file scope produces one
    // unit per subject file, so count from the expected-pair set, not node count.
    cost: await computeAspectFillCost(graph, aspectId, projectRoot),
  };
}

/**
 * Cost of re-filling every pair of `aspectId` after a change to it: the unit
 * count (one per expected pair) and, for an LLM aspect, the reviewer calls a
 * re-fill would dispatch (units × the resolved tier consensus). Deterministic
 * aspects are free (0 reviewer calls).
 */
async function computeAspectFillCost(graph: Graph, aspectId: string, projectRoot: string): Promise<AspectFillCost> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  const typeCoverage = await computeTypeCoverageForImpact(graph, projectRoot);
  const { pairs } = await computeExpectedPairs(graph, { typeCoverage });
  const aspectPairs = pairs.filter((p) => p.aspectId === aspectId);
  const units = aspectPairs.length;
  const fileUnits = aspectPairs.filter((p) => p.nodePath === undefined).length;

  if (!aspect || aspect.reviewer.type === 'deterministic') {
    return { kind: 'deterministic', units, fileUnits, reviewerCalls: 0 };
  }
  if (aspect.reviewer.type !== 'llm') {
    return { kind: 'unknown', units, fileUnits, reviewerCalls: 0 };
  }

  const reviewer = graph.config.reviewer;
  const tier = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
  const consensus = tier?.ok ? tier.tier.consensus : 1;
  return { kind: 'llm', units, fileUnits, reviewerCalls: units * consensus };
}

// ============================================================
// A file, a node, a type-covered file
// ============================================================

export function summarizeImpact(set: ImpactSet, graph: Graph, lock: LockFile): ImpactSummary {
  const rows = new Map<string, ImpactNodeRow>();
  let billed = 0, free = 0, greens = 0, fileLevelPairs = 0;
  for (const p of set.pairs) {
    // A nodeless (type-covered-file) pair has no component row to join — it
    // is still counted in the run TOTALS below (a wrong total may not ship:
    // this file's own pairs are real cost, whether or not any component row
    // exists to display them against).
    if (p.nodePath === undefined) {
      fileLevelPairs += 1;
      if (p.kind === 'llm') billed += callsPerPair(graph, p.aspectId);
      else free += 1;
      if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greens += 1;
      continue;
    }
    const nodePath = p.nodePath;
    const row = rows.get(nodePath) ?? { nodePath, llmPairs: 0, reviewerCalls: 0, detPairs: 0, reasons: [] };
    for (const r of p.reasons) if (!row.reasons.includes(r)) row.reasons.push(r);
    if (p.kind === 'llm') {
      const calls = callsPerPair(graph, p.aspectId);
      row.llmPairs += 1; row.reviewerCalls += calls; billed += calls;
    } else { row.detPairs += 1; free += 1; }
    if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greens += 1;
    rows.set(nodePath, row);
  }
  const byNode = [...rows.values()].sort((a, b) => (a.nodePath < b.nodePath ? -1 : a.nodePath > b.nodePath ? 1 : 0));
  return { billedReviewerCalls: billed, freeDeterministic: free, greensReRolled: greens, byNode, unresolved: set.unresolved, fileLevelPairs };
}

/**
 * Cost of re-verifying a node's own pairs after an edit to it: the LLM vs
 * deterministic pair split, the reviewer calls a re-fill would dispatch (Σ each
 * LLM pair's resolved tier consensus — aspects may sit on different tiers), and
 * the count of currently-green verdicts the edit re-rolls.
 *
 * Scope is the OWNER node's pairs (NOT graph-wide). When `editedFile` is given
 * (the `--file` form), the set is further narrowed to pairs whose subject set
 * includes that file, so a single-file edit reports only the pairs it actually
 * touches. Greens are counted within the SAME filtered set as the cost.
 */
export async function computeNodeFillCost(
  graph: Graph,
  nodePath: string,
  lock: LockFile,
  editedFile?: string,
): Promise<NodeFillCost> {
  const { pairs } = await computeExpectedPairs(graph);
  const scoped = pairs.filter(
    (p) =>
      p.nodePath === nodePath &&
      (editedFile === undefined || p.subjectFiles.includes(editedFile)),
  );

  let llmPairs = 0;
  let detPairs = 0;
  let reviewerCalls = 0;
  let greensReRolled = 0;
  for (const p of scoped) {
    if (p.kind === 'llm') {
      llmPairs += 1;
      reviewerCalls += callsPerPair(graph, p.aspectId);
    } else {
      detPairs += 1;
    }
    if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') {
      greensReRolled += 1;
    }
  }

  return { llmPairs, detPairs, reviewerCalls, greensReRolled };
}

/**
 * Cost of giving a type-covered file (enforced by its architecture type
 * alone, no owning component) a component of its own: every one of its OWN
 * pairs would re-verify, because a component pair's hash inputs include its
 * nodePath — going from undefined to a real path changes that input for
 * EVERY pair on the file, whether or not the rule itself changed.
 * computeNodeFillCost's own filter (`p.nodePath === nodePath`) structurally
 * cannot see a nodeless pair (nodePath is undefined, never equal to a real
 * node path), so this is a separate function, not a modification of it — the
 * component path stays byte-identical.
 *
 * `precomputedPairs`, when given, is used INSTEAD of a fresh
 * computeExpectedPairs call — the caller (yg impact --file) already computed
 * the full pair universe once for this invocation's invalidation set, and a
 * whole-repository pair enumeration is too expensive to pay for twice in one
 * command run. Omit it to call this standalone (it then computes its own,
 * once).
 */
export async function computeGraduationPreview(
  graph: Graph,
  file: string,
  tc: TypeCoverageInput,
  precomputedPairs?: ExpectedPair[],
): Promise<GraduationPreview> {
  const pairs = precomputedPairs ?? (await computeExpectedPairs(graph, { typeCoverage: tc })).pairs;
  const currentType = tc.covered.get(file) ?? '';

  let llmPairsReVerified = 0;
  let detPairsReVerified = 0;
  let reviewerCalls = 0;
  for (const p of pairs) {
    if (p.nodePath !== undefined) continue;
    if (!p.subjectFiles.includes(file)) continue;
    if (p.kind === 'llm') {
      llmPairsReVerified += 1;
      reviewerCalls += callsPerPair(graph, p.aspectId);
    } else {
      detPairsReVerified += 1;
    }
  }

  return { file, currentType, llmPairsReVerified, reviewerCalls, detPairsReVerified };
}

// ============================================================
// A flow
// ============================================================

/**
 * The blast radius of a change to a flow's rules or participants: every
 * participant, declared or a descendant of one, and their structural
 * dependents. `flow` must exist in the graph.
 */
export function flowImpactOf(graph: Graph, flow: Graph['flows'][number]): FlowImpact {
  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    if (graph.nodes.has(nodePath)) {
      participants.add(nodePath);
      for (const desc of descendantPaths(graph, nodePath)) participants.add(desc);
    }
  }
  const sorted = [...participants].sort();
  const { indirectPaths, chains } = collectIndirectDependents(graph, sorted);
  return {
    flowName: flow.name,
    participants: sorted.map((p) => ({ path: p, declared: flow.nodes.includes(p) })),
    indirectPaths,
    chains,
    flowAspects: flow.aspects ?? [],
  };
}

// ============================================================
// A type
// ============================================================

/** The components of type `typeId`, sorted by path. */
export function nodesOfType(graph: Graph, typeId: string): string[] {
  const out: string[] = [];
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.type === typeId) out.push(nodePath);
  }
  return out.sort();
}

/**
 * Every file type `typeId` covers — its components' mapped files and the files
 * enforced by the type alone (no owning component) — sorted by path, with the
 * type-level classification it was read from.
 *
 * Files enforced by this type ALONE count toward the covered files too:
 * omitting them undercounts a type that carries no node at all to zero even
 * when yg check reports live, enforced files, and undercounts a type with both
 * a node AND type-covered files.
 */
export async function typeCoveredFilesOf(
  graph: Graph,
  typeId: string,
  typeNodes: string[],
): Promise<{ files: TypeCoveredFileRow[]; typeCoveredPaths: string[]; typeCoverage: TypeCoverageInput | undefined }> {
  const projectRoot = join(graph.rootPath, '..');
  const sourceFiles: Array<{ path: string; node: string }> = [];
  for (const nodePath of typeNodes) {
    for (const p of graph.nodes.get(nodePath)?.meta.mapping ?? []) {
      sourceFiles.push({ path: p, node: nodePath });
    }
  }
  const typeCoverage = await computeTypeCoverageForImpact(graph, projectRoot);
  const typeCoveredPaths = typeCoverage
    ? [...typeCoverage.covered.entries()].filter(([, t]) => t === typeId).map(([f]) => f).sort()
    : [];
  const files: TypeCoveredFileRow[] = [
    ...sourceFiles.map((f) => ({ path: f.path, label: `in ${f.node}` })),
    ...typeCoveredPaths.map((p) => ({ path: p, label: 'type-covered, no component' })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, typeCoveredPaths, typeCoverage };
}

/**
 * Cost of changing a type's defaults or when: predicate: how many files are
 * enforced by this type alone (no owning component), and the det/LLM pair
 * split + reviewer-call cost of re-verifying every one of them. Mirrors
 * computeAspectFillCost/computeNodeFillCost's own shape for the type-level
 * case. Reuses the ONE computeExpectedPairs enumeration this function itself
 * performs.
 */
export async function computeTypeVerdictImpact(
  graph: Graph,
  typeId: string,
  tc: TypeCoverageInput,
  lock: LockFile,
): Promise<TypeVerdictImpact> {
  const { pairs } = await computeExpectedPairs(graph, { typeCoverage: tc });
  const typeFiles = new Set<string>();
  for (const [file, t] of tc.covered) if (t === typeId) typeFiles.add(file);

  let detPairs = 0, llmPairs = 0, reviewerCalls = 0, greensAtStake = 0;
  for (const p of pairs) {
    // Only nodeless pairs belong to a type's OWN "at stake" count — a
    // component's pairs are already covered by yg impact --node.
    if (p.nodePath !== undefined) continue;
    if (!p.subjectFiles.some((f) => typeFiles.has(f))) continue;
    if (p.kind === 'llm') {
      llmPairs += 1;
      reviewerCalls += callsPerPair(graph, p.aspectId);
    } else {
      detPairs += 1;
    }
    if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greensAtStake += 1;
  }

  return { typeCoveredFiles: typeFiles.size, detPairs, llmPairs, reviewerCalls, greensAtStake };
}

/**
 * The files `typeId`'s `when` matches that are not in a node of that type —
 * orphans (in no mapping at all) and misplaced ones (in another type's node) —
 * and the files it would share with a type already `enforce: strict`. Asked of
 * the scan `yg check` runs (core/checks/mapping.ts), with `typeId` treated as
 * strict whether or not it is yet: before the flag is set this is the preview
 * of what setting it would report, and after, it is what `yg check` reports.
 */
export async function strictCoverageGapOf(graph: Graph, typeId: string): Promise<StrictCoverageGap> {
  const strictTypeIds = Object.entries(graph.architecture.node_types)
    .filter(([id, def]) => id !== typeId && def.enforce === 'strict' && def.when !== undefined)
    .map(([id]) => id);
  const findings = await scanStrictBackward(graph, new FileContentCache(), [...strictTypeIds, typeId]);
  const gap: StrictCoverageGap = {
    preview: graph.architecture.node_types[typeId]?.enforce !== 'strict',
    orphans: [],
    misplaced: [],
    conflicts: [],
    unreadable: [],
  };
  for (const f of findings) {
    if (f.kind === 'orphan' && f.typeId === typeId) gap.orphans.push(f.file);
    else if (f.kind === 'misplaced' && f.typeId === typeId) gap.misplaced.push({ file: f.file, owner: f.owner, ownerType: f.ownerType });
    else if (f.kind === 'overlap' && f.typeIds.includes(typeId)) gap.conflicts.push({ file: f.file, types: f.typeIds.filter((t) => t !== typeId) });
    else if (f.kind === 'unreadable' && f.typeId === typeId) gap.unreadable.push({ file: f.file, reason: f.reason });
  }
  return gap;
}
