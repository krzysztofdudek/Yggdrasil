/**
 * What an edit costs to re-verify, as data: why a pair is invalidated, a unit
 * whose cost could not be worked out, and the cost and blast-radius facts
 * `yg impact` reports for a file, a node, a rule, a flow and a type. Pure
 * types, in the model layer so the engine that computes them
 * (core/impact-cost.ts, core/graph/impact-graph.ts) and the formatter that
 * words them (formatters/impact-text.ts) name the same shapes without depending
 * on each other.
 */
import type { AspectStatus } from './graph.js';

export type ImpactReason =
  | 'own'                           // F is in the pair's subject set
  | 'reference'                     // a reviewer rule references F (hashed into every pair of the aspect)
  | 'observe-companion'             // companion-LLM observation references F (warm lock OR cold-resolved)
  | 'observe-deterministic'         // deterministic check observation references F (warm lock)
  | 'cold-potential-deterministic'  // deterministic, no lock entry, F in allowed-reads (free, upper bound)
  | 'cold-potential-companion';     // companion-LLM, no lock entry, F in allowed-reads (upper bound; the companion is never run to narrow it)

export interface UnresolvedUnit { aspectId: string; unitKey: string; nodePath?: string; why: string }

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

export interface NodeFillCost {
  llmPairs: number;       // expected LLM pairs in scope (one per unit)
  detPairs: number;       // expected deterministic pairs in scope (free)
  reviewerCalls: number;  // Σ over LLM pairs of the pair aspect's resolved consensus
  greensReRolled: number; // currently-green (approved) pairs in scope a re-fill re-rolls
}

export interface GraduationPreview {
  file: string;
  currentType: string;
  llmPairsReVerified: number;
  reviewerCalls: number;
  detPairsReVerified: number;
}

export interface TypeVerdictImpact {
  typeCoveredFiles: number;
  detPairs: number;
  llmPairs: number;
  reviewerCalls: number;
  /**
   * Of detPairs+llmPairs, how many currently hold a stored 'approved'
   * verdict — the SAME "at stake" refinement NodeFillCost's own
   * greensReRolled field gives every other cost preview. The four base
   * counts are unconditional (every expected pair, filled or not — "cost of
   * re-verifying" counts ALL pairs, not just already-verified ones).
   */
  greensAtStake: number;
}

/** What re-filling every pair of one rule costs after a change to it. */
export interface AspectFillCost {
  kind: 'llm' | 'deterministic' | 'unknown';
  units: number;        // expected pairs of the aspect (per: file → one per file)
  reviewerCalls: number; // units × resolved consensus (0 for deterministic)
  /**
   * Of `units`, how many belong to a file enforced by its architecture type
   * alone (no owning node) — never counted in the "Directly affected" list,
   * since that list only ever walks the graph's components. A change that
   * touches ONLY such files must never be reported as costing nothing just
   * because no component appears in that list.
   */
  fileUnits: number;
}

/** One component a rule reaches, with the channel it reaches it through. */
export interface AspectImpactRow {
  path: string;
  /** `own`, `hierarchy from <ancestor>`, `flow: <name>` or `implied`. */
  source: string;
  status: AspectStatus;
  refused: boolean;
}

/** The blast radius of a change to one rule. */
export interface AspectImpact {
  aspectId: string;
  affected: AspectImpactRow[];
  indirectPaths: string[];
  chains: string[];
  propagatingFlows: string[];
  impliedBy: string[];
  implies: string[];
  cost: AspectFillCost;
}

/** The blast radius of a change to one flow. */
export interface FlowImpact {
  flowName: string;
  /** Every participant, declared or a descendant of one, sorted. */
  participants: Array<{ path: string; declared: boolean }>;
  indirectPaths: string[];
  chains: string[];
  flowAspects: string[];
  /** How many of the flow's declared participants exist in the graph. */
  declaredParticipants: number;
}

/** A file a type covers, and where it is covered from. */
export interface TypeCoveredFileRow {
  path: string;
  /** `in <node>` for a node's mapping, `type-covered, no component` for the type alone. */
  label: string;
}

/** The files a strict type's `when` matches that sit outside a node of that type. */
export interface StrictCoverageGap {
  orphans: string[];
  misplaced: Array<{ file: string; owner: string; ownerType: string }>;
}
