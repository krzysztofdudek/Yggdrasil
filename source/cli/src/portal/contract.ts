/**
 * PortalData — the single typed seam between the portal's backend extraction
 * pipeline and its frontend. The pipeline emits exactly this object; the frontend
 * consumes it. Pure type/const declarations only — no runtime behavior, no I/O,
 * no cross-node imports. Every field is DERIVED live by the pipeline; nothing here
 * is hardcoded data.
 *
 * The honest-state taxonomy is the spine: verified / refused / unverified are pair
 * states a reviewer produced; no-rule / not-applicable / draft / suppressed /
 * live-boundary are deliberately distinct and must never be collapsed into "green".
 * The STATES tuple below anchors that taxonomy as an explicit, exported constant so
 * a future refactor cannot silently drop a state.
 */

/**
 * The honest node-level render states. "verified" is the only green: a reviewer ran,
 * approved, AND the stored hash still matches current inputs. The others are each
 * visually and structurally distinct — never coalesced.
 */
export const STATES = [
  'verified',
  'refused',
  'unverified',
  'no-rule',
  'warning',
] as const;

export type PortalState = (typeof STATES)[number];

/**
 * The reviewer-pair DISPLAY states for a single (aspect, unit) pair — status-adjusted.
 *
 * `warning` is the status-adjusted rendering of a `refused` verdict on an ADVISORY aspect:
 * per the honesty model, an advisory refusal is non-blocking signal, so it renders as a
 * warning, NEVER as a blocking `refused` (which would contradict `yg check`). A
 * refused+ENFORCED pair stays `refused` — a real, blocking "no". verified / unverified /
 * n/a are unchanged. The transform lives in `displayPairState` (derive-nodes.ts); every
 * surface that paints a pair state reads it through that one transform so no view can show
 * an advisory refusal as a blocking refused.
 */
export type PortalPairState = 'verified' | 'refused' | 'unverified' | 'warning' | 'n/a';

export interface PortalCounts {
  nodes: number;
  aspects: number;
  flows: number;
  pairsTotal: number;
  pairsLLM: number;
  pairsDet: number;
  // Pair states (a reviewer or check produced them).
  verified: number;
  /**
   * Split of `verified` by reviewer kind: pairs whose verdict came from a local, free
   * `check.mjs` (verifiedDet) vs an LLM reviewer call (verifiedLlm). Additive — mirrors
   * `CheckResult.verifiedDet`/`verifiedLlm` (the same tally, read off the same pairs loop),
   * so `verifiedDet + verifiedLlm === verified` always holds.
   */
  verifiedDet: number;
  verifiedLlm: number;
  // ENFORCED refusals only — a real, blocking "no" that equals what `yg check` blocks on.
  refused: number;
  unverified: number;
  /**
   * Status-adjusted bucket: pairs whose verdict is `refused` but whose effective aspect status
   * is ADVISORY. Per the honesty model an advisory refusal is non-blocking signal — it renders
   * as a WARNING, never as a blocking `refused`, and it is ALREADY reflected in `warnings`
   * (runCheck emits the advisory deterministic refusal as a warning issue). This bucket keeps
   * the count-parity identity whole without double-counting: it is the refused-but-advisory
   * pairs that left the `refused` bucket, so
   * verified + refused + unverified + advisoryRefused === pairsTotal still holds.
   */
  advisoryRefused: number;
  // Non-pair track — kept structurally separate from the pair states above.
  noRule: number;
  draft: number;
  notApplicable: number;
  suppressed: number;
  uncoveredFiles: number;
  coveredFiles: number;
  totalFiles: number;
  // Severities — equal to what `yg check` reports.
  errors: number;
  warnings: number;
}

export interface PortalMeta {
  projectName: string;
  /** ISO timestamp; stamped AFTER generation by the pipeline (never inside a pure module). */
  generatedAt: string;
  /** From the committed reviewer config. */
  autoApprove: 'false' | 'deterministic' | 'full';
  /** false in --no-write / view-only mode. */
  writeEnabled: boolean;
  /** CLI_SUPPORTED_SCHEMA at extraction time. */
  schemaSupported: string;
  /**
   * A content hash over the COMMITTED lock triad (nondeterministic verdicts + the per-node
   * logs baseline). The gitignored deterministic cache is excluded by design — it is absent
   * on a fresh clone and never committed, so folding it would make the same commit hash
   * differently on different machines. This pins the exact committed verdict set an
   * attestation digest attests to. '' only when no committed lock exists yet.
   */
  lockHash: string;
  /**
   * The current git HEAD commit ref (full sha), read read-only from `.git`. `null` when the
   * project is not a git repo or HEAD cannot be read — the digest then states "no commit ref"
   * rather than fabricating one.
   */
  commitRef: string | null;
  counts: PortalCounts;
}

export interface PortalEffectiveAspect {
  aspectId: string;
  kind: 'llm' | 'deterministic' | 'aggregate';
  tier?: string;
  consensus?: number;
  cost: 'free' | 'billed';
  status: 'draft' | 'advisory' | 'enforced';
  channel: number;
  origin: string;
  pairState: PortalPairState;
  reason?: string;
  foldedInputs?: string[];
}

export interface PortalRelationOut {
  target: string;
  type: string;
  consumes?: string[];
}

export interface PortalRelationIn {
  source: string;
  type: string;
}

export interface PortalLogEntry {
  when: string;
  body: string;
}

export interface PortalNode {
  path: string;
  name: string;
  type: string;
  description?: string;
  parent: string | null;
  mapping: string[];
  /**
   * The number of entries in `mapping` — a count of DECLARATIONS (each a directory, a
   * glob, or an exact file path), never a count of the files those declarations resolve
   * to on disk. One directory or glob entry can expand to any number of real files (a
   * node whose mapping is a single directory covering hundreds of files still has
   * `mappingEntryCount === 1`), and a node whose one mapped file is excluded from graph
   * coverage still has `mappingEntryCount === 1` even though nothing enforces it. Neither
   * shape is what "how many source files does this node have" would answer — this field
   * intentionally does not claim to answer that question.
   */
  mappingEntryCount: number;
  isTest: boolean;
  /**
   * true = the node has at least one REAL verdict-bearing pair (an effective-aspect row
   * whose pair state is verified/refused/unverified — NOT a vacuous `n/a`). An empty-mapping
   * container that merely inherits a type-default aspect produces zero pairs, so it is NOT
   * checked: it reads the honest `no-rule` state, never a fabricated green.
   */
  checked: boolean;
  /**
   * The file-aware loop signal: true when this node's mapped source has changed since its
   * last positive closure (its current source fingerprint differs from the committed lock
   * fingerprint), or it owns source and has never reached closure. A touched node is "we
   * don't know" — its `state` is forced to `unverified` and the whole-repo cached green can
   * NEVER render it as a pass. This is computed even for a no-rule node that owns source: a
   * node with no aspects still reads unverified after an edit, never green.
   */
  fresh: boolean;
  state: PortalState;
  /** Bottom-up roll-up over children — kept SEPARATE from own `state`. */
  rollupState: PortalState;
  effectiveAspects: PortalEffectiveAspect[];
  /** when-filtered-out aspects: attached but not effective on this node. */
  notApplicable: Array<{ aspectId: string; why: string }>;
  relationsOut: PortalRelationOut[];
  relationsIn: PortalRelationIn[];
  suppressions: PortalSuppression[];
  log: PortalLogEntry[];
}

// ── Catalogue / topology types ─────────────────────────────────────────────
// Detailed in later derivation tasks; declared here so the contract is the one
// seam. The pipeline populates them incrementally.

/**
 * Per-aspect tally with three HONEST renderings, never collapsed to one number:
 *   - normal     — V/R/W/U over the aspect's expected pairs (a reviewer/check produced them).
 *                  `warning` is the status-adjusted count of refused-but-ADVISORY units — a
 *                  non-blocking signal, kept distinct from a blocking `refused` so an advisory
 *                  aspect's tally never paints a refusal red.
 *   - aggregate  — an aggregating bundle has no own reviewer: it "judges nothing".
 *   - vacuous    — a rule-bearing aspect that resolves to ZERO expected pairs
 *                  (no effective node, all-draft, or scope/when excludes everything):
 *                  it "verifies nothing". The `reason` explains why.
 */
export type PortalAspectTally =
  | { render: 'normal'; verified: number; refused: number; warning: number; unverified: number; units: number }
  | { render: 'aggregate' }
  | { render: 'vacuous'; reason: string };

export interface PortalAspect {
  id: string;
  name: string;
  kind: 'llm' | 'deterministic' | 'aggregate';
  status: 'draft' | 'advisory' | 'enforced';
  /** Review granularity — 'node' (default) or 'file'. */
  scope: 'node' | 'file';
  /** True when the aspect carries a global `when` applicability predicate. */
  hasWhen: boolean;
  /** Aspect ids this aspect includes recursively (channel 7). */
  implies: string[];
  /** The human description from the aspect's yg-aspect.yaml (a one-to-few-line summary). */
  description?: string;
  /** The rule prose (content.md) for an LLM aspect; absent for deterministic/aggregate. */
  ruleProse?: string;
  /** The deterministic check source (check.mjs) for a deterministic aspect; absent otherwise. */
  checkSource?: string;
  tally: PortalAspectTally;
}

/**
 * A flow's honest aggregate state. A flow is NEVER green merely because nothing
 * was checked — an all-no-rule participant set yields 'nothing-checked', distinct
 * from 'verified'. 'attention' covers any refused/unverified participant.
 */
export type PortalFlowState = 'verified' | 'attention' | 'nothing-checked';

export interface PortalFlow {
  name: string;
  description?: string;
  /** Declared participants PLUS their auto-expanded descendants (engine semantics). */
  participants: string[];
  /** Flow-level aspect ids (propagate to all participants). */
  aspects: string[];
  state: PortalFlowState;
}

export interface PortalType {
  id: string;
  description?: string;
  parents: string[];
  /** Allowed relation targets per relation type (the architecture matrix row). */
  allowedRelations: Record<string, string[]>;
  /** Default aspects applied to every node of this type (channel 3). */
  defaultAspects: string[];
  /** enforce: strict (backward classification enforced). */
  strict: boolean;
  /** log_required for this type. */
  logRequired: boolean;
  nodeCount: number;
}

export interface PortalBoundary {
  phantom: Array<{ source: string; target: string }>;
  declaredOnly: Array<{ source: string; target: string }>;
  forbiddenType: Array<{ source: string; target: string }>;
  /** true when the relation parse could not run — never fabricate a clean boundary. */
  unknown: boolean;
}

/**
 * Portal-local boundary input — the producer/consumer seam for the live boundary.
 * The facade (the single engine gateway) PRODUCES this by joining the relation pass
 * with the architecture matrix; `buildBoundary` in the pipeline CONSUMES it. `null`
 * means the relation parse could NOT run (a thrown pass), which surfaces as
 * `unknown: true` — never a fabricated-clean boundary.
 */
export interface BoundaryInput {
  /** PHANTOM: real code dependency on another mapped node with no declared relation. */
  phantom: Array<{ source: string; target: string }>;
  /** DECLARED-ONLY: a declared structural relation with no static code backing (DI / HTTP / events). */
  declaredOnly: Array<{ source: string; target: string }>;
  /** FORBIDDEN-TYPE: a detected dependency whose target type the architecture matrix forbids. */
  forbiddenType: Array<{ source: string; target: string }>;
  /**
   * The FULL set of statically-detected cross-node code edges, keyed source → targets. This is
   * the relation pass's `detectedEdgesByNode` (a `Map<string, Set<string>>`) ALREADY FLATTENED to
   * plain arrays at this seam — the Map/Set do NOT survive `JSON.stringify`, so the facade converts
   * them here, before they can reach `PortalData`. The structure derivation reconstructs the
   * universe from this half plus the declared structural relations, so surfacing it costs NO second
   * relation pass. Absent only on older producers; the pipeline treats absence as an empty set.
   */
  detectedEdgesByNode?: Array<{ from: string; targets: string[] }>;
}

/**
 * Portal-local suppression marker — the producer/consumer seam for the live inventory.
 * The facade PRODUCES these (adapting the suppression scan, resolving each marker's risk);
 * `buildSuppressions` in the pipeline CONSUMES them. `risk` is the resolved risk flag
 * (wildcard / unbounded / inert / typo), or absent when the marker is clean.
 */
export interface SuppressionMarkerInput {
  file: string;
  line: number;
  aspectId: string;
  reason: string;
  risk?: 'wildcard' | 'unbounded' | 'inert' | 'typo';
}

export interface PortalSuppression {
  aspectId: string;
  file: string;
  line: number;
  reason: string;
  risk?: 'wildcard' | 'unbounded' | 'inert' | 'typo';
}

/**
 * Portal-local freshness marker — the producer/consumer seam for the file-aware loop. The
 * facade PRODUCES one per node by comparing each node's current source fingerprint against
 * the committed lock fingerprint; `buildPortalNodes` in the pipeline CONSUMES it to force a
 * touched node's state to unverified. `sourceChanged: true` means the node's mapped bytes
 * differ from what last reached positive closure (or it owns source and has no baseline yet).
 */
export interface FreshnessMarkerInput {
  nodePath: string;
  sourceChanged: boolean;
}

export interface HubEntry {
  path: string;
  count: number;
}

export interface WorklistGroup {
  rule: string;
  severity: 'error' | 'warning';
  why: string;
  fix: string;
  nodes: string[];
}

/**
 * The honest "what is NOT being verified" ledger: nodes that own source but carry
 * no non-draft effective aspect, plus repo files mapped to no node at all. Surfaced
 * so the absence of red can never read as full coverage.
 */
export interface PortalResidue {
  noRuleNodes: string[];
  uncoveredFiles: string[];
}

/**
 * One entry in the structure panel's "tunnels" list — a structural dependency ranked by how far
 * it reaches across the component hierarchy. `span` is the number of hierarchy hops the edge
 * traverses (0 for an edge between siblings' shared parent, larger for edges that reach across
 * distant subtrees). `viaContract` is true when a declared port contract backs the edge; `origin`
 * records whether the pair is declared-only, statically-detected-only, or both. Plain data only —
 * the frontend renders `span` in words ("spans N levels across the tree"), never as jargon.
 */
export interface PortalStructureTunnel {
  from: string;
  to: string;
  span: number;
  viaContract: boolean;
  origin: 'declared' | 'detected' | 'both';
}

/**
 * One depth level of the "module groups" view: the component groups at that level of the tree and
 * how they depend on one another. `groups` are the distinct group ids at this depth (sorted);
 * `crossings` is the count of dependencies that cross BETWEEN groups; `loopShare` is the fraction
 * (0..1) of those crossings that form a loop (groups that depend on each other), the rest flowing
 * one way. Rendered in plain language — never "quotient", "SCC", or "conductance".
 */
export interface PortalStructureLayer {
  depth: number;
  groups: string[];
  crossings: number;
  loopShare: number;
}

/**
 * The read-only structure panel's data — the SAME analysis `yg structure` computes (dependency
 * tunnels, module groups, change reach) surfaced for the portal. FULLY JSON-flat: no `Map`/`Set`
 * survives to this shape, so it round-trips through `JSON.stringify` losslessly.
 *
 * Honesty is the spine: `unknown: true` means the relation parse could NOT run — the panel renders
 * an explicit UNKNOWN state, NEVER a fabricated empty/zero graph. `smallGraph` is the small-N floor
 * signal: below the node-count floor the average-reach figure is not statistically meaningful, so
 * the panel shows the raw number WITHOUT the interpretive "average component" sentence.
 */
export interface PortalStructure {
  /** true ⇔ the relation parse could not run; render UNKNOWN, never a fabricated zero graph. */
  unknown: boolean;
  /** Structural edges in the universe (declared structural relations ∪ statically detected; events excluded). */
  edgeCount: number;
  /** Total graph nodes — the change-reach denominator basis and the small-N floor input. */
  nodeCount: number;
  /** The widest-spanning tunnels, ranked span-desc then (from, to), capped at the top-N. */
  tunnels: PortalStructureTunnel[];
  /** Module-group layers per depth (only depths that resolve to 2+ groups). */
  layers: PortalStructureLayer[];
  /** Mean forward-reach fraction across all nodes (0..1). */
  reachMean: number;
  /** true ⇔ nodeCount is below the interpretive-caption floor — show the raw figure only. */
  smallGraph: boolean;
}

export interface PortalData {
  meta: PortalMeta;
  nodes: PortalNode[];
  aspects: PortalAspect[];
  flows: PortalFlow[];
  types: PortalType[];
  boundary: PortalBoundary;
  structure: PortalStructure;
  suppressions: PortalSuppression[];
  hubs: { fanIn: HubEntry[]; fanOut: HubEntry[] };
  worklist: WorklistGroup[];
  residue: PortalResidue;
}
