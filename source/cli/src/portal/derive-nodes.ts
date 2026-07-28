import type { Graph, GraphNode } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectStatusSources,
  isAggregateAspect,
  selectTierForAspect,
  parseLog,
  type CheckResult,
  type CheckIssue,
  type LockVerification,
  type VerifiedPair,
  type PairState,
  type AspectStatus,
} from './engine-api.js';
import type {
  PortalNode,
  PortalPairState,
  PortalEffectiveAspect,
  PortalRelationOut,
  PortalRelationIn,
  PortalLogEntry,
  PortalSuppression,
} from './contract.js';
import {
  computeOwnState,
  computeRollup,
  collectNodeSuppressions,
  computeNotApplicable,
} from './derive-node-state.js';
import { worstPairState } from './derive-pair-state.js';

/**
 * derive-nodes — the per-node honest-state derivation.
 *
 * For each graph node it computes: `checked` (has at least one REAL verdict-bearing
 * pair — an effective row with a non-`n/a` pair state — never merely an effective
 * aspect that resolves to zero pairs), the effective-aspect rows (kind / tier / consensus / cost /
 * status / channel / origin + the pair state read off the VerifiedPair for that
 * aspect+unit), the node's own honest `state` (worst pair state, else `no-rule`
 * when unchecked, else `warning` when a node-scoped advisory issue applies),
 * the `rollupState` rolled bottom-up over descendants but KEPT SEPARATE from the
 * own state, both relation directions, the parsed log, and the node's suppressions.
 *
 * Pure orchestration over engine RESULTS — it iterates `verification.pairs`,
 * `check.issues`, `report` entries and the graph; it never re-hashes or
 * re-derives a verdict. Read-only: no lock write, no LLM call.
 */

/** A pre-built suppression inventory keyed for fast per-node filtering. */
export interface SuppressionsByFile {
  /** repo-rel POSIX file path → suppression entries detected in that file. */
  byFile: Map<string, PortalSuppression[]>;
}

/**
 * The single status-adjustment transform: map a raw verdict kind + the pair's EFFECTIVE
 * aspect status to the honest DISPLAY pair state, exactly as `yg check` renders it.
 *
 * A `refused` verdict on an ADVISORY aspect is non-blocking signal — it displays as `warning`,
 * NEVER as a blocking `refused` (that would contradict `yg check`, which renders advisory
 * refusals as warnings). A refused+ENFORCED pair stays `refused` (a real, blocking "no").
 * `verified` stays `verified`; every other kind (unverified and the two fail-closed gate
 * states prompt-too-large / companion-error) collapses to `unverified` — not green, not a
 * code "no". This is the ONE place the portal turns a raw verdict into a displayed pair state;
 * buildCounts, the per-node own-state, the effective-aspect rows, and the aspect tally all
 * read it, so no surface can paint an advisory refusal as a blocking refused.
 */
export function displayPairState(rawKind: PairState['kind'], status: AspectStatus): PortalPairState {
  if (rawKind === 'verified') return 'verified';
  if (rawKind === 'refused') return status === 'advisory' ? 'warning' : 'refused';
  // unverified | prompt-too-large | companion-error → not green, not a code "no".
  return 'unverified';
}

/**
 * Build the per-node detail array. `logContents` maps node path → raw log.md text
 * (read by the impure caller; parsed here). `suppressions` is the already-built
 * inventory (filtered per node by the node's mapped files).
 */
export function buildPortalNodes(
  graph: Graph,
  // `lock` is part of the stable derivation signature (forward-compat with the
  // catalogue/boundary steps that key off the same lock); the per-node detail is
  // derived entirely from the already-verified pairs, so it is not read here.
  _lock: LockFile,
  verification: LockVerification,
  check: CheckResult,
  logContents: Map<string, string>,
  suppressions: SuppressionsByFile,
  // The file-aware loop: nodePath → true when the node's mapped source changed since
  // its last positive closure. A fresh node's own state is forced to at least
  // `unverified` ("we don't know"), so a touched file never reads green anywhere.
  // Optional: absent/empty means no node is treated as touched (the cold baseline).
  freshByNode: Map<string, boolean> = new Map(),
): PortalNode[] {
  // Index pair states by node path → aspectId → the per-unit pair records
  // (state PLUS the verdict's covered subject files / refusal reason for drill-through).
  const pairsByNode = indexPairsByNode(verification.pairs);
  // Index node-scoped issues by node path (for the `warning` own-state signal).
  const issuesByNode = indexIssuesByNode(check.issues);
  // relationsIn: invert every declared relation across the graph.
  const relationsIn = invertRelations(graph);

  const built = new Map<string, PortalNode>();
  for (const [path, node] of graph.nodes) {
    built.set(
      path,
      buildOne(
        node,
        graph,
        pairsByNode,
        issuesByNode,
        relationsIn,
        logContents,
        suppressions,
        freshByNode.get(path) === true,
      ),
    );
  }

  // Roll up bottom-up: a node's rollupState is the worst of its own state and the
  // rollupState of every direct child. `graph.nodes` is pre-order DFS (the loader
  // inserts a node before recursing into its children), so iterating it in REVERSE
  // visits every descendant before its ancestor — each child's rollupState is already
  // finalized when its parent is computed, letting a deep refusal bubble the whole way
  // up. `built` is keyed by path so we resolve children by their paths.
  for (const [path, node] of [...graph.nodes].reverse()) {
    const portal = built.get(path)!;
    portal.rollupState = computeRollup(node, built);
  }

  return [...built.values()];
}

/**
 * One per-unit verdict record for the panel's attestation drill-through. `state` is the
 * collapsed honest pair-state; `subjectFiles` is the exact byte set the verdict covers for
 * that unit (the "these exact bytes" a green attests); `reason` is the refusal message a
 * refused verdict carries. Kept alongside the state so a VERIFIED row can cite its inputs
 * and a REFUSED row can cite the reviewer's "no" — the panel renders both.
 */
interface PairRecord {
  state: PortalPairState;
  subjectFiles: string[];
  reason?: string;
}

/** Map nodePath → aspectId → list of per-unit verdict records for that aspect's units. */
function indexPairsByNode(pairs: VerifiedPair[]): Map<string, Map<string, PairRecord[]>> {
  const out = new Map<string, Map<string, PairRecord[]>>();
  for (const vp of pairs) {
    // A nodeless (type-covered-file) pair has no component to index under —
    // Task 11 adds its own channel; skip here rather than letting `undefined`
    // become a map key.
    if (vp.pair.nodePath === undefined) continue;
    const np = vp.pair.nodePath;
    let byAspect = out.get(np);
    if (!byAspect) {
      byAspect = new Map();
      out.set(np, byAspect);
    }
    const list = byAspect.get(vp.pair.aspectId) ?? [];
    list.push(toPairRecord(vp));
    byAspect.set(vp.pair.aspectId, list);
  }
  return out;
}

/**
 * Collapse a VerifiedPair into a record: the status-adjusted DISPLAY state (an advisory
 * refusal → `warning`, gate states → `unverified`) + drill-through data. The refusal `reason`
 * is preserved for BOTH a blocking `refused` row and a status-adjusted `warning` row — an
 * advisory refusal still carries the reviewer's "no" the panel renders, it just renders it as
 * non-blocking signal.
 */
function toPairRecord(vp: VerifiedPair): PairRecord {
  const subjectFiles = vp.pair.subjectFiles ?? [];
  const state = displayPairState(vp.state.kind, vp.pair.status);
  if (vp.state.kind === 'refused') {
    return { state, subjectFiles, reason: vp.state.reason };
  }
  return { state, subjectFiles };
}

/** Map nodePath → its node-scoped check issues (those carrying a nodePath). */
function indexIssuesByNode(issues: CheckIssue[]): Map<string, CheckIssue[]> {
  const out = new Map<string, CheckIssue[]>();
  for (const i of issues) {
    if (!i.nodePath) continue;
    const list = out.get(i.nodePath) ?? [];
    list.push(i);
    out.set(i.nodePath, list);
  }
  return out;
}

/** Build the reverse relation index: target path → {source, type}[]. */
function invertRelations(graph: Graph): Map<string, PortalRelationIn[]> {
  const out = new Map<string, PortalRelationIn[]>();
  for (const [path, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      const list = out.get(rel.target) ?? [];
      list.push({ source: path, type: rel.type });
      out.set(rel.target, list);
    }
  }
  return out;
}

function buildOne(
  node: GraphNode,
  graph: Graph,
  pairsByNode: Map<string, Map<string, PairRecord[]>>,
  issuesByNode: Map<string, CheckIssue[]>,
  relationsIn: Map<string, PortalRelationIn[]>,
  logContents: Map<string, string>,
  suppressions: SuppressionsByFile,
  fresh: boolean,
): PortalNode {
  const path = node.path;
  const mapping = node.meta.mapping ?? [];

  const effectiveIds = computeEffectiveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const nodePairs = pairsByNode.get(path);

  const effectiveAspects: PortalEffectiveAspect[] = [];
  for (const aspectId of [...effectiveIds].sort()) {
    // Aggregate aspects are effective (their implied children expand) but have no
    // own reviewer / verdict — they are surfaced as an `aggregate` row, never a pair.
    effectiveAspects.push(
      buildEffectiveAspect(aspectId, node, graph, statuses, nodePairs),
    );
  }

  // `checked` = the node has at least one REAL verdict-bearing pair, NOT merely a
  // non-draft effective aspect. An empty-mapping container that inherits a type-default
  // aspect has `hasNonDraftEffectiveAspects === true` yet produces ZERO expected pairs
  // (computeExpectedPairs yields no pair for an empty mapping or an all-vacuous subject
  // set), so every effective row resolves to `n/a`. Seeding such a node `verified` would
  // fabricate a green over a node nothing actually checks — the exact honesty defect. A
  // node is checked ONLY when an effective row carries a non-`n/a` pair state (verified /
  // refused / unverified); otherwise it is honestly `no-rule` (nothing verdict-bearing
  // here), exactly like the sibling empty nodes that already read no-rule.
  const checked = effectiveAspects.some((ea) => ea.pairState !== 'n/a');

  const ownState = computeOwnState(
    checked,
    effectiveAspects,
    issuesByNode.get(path) ?? [],
    fresh,
  );

  const relationsOut: PortalRelationOut[] = (node.meta.relations ?? []).map((r) => ({
    target: r.target,
    type: r.type,
    ...(r.consumes ? { consumes: r.consumes } : {}),
  }));

  const log: PortalLogEntry[] = parseLog(logContents.get(path) ?? '').map((e) => ({
    when: e.datetime,
    body: e.body,
  }));

  const nodeSuppressions = collectNodeSuppressions(mapping, suppressions);
  const notApplicable = computeNotApplicable(node, graph, effectiveIds);

  return {
    path,
    name: node.meta.name,
    type: node.meta.type,
    ...(node.meta.description ? { description: node.meta.description } : {}),
    parent: node.parent ? node.parent.path : null,
    mapping,
    sourceFileCount: mapping.length,
    isTest: node.meta.type === 'test-suite',
    checked,
    fresh,
    state: ownState,
    // Provisional — overwritten by the bottom-up roll-up pass; seeded to own state.
    rollupState: ownState,
    effectiveAspects,
    notApplicable,
    relationsOut,
    relationsIn: relationsIn.get(path) ?? [],
    suppressions: nodeSuppressions,
    log,
  };
}

function buildEffectiveAspect(
  aspectId: string,
  node: GraphNode,
  graph: Graph,
  statuses: Map<string, AspectStatus>,
  nodePairs: Map<string, PairRecord[]> | undefined,
): PortalEffectiveAspect {
  const def = graph.aspects.find((a) => a.id === aspectId);
  const aggregate = isAggregateAspect(graph, aspectId);
  const kind: PortalEffectiveAspect['kind'] = aggregate
    ? 'aggregate'
    : def?.reviewer.type === 'deterministic'
      ? 'deterministic'
      : 'llm';

  // Provenance: the highest-priority status source (channel 1 wins display order).
  const sources = getAspectStatusSources(node, aspectId, graph);
  const primary = sources.length > 0 ? sources.reduce((a, b) => (a.channel <= b.channel ? a : b)) : undefined;
  const channel = primary?.channel ?? 7; // 7 = implied (no direct attach source)
  const origin = primary?.origin ?? impliedOrigin(graph, aspectId);

  const status = statuses.get(aspectId) ?? 'enforced';

  // Cost + tier/consensus apply only to LLM aspects. A free, keyless reviewer
  // (a local CLI provider) is still classed `billed` here only when the resolved
  // tier reports a paid provider — but the contract distinguishes free/billed by
  // reviewer KIND: deterministic and aggregate are always free; LLM is billed.
  let tier: string | undefined;
  let consensus: number | undefined;
  let cost: PortalEffectiveAspect['cost'] = 'free';
  if (kind === 'llm' && def) {
    cost = 'billed';
    const reviewer = graph.config?.reviewer;
    if (reviewer) {
      const sel = selectTierForAspect(def, reviewer);
      if (sel.ok) {
        tier = sel.tierName;
        consensus = sel.tier.consensus;
      }
    }
  }

  // pairState: the worst per-unit DISPLAY state across this aspect's units on the node. The
  // records already carry the status-adjusted state (an advisory refusal reads `warning`), so a
  // node with an advisory-refused unit reports `warning` here, never a blocking `refused`. An
  // aggregate aspect has no pair → 'n/a'. A draft aspect produces no expected pair → 'n/a'.
  // Otherwise collapse the unit states (refused > unverified > warning > verified).
  const records = nodePairs?.get(aspectId);
  const pairState: PortalPairState =
    aggregate || status === 'draft' || !records || records.length === 0
      ? 'n/a'
      : worstPairState(records.map((r) => r.state));

  // Attestation drill-through (the panel renders these). A VERIFIED row carries the exact
  // covered byte set ("this green attests these exact bytes"); a REFUSED row — and a status-
  // adjusted advisory refusal shown as a WARNING — carries the reviewer's "no". Aggregate /
  // draft rows have no verdict → neither. We thread the data off the per-unit records that
  // produced `pairState`: the union of covered subject files for a verified row, and the first
  // non-empty refusal reason for a refused / advisory-warning row.
  let foldedInputs: string[] | undefined;
  let reason: string | undefined;
  if (!aggregate && status !== 'draft' && records && records.length > 0) {
    if (pairState === 'verified') {
      const files = new Set<string>();
      for (const r of records) for (const f of r.subjectFiles) files.add(f);
      const sorted = [...files].sort();
      if (sorted.length > 0) foldedInputs = sorted;
    } else if (pairState === 'refused' || pairState === 'warning') {
      reason = records.find((r) => r.reason)?.reason;
    }
  }

  return {
    aspectId,
    kind,
    ...(tier !== undefined ? { tier } : {}),
    ...(consensus !== undefined ? { consensus } : {}),
    cost,
    status,
    channel,
    origin,
    pairState,
    ...(reason !== undefined ? { reason } : {}),
    ...(foldedInputs !== undefined ? { foldedInputs } : {}),
  };
}

/** Origin label when an aspect reaches the node only via implies (channel 7). */
function impliedOrigin(graph: Graph, aspectId: string): string {
  for (const other of graph.aspects) {
    if (other.implies?.includes(aspectId)) return `implied:${other.id}`;
  }
  return 'unknown';
}

