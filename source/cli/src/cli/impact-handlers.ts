import chalk from 'chalk';
import { join } from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { collectAncestors } from '../core/context-builder.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../core/graph/aspects.js';
import {
  classifyInvalidations,
  collectIndirectDependents,
  nodesWithRefusedVerdict,
  touchedReferencesFile,
} from '../core/graph/impact-graph.js';
import type { ImpactSet, ImpactReason, UnresolvedUnit } from '../core/graph/impact-graph.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { evaluateFileWhen } from '../core/file-when-evaluator.js';
import { computeExpectedPairs } from '../core/pairs.js';
import type { ExpectedPair, TypeCoverageInput } from '../core/pairs.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverage } from '../core/type-coverage.js';
import { resolveCompanionsForPair } from '../core/companion-resolve.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';

/**
 * The type-level classification lattice (coverage.type_level), classified for
 * this one command invocation — mirrors runCheck's own hoist (core/check.ts),
 * but at the scale of a single `yg impact` call rather than a whole check run.
 * Undefined when the flag is off, so computeExpectedPairs enumerates exactly
 * the component-only universe it always has.
 */
async function computeTypeCoverageForImpact(graph: Graph, projectRoot: string): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const gitFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  const result = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

// ============================================================
// collectInvalidatedPairs — async, runs cold companion resolver
// ============================================================

const COMPANION_RESOLVE_TIMEOUT_MS = 5000;
const TIMEOUT = Symbol('companion-resolve-timeout');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    (timer as { unref?: () => void }).unref?.(); // do not keep the process alive
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

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
  const unresolved: UnresolvedUnit[] = [];
  // Shared across every cold-companion resolution below (mirrors fill.ts's own
  // per-run cache) — a nodeless candidate's architecture reach is computed
  // once per matched type, not once per candidate.
  const reachCache = new Map<string, Set<string>>();

  for (const p of coldCompanionCandidates) {
    const aspect = graph.aspects.find((a) => a.id === p.aspectId)!;
    let result: Awaited<ReturnType<typeof resolveCompanionsForPair>> | typeof TIMEOUT;
    try {
      result = await withTimeout(resolveCompanionsForPair(graph, projectRoot, p, aspect, typeCoverage, reachCache), COMPANION_RESOLVE_TIMEOUT_MS);
    } catch (err) {
      unresolved.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, why: (err as Error).message });
      continue;
    }
    if (result === TIMEOUT) {
      unresolved.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, why: 'companion resolution timed out' });
      continue;
    }
    if (result.kind === 'infra') {
      unresolved.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, why: result.why });
      continue;
    }
    if (touchedReferencesFile(result.companions.observations, repoRelative)) {
      admitted.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, kind: p.kind, reasons: ['observe-companion'], mode: 'precise' });
    }
  }
  return { pairs: admitted, unresolved, allPairs: pairs, typeCoverage };
}

export function collectDescendants(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const result: string[] = [];
  const stack = [...node.children];
  while (stack.length > 0) {
    const child = stack.pop()!;
    result.push(child.path);
    stack.push(...child.children);
  }
  return result.sort();
}

export async function handleAspectImpact(
  graph: Graph,
  aspectId: string,
  lock: LockFile,
  projectRoot: string,
): Promise<void> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Aspect not found: ${aspectId}`,
      why: 'The aspect id must match a directory name under .yggdrasil/aspects/.',
      next: 'Run: yg aspects — to list all defined aspects.',
    })}\n`));
    process.exit(1);
  }

  // Nodes currently holding a refused verdict for this aspect (lock scan, no IO).
  const refusedNodes = nodesWithRefusedVerdict(graph, lock, aspectId);

  const affected: Array<{ path: string; source: string; status: string; refused: boolean }> = [];
  for (const [nodePath, node] of graph.nodes) {
    const effective = computeEffectiveAspects(node, graph);
    if (effective.has(aspectId)) {
      const statuses = computeEffectiveAspectStatuses(node, graph);
      const status = statuses.get(aspectId) ?? aspect.status ?? 'enforced';
      const refused = refusedNodes.has(nodePath);
      const ownAspectIds = new Set(node.meta.aspects ?? []);
      if (ownAspectIds.has(aspectId)) {
        affected.push({ path: nodePath, source: 'own', status, refused });
      } else {
        let fromHierarchy = false;
        let anc = node.parent;
        while (anc) {
          if ((anc.meta.aspects ?? []).includes(aspectId)) {
            fromHierarchy = true;
            break;
          }
          anc = anc.parent;
        }
        if (fromHierarchy) {
          affected.push({ path: nodePath, source: `hierarchy from ${anc!.path}`, status, refused });
        } else {
          const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
          const flow = graph.flows.find(
            (f) =>
              (f.aspects ?? []).includes(aspectId) &&
              f.nodes.some((n) => ancestorPaths.has(n)),
          );
          affected.push({ path: nodePath, source: flow ? `flow: ${flow.name}` : 'implied', status, refused });
        }
      }
    }
  }

  affected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { indirectPaths, chains } = collectIndirectDependents(
    graph,
    affected.map((a) => a.path),
  );

  const propagatingFlows = graph.flows
    .filter((f) => (f.aspects ?? []).includes(aspectId))
    .map((f) => f.name);

  const impliedBy = graph.aspects
    .filter((a) => (a.implies ?? []).includes(aspectId))
    .map((a) => a.id);
  const implies = aspect.implies ?? [];

  // Cost: how many pairs of THIS aspect would become unverified, and (for an LLM
  // aspect) the reviewer calls a re-fill would cost. per: file scope produces one
  // unit per subject file, so count from the expected-pair set, not node count.
  const cost = await computeAspectFillCost(graph, aspectId, projectRoot);

  process.stdout.write(`Impact of changes in aspect ${aspectId}:\n\n`);
  process.stdout.write(`Directly affected (${affected.length}):\n`);
  if (affected.length === 0) {
    // "(none)" alone would claim literally nothing is affected — false when
    // this list's own graph.nodes walk misses a file this aspect's
    // architecture type enforces with no owning component (cost.fileUnits,
    // named honestly below in the cost line too).
    process.stdout.write(
      cost.fileUnits > 0
        ? `  (none among components — ${cost.fileUnits} file${cost.fileUnits === 1 ? '' : 's'} enforced by its architecture type alone would still be affected; see the cost below)\n`
        : '  (none)\n',
    );
  } else {
    for (const { path: p, source, status, refused } of affected) {
      const refusedTag = refused ? ' [refused]' : '';
      process.stdout.write(`  ${p} (${source}) [${status}]${refusedTag}\n`);
    }
  }
  if (chains.length > 0) {
    process.stdout.write(`\nIndirectly affected (structural dependents):\n`);
    for (const chain of chains) {
      process.stdout.write(`  ${chain}\n`);
    }
  }
  process.stdout.write(
    `\nFlows propagating this aspect: ${propagatingFlows.length > 0 ? propagatingFlows.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(`Implied by: ${impliedBy.length > 0 ? impliedBy.join(', ') : '(none)'}\n`);
  process.stdout.write(`Implies: ${implies.length > 0 ? implies.join(', ') : '(none)'}\n`);
  process.stdout.write(`\nBlast radius: ${affected.length + indirectPaths.length} nodes, ${propagatingFlows.length} flows\n`);
  process.stdout.write(renderFillCost(cost, affected.length));
  const totalAffected = affected.length + indirectPaths.length;
  if (totalAffected >= 10) {
    process.stdout.write(`  High blast radius — review aspect requirements in affected nodes before modifying this aspect.\n`);
  }
  process.stdout.write(
    `\nNext: weigh the cost above before editing the aspect, then run yg check --approve to re-verify the affected pairs.\n`,
  );
}

interface FillCost {
  kind: 'llm' | 'deterministic' | 'unknown';
  units: number;        // expected pairs of the aspect (per: file → one per file)
  reviewerCalls: number; // units × resolved consensus (0 for deterministic)
  /**
   * Of `units`, how many belong to a file enforced by its architecture type
   * alone (no owning node) — never counted in the "Directly affected" list or
   * `affectedNodes` above it, since that list only ever walks graph.nodes. A
   * change that touches ONLY such files must never be reported as costing
   * nothing just because no component appears in that list.
   */
  fileUnits: number;
}

/**
 * Cost of re-filling every pair of `aspectId` after a change to it: the unit
 * count (one per expected pair) and, for an LLM aspect, the reviewer calls a
 * re-fill would dispatch (units × the resolved tier consensus). Deterministic
 * aspects are free (0 reviewer calls).
 */
async function computeAspectFillCost(graph: Graph, aspectId: string, projectRoot: string): Promise<FillCost> {
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

/** Render the cost lines for an aspect change in lock vocabulary (no drift words). */
function renderFillCost(cost: FillCost, affectedNodes: number): string {
  if (cost.units === 0) {
    return `  No verified pairs of this aspect exist yet — a change re-verifies them on the next yg check --approve.\n`;
  }
  // Files enforced by the aspect's architecture type alone (no owning node)
  // are counted in `cost.units` but never in `affectedNodes` — named here so
  // "N affected node(s)" can never read as the whole cost when it is not.
  const fileNote = cost.fileUnits > 0
    ? cost.fileUnits === 1
      ? ` (1 of them from a file enforced by this aspect's architecture type alone, no owning component)`
      : ` (${cost.fileUnits} of them from files enforced by this aspect's architecture type alone, no owning component)`
    : '';
  if (cost.kind === 'deterministic') {
    return (
      `  All ${affectedNodes} affected node(s) (${cost.units} pair(s)${fileNote}) would become unverified if this aspect changes — ` +
      `re-verified for free by yg check --approve (deterministic, no reviewer calls).\n`
    );
  }
  return (
    `  All ${affectedNodes} affected node(s) (${cost.units} pair(s)${fileNote}) would become unverified if this aspect changes — ` +
    `re-verified by yg check --approve at ${cost.reviewerCalls} reviewer call(s) (consensus included).\n`
  );
}

export interface ImpactNodeRow {
  nodePath: string;
  llmPairs: number;
  reviewerCalls: number;
  detPairs: number;
  reasons: ImpactReason[];
}

export interface ImpactSummary {
  billedReviewerCalls: number;
  freeDeterministic: number;
  greensReRolled: number;
  byNode: ImpactNodeRow[];
  unresolved: UnresolvedUnit[];
  /**
   * Of the totals above, how many pairs belong to a file enforced by its
   * architecture type alone (no owning component) — folded into
   * billedReviewerCalls/freeDeterministic/greensReRolled but NEVER into any
   * `byNode` row, since there is no component to join. Named here so the
   * per-node rows can never be mistaken for the whole cost when they are not.
   */
  fileLevelPairs: number;
}

export function summarizeImpact(set: ImpactSet, graph: Graph, lock: LockFile): ImpactSummary {
  const reviewer = graph.config.reviewer;
  const rows = new Map<string, ImpactNodeRow>();
  let billed = 0, free = 0, greens = 0, fileLevelPairs = 0;
  for (const p of set.pairs) {
    // A nodeless (type-covered-file) pair has no component row to join — it
    // is still counted in the run TOTALS below (a wrong total may not ship:
    // this file's own pairs are real cost, whether or not any component row
    // exists to display them against).
    if (p.nodePath === undefined) {
      fileLevelPairs += 1;
      if (p.kind === 'llm') {
        const aspect = graph.aspects.find((a) => a.id === p.aspectId);
        const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
        billed += tier?.ok ? tier.tier.consensus : 1;
      } else {
        free += 1;
      }
      if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greens += 1;
      continue;
    }
    const nodePath = p.nodePath;
    const row = rows.get(nodePath) ?? { nodePath, llmPairs: 0, reviewerCalls: 0, detPairs: 0, reasons: [] };
    for (const r of p.reasons) if (!row.reasons.includes(r)) row.reasons.push(r);
    if (p.kind === 'llm') {
      const aspect = graph.aspects.find((a) => a.id === p.aspectId);
      const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
      const calls = tier?.ok ? tier.tier.consensus : 1;
      row.llmPairs += 1; row.reviewerCalls += calls; billed += calls;
    } else { row.detPairs += 1; free += 1; }
    if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greens += 1;
    rows.set(nodePath, row);
  }
  const byNode = [...rows.values()].sort((a, b) => (a.nodePath < b.nodePath ? -1 : a.nodePath > b.nodePath ? 1 : 0));
  return { billedReviewerCalls: billed, freeDeterministic: free, greensReRolled: greens, byNode, unresolved: set.unresolved, fileLevelPairs };
}

const REASON_GLOSS: Record<ImpactReason, string> = {
  own: 'own pairs',
  reference: 'references this file',
  'observe-companion': 'companion observes this file',
  'observe-deterministic': 'deterministic check observes this file',
  'cold-potential-deterministic': 'may observe this file (cold-start)',
};

const CAP_NODES = 12;

export function renderImpactTotal(summary: ImpactSummary, editedFile: string, opts: { isTTY: boolean }): string {
  const lines: string[] = [];
  lines.push(`\nEditing ${editedFile} invalidates:`);
  const shown = opts.isTTY && summary.byNode.length > CAP_NODES ? summary.byNode.slice(0, CAP_NODES) : summary.byNode;
  for (const n of shown) {
    const parts: string[] = [];
    if (n.llmPairs > 0) parts.push(`${n.llmPairs} LLM = ${n.reviewerCalls} reviewer call(s)`);
    if (n.detPairs > 0) parts.push(`${n.detPairs} deterministic`);
    const why = n.reasons.map((r) => REASON_GLOSS[r]).join(', ');
    lines.push(`  ${n.nodePath}  ${parts.join(', ')}  (${why})`);
  }
  if (opts.isTTY && summary.byNode.length > CAP_NODES) {
    lines.push(`  ... and ${summary.byNode.length - CAP_NODES} more (yg impact --file ${editedFile} | less)`);
  }
  lines.push(`\nTotal to re-verify: ${summary.billedReviewerCalls} reviewer call(s) — billed by yg check --approve.`);
  lines.push(`                    ${summary.freeDeterministic} deterministic pair(s) — free.`);
  lines.push(`                    ${summary.greensReRolled} currently-green verdict(s) re-rolled.`);
  if (summary.fileLevelPairs > 0) {
    // Named explicitly: these pairs have no owning component, so no row above
    // lists them — without this line the totals would look larger than the
    // sum of the rows shown, with no explanation why.
    lines.push(
      `                    (${summary.fileLevelPairs} of these pair(s) belong to a file enforced by its architecture type alone — no component row lists them above)`,
    );
  }
  if (summary.unresolved.length > 0) {
    lines.push(`\nUnresolved (companion failed — will infra-fail at fill; cost unknown):`);
    for (const u of summary.unresolved) lines.push(`  ${u.nodePath}  aspect '${u.aspectId}'  ${u.why}`);
  }
  return lines.join('\n') + '\n';
}

export interface NodeFillCost {
  llmPairs: number;       // expected LLM pairs in scope (one per unit)
  detPairs: number;       // expected deterministic pairs in scope (free)
  reviewerCalls: number;  // Σ over LLM pairs of the pair aspect's resolved consensus
  greensReRolled: number; // currently-green (approved) pairs in scope a re-fill re-rolls
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

  const reviewer = graph.config.reviewer;
  let llmPairs = 0;
  let detPairs = 0;
  let reviewerCalls = 0;
  let greensReRolled = 0;
  for (const p of scoped) {
    if (p.kind === 'llm') {
      llmPairs += 1;
      const aspect = graph.aspects.find((a) => a.id === p.aspectId);
      const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
      reviewerCalls += tier?.ok ? tier.tier.consensus : 1;
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
 * Render the reviewer-call cost for editing a node (or a single file under it),
 * in lock vocabulary (no "drift" words). One line, information-preserving.
 */
export function renderNodeFillCost(cost: NodeFillCost, subject: 'node' | 'file'): string {
  return (
    `  Editing this ${subject} re-verifies: ${cost.llmPairs} LLM pair(s) = ` +
    `${cost.reviewerCalls} reviewer call(s) (consensus included); ` +
    `${cost.detPairs} deterministic = free; ` +
    `${cost.greensReRolled} currently-green verdict(s) re-rolled.\n`
  );
}

export interface GraduationPreview {
  file: string;
  currentType: string;
  llmPairsReVerified: number;
  reviewerCalls: number;
  detPairsReVerified: number;
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
  const reviewer = graph.config.reviewer;
  const currentType = tc.covered.get(file) ?? '';

  let llmPairsReVerified = 0;
  let detPairsReVerified = 0;
  let reviewerCalls = 0;
  for (const p of pairs) {
    if (p.nodePath !== undefined) continue;
    if (!p.subjectFiles.includes(file)) continue;
    if (p.kind === 'llm') {
      llmPairsReVerified += 1;
      const aspect = graph.aspects.find((a) => a.id === p.aspectId);
      const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
      reviewerCalls += tier?.ok ? tier.tier.consensus : 1;
    } else {
      detPairsReVerified += 1;
    }
  }

  return { file, currentType, llmPairsReVerified, reviewerCalls, detPairsReVerified };
}

/** Render the graduation-preview cost, in the same lock vocabulary as renderNodeFillCost. */
export function renderGraduationPreview(preview: GraduationPreview): string {
  if (preview.llmPairsReVerified === 0 && preview.detPairsReVerified === 0) {
    return `\nGiving this file a component of its own re-checks nothing — it currently has no aspect pairs of its own.\n`;
  }
  const parts: string[] = [];
  if (preview.detPairsReVerified > 0) parts.push(`${preview.detPairsReVerified} check(s)`);
  if (preview.llmPairsReVerified > 0) parts.push(`${preview.llmPairsReVerified} review(s) ≈ ${preview.reviewerCalls} reviewer call(s)`);
  return `\nGiving this file a component of its own re-checks ${parts.join(', ')} — the pair hash folds nodePath, so every pair on this file re-verifies once it gains one, whether or not the rule itself changed.\n`;
}

export async function handleFlowImpact(
  graph: Graph,
  flowName: string,
): Promise<void> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Flow not found: ${flowName}`,
      why: 'The flow name must match a directory name under .yggdrasil/flows/.',
      next: 'Run: yg flows — to list all defined flows.',
    })}\n`));
    process.exit(1);
  }

  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    if (graph.nodes.has(nodePath)) {
      participants.add(nodePath);
      for (const desc of collectDescendants(graph, nodePath)) {
        participants.add(desc);
      }
    }
  }

  const sorted = [...participants].sort();
  const flowAspects = flow.aspects ?? [];

  const { indirectPaths, chains } = collectIndirectDependents(graph, sorted);

  process.stdout.write(`Impact of changes in flow ${flow.name}:\n\n`);
  process.stdout.write('Participants:\n');
  if (sorted.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const p of sorted) {
      const isDeclared = flow.nodes.includes(p);
      const suffix = isDeclared ? '' : ' (descendant)';
      process.stdout.write(`  ${p}${suffix}\n`);
    }
  }
  if (chains.length > 0) {
    process.stdout.write(`\nIndirectly affected (structural dependents):\n`);
    for (const chain of chains) {
      process.stdout.write(`  ${chain}\n`);
    }
  }
  process.stdout.write(
    `\nFlow aspects: ${flowAspects.length > 0 ? flowAspects.join(', ') : '(none)'}\n`,
  );
  const declaredParticipants = flow.nodes.filter((n) => graph.nodes.has(n));
  process.stdout.write(`\nBlast radius: ${sorted.length + indirectPaths.length} nodes\n`);
  process.stdout.write(`  All ${declaredParticipants.length} participant(s) would become unverified if this flow's aspect or participant set changes — re-verified by yg check --approve.\n`);
  const totalFlowAffected = sorted.length + indirectPaths.length;
  if (totalFlowAffected >= 10) {
    process.stdout.write(`  High blast radius — review flow compliance in participants before modifying.\n`);
  }
  process.stdout.write(
    `\nNext: review the participants above before editing the flow, then run yg check --approve to re-verify them.\n`,
  );
}

export interface TypeVerdictImpact {
  typeCoveredFiles: number;
  detPairs: number;
  llmPairs: number;
  reviewerCalls: number;
  /**
   * Of detPairs+llmPairs, how many currently hold a stored 'approved'
   * verdict — the SAME "at stake" refinement computeNodeFillCost's own
   * greensReRolled field gives every other cost preview in this file.
   * `lock` is passed only for this; the four base counts are unconditional
   * (every expected pair, filled or not — matching computeNodeFillCost's/
   * computeAspectFillCost's own convention that "cost of re-verifying"
   * counts ALL pairs, not just already-verified ones).
   */
  greensAtStake: number;
}

/**
 * Cost of changing a type's defaults or when: predicate: how many files are
 * enforced by this type alone (no owning component), and the det/LLM pair
 * split + reviewer-call cost of re-verifying every one of them. Mirrors
 * computeAspectFillCost/computeNodeFillCost's own shape for the type-level
 * case. Reuses the ONE computeExpectedPairs enumeration this function itself
 * performs — handleTypeImpact calls no other pairs enumeration in the same
 * invocation.
 */
export async function computeTypeVerdictImpact(
  graph: Graph,
  typeId: string,
  tc: TypeCoverageInput,
  lock: LockFile,
): Promise<TypeVerdictImpact> {
  const reviewer = graph.config.reviewer;
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
      const aspect = graph.aspects.find((a) => a.id === p.aspectId);
      const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
      reviewerCalls += tier?.ok ? tier.tier.consensus : 1;
    } else {
      detPairs += 1;
    }
    if (lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved') greensAtStake += 1;
  }

  return { typeCoveredFiles: typeFiles.size, detPairs, llmPairs, reviewerCalls, greensAtStake };
}

export async function handleTypeImpact(graph: Graph, typeId: string, lock: LockFile): Promise<void> {
  // Own-key check before indexing: a raw bracket lookup would resolve inherited
  // Object.prototype members (constructor, toString, valueOf, hasOwnProperty),
  // fabricating a zero-impact report for a type that does not exist.
  if (!Object.keys(graph.architecture.node_types).includes(typeId)) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Type '${typeId}' not found in architecture.`,
      why: 'The type id must match a node_types key in .yggdrasil/yg-architecture.yaml.',
      next: 'Read .yggdrasil/yg-architecture.yaml to see defined types.',
    })}\n`));
    process.exit(1);
  }
  const def = graph.architecture.node_types[typeId];

  const projectRoot = join(graph.rootPath, '..');

  process.stdout.write(`\nType: ${typeId}\n`);
  process.stdout.write(`Description: ${def.description}\n`);
  if (def.enforce === 'strict') process.stdout.write(`enforce: strict\n`);
  if (def.when) {
    const { stringify } = await import('yaml');
    const rendered = stringify(def.when, { lineWidth: 0 }).trimEnd();
    process.stdout.write(`when:\n`);
    for (const line of rendered.split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
  }
  if (def.aspects && def.aspects.length > 0) {
    process.stdout.write(`aspects: [${def.aspects.join(', ')}]\n`);
  }

  const nodesOfType: string[] = [];
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.type === typeId) nodesOfType.push(nodePath);
  }
  nodesOfType.sort();

  process.stdout.write(`\nNodes of this type (${nodesOfType.length}):\n`);
  for (const p of nodesOfType) {
    process.stdout.write(`  ${p}\n`);
  }

  const sourceFiles: Array<{ path: string; node: string }> = [];
  for (const nodePath of nodesOfType) {
    for (const p of graph.nodes.get(nodePath)?.meta.mapping ?? []) {
      sourceFiles.push({ path: p, node: nodePath });
    }
  }

  // Files enforced by this type ALONE (no owning component) count toward
  // "Source files covered" too — omitting them undercounts a type that
  // carries no node at all to zero even when yg check reports live, enforced
  // files, and undercounts a type with both a node AND type-covered files
  // (this fixture's node-mapped count alone, silently short by however many
  // type-covered files the same type also matches).
  const typeCoverage = await computeTypeCoverageForImpact(graph, projectRoot);
  const typeCoveredPaths = typeCoverage
    ? [...typeCoverage.covered.entries()].filter(([, t]) => t === typeId).map(([f]) => f).sort()
    : [];

  const combinedFiles: Array<{ path: string; label: string }> = [
    ...sourceFiles.map((f) => ({ path: f.path, label: `in ${f.node}` })),
    ...typeCoveredPaths.map((p) => ({ path: p, label: 'type-covered, no component' })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  process.stdout.write(`\nSource files covered (${combinedFiles.length}):\n`);
  for (const f of combinedFiles.slice(0, 20)) {
    process.stdout.write(`  ${f.path} (${f.label})\n`);
  }
  if (combinedFiles.length > 20) {
    process.stdout.write(`  ... (${combinedFiles.length - 20} more)\n`);
  }

  if (typeCoveredPaths.length > 0) {
    const impact = await computeTypeVerdictImpact(graph, typeId, typeCoverage!, lock);
    process.stdout.write(`\nFiles enforced by this type: ${impact.typeCoveredFiles}\n`);
    process.stdout.write(
      `At stake: ${impact.detPairs} free check(s), ${impact.llmPairs} review(s) = ${impact.reviewerCalls} reviewer call(s)\n`,
    );
    if (impact.greensAtStake > 0) {
      process.stdout.write(`  ${impact.greensAtStake} currently-green verdict(s) at stake.\n`);
    }
  }

  if (def.enforce === 'strict' && def.when) {
    const cache = new FileContentCache();
    const repoFiles = await walkRepoFiles(projectRoot);
    const owners = new Map<string, string>();
    for (const [np, n] of graph.nodes) {
      for (const m of n.meta.mapping ?? []) owners.set(m, np);
    }
    const orphans: string[] = [];
    const misplaced: Array<{ file: string; owner: string; ownerType: string }> = [];
    for (const rel of repoFiles) {
      const abs = join(projectRoot, rel);
      const result = await evaluateFileWhen(def.when, {
        absPath: abs, repoRelPath: rel, projectRoot, cache,
      });
      if (!result.result) continue;
      const owner = owners.get(rel);
      if (owner === undefined) {
        orphans.push(rel);
      } else {
        const ownerType = graph.nodes.get(owner)?.meta.type ?? '?';
        if (ownerType !== typeId) misplaced.push({ file: rel, owner, ownerType });
      }
    }
    if (orphans.length === 0 && misplaced.length === 0) {
      process.stdout.write(
        `\nStrict coverage gap (0 files): None — all files satisfying when are in ${typeId}-type nodes.\n`,
      );
    } else {
      process.stdout.write(`\nStrict coverage gap:\n`);
      process.stdout.write(`  Orphans (matching files not in any mapping): ${orphans.length}\n`);
      for (const p of orphans.slice(0, 10)) process.stdout.write(`    ${p}\n`);
      if (orphans.length > 10) process.stdout.write(`    ... (${orphans.length - 10} more)\n`);
      process.stdout.write(`  Misplaced (in wrong-type node mapping): ${misplaced.length}\n`);
      for (const m of misplaced.slice(0, 10)) {
        process.stdout.write(`    ${m.file} → ${m.owner} (type: ${m.ownerType})\n`);
      }
      if (misplaced.length > 10) process.stdout.write(`    ... (${misplaced.length - 10} more)\n`);
    }
  }
  process.stdout.write(
    typeCoveredPaths.length > 0
      ? `\nNext: review the nodes and covered files of this type above before editing the type's defaults or when predicate, then run yg check --approve.\n`
      : `\nNext: review the nodes of this type above before editing the type's defaults or when predicate, then run yg check --approve.\n`,
  );
}
