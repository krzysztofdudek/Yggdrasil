/**
 * The words of `yg impact`: the blast radius of a change to a rule, a flow or a
 * type, what an edit to a file or a component costs to re-verify, and the
 * recording run that re-verifies it, named and priced the way `yg check` names
 * it — the price stated, never asked about. Text only; every fact arrives as
 * data (model/impact.ts) from the engine that computed it.
 */
import { stringify } from 'yaml';
import type { AspectFillCost, AspectImpact, FlowImpact, GraduationPreview, ImpactReason, ImpactSummary, NodeFillCost, StrictCoverageGap, TypeCoveredFileRow, TypeVerdictImpact } from '../model/impact.js';
import type { ArchitectureNodeType } from '../model/graph.js';
import { count, plural } from '../utils/count.js';
import { toPosixPath } from '../utils/posix.js';
import { fillStepFor, fillStepText } from './output-grammar.js';

/**
 * The recording run that re-verifies an aspect's pairs after a change, named
 * and priced the way `yg check` names it — the price stated, never asked about.
 */
function refillStep(cost: AspectFillCost): string {
  if (cost.units === 0) return 'yg check --approve';
  return fillStepText(fillStepFor(cost.kind === 'llm'
    ? { free: 0, reviewerPairs: cost.units, reviewerCalls: cost.reviewerCalls }
    : { free: cost.units, reviewerPairs: 0, reviewerCalls: 0 }));
}

/**
 * The price of the recording run after a change whose pairs this command does
 * not enumerate (a flow's, a type's): paid where it re-opens reviewer pairs,
 * and previewed for free before it runs.
 */
const UNPRICED_FILL = 'yg check --approve  (paid for the reviewer pairs it re-opens — yg check --approve --dry-run prices it)';

/** Render the cost lines for an aspect change in lock vocabulary (no drift words). */
function renderFillCost(cost: AspectFillCost, affectedNodes: number): string {
  if (cost.units === 0) {
    return `  No verified pairs of this aspect exist yet — a change re-verifies them on the next yg check --approve.\n`;
  }
  // Files enforced by the aspect's architecture type alone (no owning node)
  // are counted in `cost.units` but never in `affectedNodes` — named here so
  // "N affected node(s)" can never read as the whole cost when it is not.
  const fileNote = cost.fileUnits > 0
    ? cost.fileUnits === 1
      ? ` (1 of them from a type-covered file, no owning component)`
      : ` (${cost.fileUnits} of them from type-covered files, no owning component)`
    : '';
  if (cost.kind === 'deterministic') {
    return (
      `  All ${affectedNodes} affected ${plural(affectedNodes, 'node')} (${cost.units} ${plural(cost.units, 'pair')}${fileNote}) would become unverified if this aspect changes — ` +
      `re-verified for free by yg check --approve (script rule, no reviewer calls).\n`
    );
  }
  return (
    `  All ${affectedNodes} affected ${plural(affectedNodes, 'node')} (${cost.units} ${plural(cost.units, 'pair')}${fileNote}) would become unverified if this aspect changes — ` +
    `re-verified by yg check --approve at ${cost.reviewerCalls} reviewer ${plural(cost.reviewerCalls, 'call')} (consensus included).\n`
  );
}

/** The whole answer to `yg impact --aspect`. */
export function renderAspectImpact(impact: AspectImpact): string {
  const { aspectId, affected, chains, propagatingFlows, impliedBy, implies, cost } = impact;
  let out = '';
  out += `Impact of changes in aspect ${aspectId}:\n\n`;
  out += `Directly affected (${affected.length}):\n`;
  if (affected.length === 0) {
    // "(none)" alone would claim literally nothing is affected — false when
    // this list's own walk over the components misses a file this aspect's
    // architecture type enforces with no owning component (cost.fileUnits,
    // named honestly below in the cost line too).
    out += cost.fileUnits > 0
      ? `  (none among components — ${count(cost.fileUnits, 'type-covered file')} would still be affected; see the cost below)\n`
      : '  (none)\n';
  } else {
    for (const { path: p, source, status, refused } of affected) {
      const refusedTag = refused ? ' [refused]' : '';
      out += `  ${toPosixPath(p)} (${source}) [${status}]${refusedTag}\n`;
    }
  }
  if (chains.length > 0) {
    out += `\nIndirectly affected (structural dependents):\n`;
    for (const chain of chains) out += `  ${chain}\n`;
  }
  out += `\nFlows propagating this aspect: ${propagatingFlows.length > 0 ? propagatingFlows.join(', ') : '(none)'}\n`;
  out += `Implied by: ${impliedBy.length > 0 ? impliedBy.join(', ') : '(none)'}\n`;
  out += `Implies: ${implies.length > 0 ? implies.join(', ') : '(none)'}\n`;
  const totalAffected = affected.length + impact.indirectPaths.length;
  out += `\nBlast radius: ${totalAffected} ${plural(totalAffected, 'node')}, ${propagatingFlows.length} ${plural(propagatingFlows.length, 'flow')}\n`;
  out += renderFillCost(cost, affected.length);
  if (totalAffected >= 10) {
    out += `  High blast radius — review aspect requirements in affected nodes before modifying this aspect.\n`;
  }
  out += `\nnext: weigh the cost above before editing the aspect, then run ${refillStep(cost)} to re-verify the affected pairs.\n`;
  return out;
}

/** The whole answer to `yg impact --flow`. */
export function renderFlowImpact(impact: FlowImpact): string {
  const { flowName, participants, chains, flowAspects } = impact;
  let out = '';
  out += `Impact of changes in flow ${flowName}:\n\n`;
  out += 'Participants:\n';
  if (participants.length === 0) {
    out += '  (none)\n';
  } else {
    for (const p of participants) out += `  ${toPosixPath(p.path)}${p.declared ? '' : ' (descendant)'}\n`;
  }
  if (chains.length > 0) {
    out += `\nIndirectly affected (structural dependents):\n`;
    for (const chain of chains) out += `  ${chain}\n`;
  }
  out += `\nFlow aspects: ${flowAspects.length > 0 ? flowAspects.join(', ') : '(none)'}\n`;
  const total = participants.length + impact.indirectPaths.length;
  out += `\nBlast radius: ${count(total, 'node')}\n`;
  out += `  All ${participants.length} ${plural(participants.length, 'participant')} would become unverified if this flow's aspect or participant set changes — re-verified by yg check --approve.\n`;
  if (total >= 10) {
    out += `  High blast radius — review flow compliance in participants before modifying.\n`;
  }
  out += `\nnext: review the participants above before editing the flow, then run ${UNPRICED_FILL} to re-verify them.\n`;
  return out;
}

/** `yg impact --type`'s opening: the type as declared, then its components. */
export function renderTypeHeader(typeId: string, def: ArchitectureNodeType, typeNodes: string[]): string {
  let out = '';
  out += `\nType: ${typeId}\n`;
  out += `Description: ${def.description}\n`;
  if (def.enforce === 'strict') out += `enforce: strict\n`;
  if (def.when) {
    const rendered = stringify(def.when, { lineWidth: 0 }).trimEnd();
    out += `when:\n`;
    for (const line of rendered.split('\n')) out += `  ${line}\n`;
  }
  if (def.aspects && def.aspects.length > 0) {
    out += `aspects: [${def.aspects.join(', ')}]\n`;
  }
  out += `\nNodes of this type (${typeNodes.length}):\n`;
  for (const p of typeNodes) out += `  ${toPosixPath(p)}\n`;
  return out;
}

/** The files a type covers, the first twenty listed and the rest counted. */
export function renderTypeCoveredFiles(files: TypeCoveredFileRow[]): string {
  let out = `\nSource files covered (${files.length}):\n`;
  for (const f of files.slice(0, 20)) out += `  ${toPosixPath(f.path)} (${f.label})\n`;
  if (files.length > 20) out += `  ... (${files.length - 20} more)\n`;
  return out;
}

/** What is at stake in the files a type enforces on its own. */
export function renderTypeVerdictImpact(impact: TypeVerdictImpact): string {
  let out = `\nFiles enforced by this type: ${impact.typeCoveredFiles}\n`;
  out += `At stake: ${impact.detPairs} free ${plural(impact.detPairs, 'check')}, ${impact.llmPairs} ${plural(impact.llmPairs, 'review')} = ${impact.reviewerCalls} reviewer ${plural(impact.reviewerCalls, 'call')}\n`;
  if (impact.greensAtStake > 0) {
    out += `  ${impact.greensAtStake} currently-green ${plural(impact.greensAtStake, 'verdict')} at stake.\n`;
  }
  return out;
}

/** The files a type's `when` matches outside a node of that type, as `enforce: strict` sees them. */
export function renderStrictCoverageGap(typeId: string, gap: StrictCoverageGap): string {
  const { orphans, misplaced, conflicts, unreadable } = gap;
  const heading = gap.preview ? 'Strict coverage gap — preview, if enforce: strict were set' : 'Strict coverage gap';
  if (orphans.length === 0 && misplaced.length === 0 && conflicts.length === 0 && unreadable.length === 0) {
    return `\n${heading} (0 files): None — all files satisfying when are in ${typeId}-type nodes.\n`;
  }
  let out = `\n${heading}:\n`;
  out += `  Orphans (matching files not in any mapping): ${orphans.length}\n`;
  for (const p of orphans.slice(0, 10)) out += `    ${toPosixPath(p)}\n`;
  if (orphans.length > 10) out += `    ... (${orphans.length - 10} more)\n`;
  out += `  Misplaced (in wrong-type node mapping): ${misplaced.length}\n`;
  for (const m of misplaced.slice(0, 10)) out += `    ${toPosixPath(m.file)} → ${toPosixPath(m.owner)} (type: ${m.ownerType})\n`;
  if (misplaced.length > 10) out += `    ... (${misplaced.length - 10} more)\n`;
  if (conflicts.length > 0) {
    out += `  Conflicting (also matched by another strict type): ${conflicts.length}\n`;
    for (const c of conflicts.slice(0, 10)) out += `    ${toPosixPath(c.file)} (also: ${c.types.join(', ')})\n`;
    if (conflicts.length > 10) out += `    ... (${conflicts.length - 10} more)\n`;
  }
  if (unreadable.length > 0) {
    out += `  Unreadable (when could not be evaluated, so belonging is unknown): ${unreadable.length}\n`;
    for (const u of unreadable.slice(0, 10)) out += `    ${toPosixPath(u.file)} (${u.reason})\n`;
    if (unreadable.length > 10) out += `    ... (${unreadable.length - 10} more)\n`;
  }
  return out;
}

/** `yg impact --type`'s last line. */
export function renderTypeNext(hasTypeCoveredFiles: boolean): string {
  return hasTypeCoveredFiles
    ? `\nnext: review the nodes and covered files of this type above before editing the type's defaults or when predicate, then run ${UNPRICED_FILL}.\n`
    : `\nnext: review the nodes of this type above before editing the type's defaults or when predicate, then run ${UNPRICED_FILL}.\n`;
}

const REASON_GLOSS: Record<ImpactReason, string> = {
  own: 'own pairs',
  reference: 'references this file',
  'observe-companion': 'companion observes this file',
  'observe-deterministic': 'script rule observes this file',
  'cold-potential-deterministic': 'may observe this file (cold-start)',
  'cold-potential-companion': 'companion may observe this file (cold-start; companion not run)',
};

/**
 * What editing one file costs to re-verify: every component it invalidates,
 * then the totals. Every row is listed, whatever the output is connected to:
 * the rows exist nowhere else (the impact document carries no cost rows), so
 * a list cut short had nothing to point the reader at, and a cut that happened
 * only on a terminal made the same command say different things to a person
 * and to a pipe.
 */
export function renderImpactTotal(summary: ImpactSummary, editedFile: string): string {
  const lines: string[] = [];
  lines.push(`\nEditing ${toPosixPath(editedFile)} invalidates:`);
  for (const n of summary.byNode) {
    const parts: string[] = [];
    if (n.llmPairs > 0) parts.push(`${n.llmPairs} reviewer = ${n.reviewerCalls} reviewer ${plural(n.reviewerCalls, 'call')}`);
    if (n.detPairs > 0) parts.push(`${n.detPairs} script`);
    const why = n.reasons.map((r) => REASON_GLOSS[r]).join(', ');
    lines.push(`  ${toPosixPath(n.nodePath)}  ${parts.join(', ')}  (${why})`);
  }
  lines.push(`\nTotal to re-verify: ${summary.billedReviewerCalls} reviewer ${plural(summary.billedReviewerCalls, 'call')} — billed by yg check --approve.`);
  lines.push(`                    ${summary.freeDeterministic} script ${plural(summary.freeDeterministic, 'pair')} — free.`);
  lines.push(`                    ${summary.greensReRolled} currently-green ${plural(summary.greensReRolled, 'verdict')} re-rolled.`);
  if (summary.fileLevelPairs > 0) {
    // Named explicitly: these pairs have no owning component, so no row above
    // lists them — without this line the totals would look larger than the
    // sum of the rows shown, with no explanation why.
    lines.push(
      `                    (${summary.fileLevelPairs} of these ${plural(summary.fileLevelPairs, 'pair')} belong to a type-covered file — no component row lists them above)`,
    );
  }
  if (summary.unresolved.length > 0) {
    lines.push(`\nUnresolved (companion failed — will infra-fail at fill; cost unknown):`);
    for (const u of summary.unresolved) lines.push(`  ${u.nodePath === undefined ? u.nodePath : toPosixPath(u.nodePath)}  aspect '${u.aspectId}'  ${u.why}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the reviewer-call cost for editing a node (or a single file under it),
 * in lock vocabulary (no "drift" words). One line, information-preserving.
 */
export function renderNodeFillCost(cost: NodeFillCost, subject: 'node' | 'file'): string {
  return (
    `  Editing this ${subject} re-verifies: ${cost.llmPairs} reviewer ${plural(cost.llmPairs, 'pair')} = ` +
    `${cost.reviewerCalls} reviewer ${plural(cost.reviewerCalls, 'call')} (consensus included); ` +
    `${cost.detPairs} script = free; ` +
    `${cost.greensReRolled} currently-green ${plural(cost.greensReRolled, 'verdict')} re-rolled.\n`
  );
}

/** Render the graduation-preview cost, in the same lock vocabulary as renderNodeFillCost. */
export function renderGraduationPreview(preview: GraduationPreview): string {
  if (preview.llmPairsReVerified === 0 && preview.detPairsReVerified === 0) {
    return `\nGiving this file a component of its own re-checks nothing — it currently has no aspect pairs of its own.\n`;
  }
  const parts: string[] = [];
  if (preview.detPairsReVerified > 0) parts.push(`${preview.detPairsReVerified} ${plural(preview.detPairsReVerified, 'check')}`);
  if (preview.llmPairsReVerified > 0) parts.push(`${preview.llmPairsReVerified} ${plural(preview.llmPairsReVerified, 'review')} ≈ ${preview.reviewerCalls} reviewer ${plural(preview.reviewerCalls, 'call')}`);
  return `\nGiving this file a component of its own re-checks ${parts.join(', ')} — the pair hash folds nodePath, so every pair on this file re-verifies once it gains one, whether or not the rule itself changed.\n`;
}
