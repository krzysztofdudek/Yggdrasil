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
  /** Files satisfying coverage via a matched classifying type, no node. 0 when typeLevel is off. Named for symmetry with CheckResult.typeCoveredCount. */
  typeCoveredCount: number;
  /** Files under a coverage.excluded root — mirrors CheckResult.excludedFiles exactly. Already folded into the legacy coveredFiles total; exposed here as its own term so a consumer can subtract it out honestly instead of guessing. */
  excludedFiles: number;
  /**
   * Split of `typeCoveredCount`: how many of those files matched a classifying type whose
   * cascade RAN to completion and produced NO applicable rule at all (any status) — the exact
   * state `yg check`'s "satisfy coverage with no enforcement" bucket names. Deliberately
   * EXCLUDES a file counted under `typeCoveredUncomputable` below: a cascade an aspect `implies`
   * cycle stopped never ran, so "resolution ran and found nothing" and "resolution never ran"
   * must never share this count, the same distinction `yg check`, `yg context --file`, and `yg
   * owner --file` already draw. A type-covered file is "checked" only when both this and
   * `typeCoveredUncomputable` are excluded; the rest of `typeCoveredCount`
   * (typeCoveredCount - typeCoveredUnenforced - typeCoveredUncomputable) genuinely has a real
   * verdict. 0 when typeLevel is off or every type-covered file has at least one applicable rule.
   * Derived the same post-pass way `noRule` / `notApplicable` / `suppressed` are — see the
   * comment above `extractPortalData`'s residue-track fill.
   */
  typeCoveredUnenforced: number;
  /**
   * Split of `typeCoveredCount`: how many of those files matched a classifying type whose
   * cascade an aspect `implies` cycle stopped from ever being resolved — the same fact `yg
   * check`'s repo-wide "could not have its rules worked out" rollup, `yg context --file`, and
   * `yg owner --file` each report by naming the cycle, rather than calling the file
   * "satisfies coverage with no enforcement." Disjoint from `typeCoveredUnenforced` (see its own
   * doc) — a file is counted in exactly one of the two, never both, never neither. 0 when
   * typeLevel is off or no aspect `implies` cycle reaches a type-covered file's type.
   */
  typeCoveredUncomputable: number;
  // Severities — equal to what `yg check` reports.
  errors: number;
  warnings: number;
  /**
   * Total suppression markers the scan found (`SuppressionsReport.totalMarkers`), INCLUDING
   * enable/terminator markers that close or reopen scope rather than waive anything. Always
   * `>= suppressions.length`; the delta is how many markers on disk are not themselves
   * waivers, so a consumer can print "K markers on disk (a closing marker is not a waiver)"
   * instead of conflating marker count with waiver count.
   */
  suppressionMarkers: number;
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
   * `mappingEntryCount === 1`). "How many source files does this node have" is answered
   * by the sibling field `sourceFileCount`, not this one.
   */
  mappingEntryCount: number;
  /**
   * The real number of on-disk source files this node's mapping resolves to — the answer
   * `mappingEntryCount` deliberately does not give. Computed the same exclusion-aware,
   * child-carve-out-aware way the node's own source fingerprint is (`computeNodeMappedFiles`):
   * a file excluded from graph coverage (a nested project's own boundary, or a
   * `coverage.excluded` root) is never counted, and a file a MORE SPECIFIC descendant node
   * also maps is counted only for that descendant, never for the ancestor whose directory
   * mapping happens to sweep it in too — so a parent and a child mapping the same directory
   * never double-count the same file between them. A mapping-less node reads 0.
   */
  sourceFileCount: number;
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

/** One relation type's resolved allow-list for a `PortalType` — a single row of the architecture matrix. */
export interface PortalTypeAllowed {
  /** Relation type (all six). */
  type: string;
  /** `'any'` ⇔ resolved allow-all for this relation type. */
  targets: string[] | 'any';
}

export interface PortalType {
  id: string;
  description?: string;
  parents: string[];
  /**
   * Resolved allow-list per relation type: `default`/`'*'`/`[]` already settled by the engine
   * primitive (`allowedRelationTypes`) — never re-derive an allow/deny reading from raw matrix
   * rows downstream, or a default-allow graph renders inverted.
   */
  allowed: PortalTypeAllowed[];
  /**
   * `def.when !== undefined` — the classifying/organizational badge keys off THIS, never off
   * `allowed`: deriving it from resolved relations would flip every type to "classifying" on a
   * default-allow graph.
   */
  classifying: boolean;
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
  /**
   * The live type-relation gate's own edges (`coverage.type_level` on): every statically-resolved
   * import edge with at least one type-covered endpoint, already translated into the same plain
   * edge shape the structure panel consumes (`origin` is always `'detected'` here — a type-covered
   * endpoint has no declared-relation channel to be `'declared'` or `'both'`). Computed by the SAME
   * relation pass as the three classes above and `detectedEdgesByNode`, when the caller seeds it
   * with a type-coverage classification — surfacing it costs no extra relation pass. `[]` when the
   * tier is off, nothing was classified, or the caller didn't seed a classification; absent only on
   * an older producer (the pipeline treats absence as empty, the same convention `detectedEdgesByNode`
   * already uses).
   */
  typedEdges?: Array<{ from: string; to: string; viaContract: boolean; origin: 'declared' | 'detected' | 'both' }>;
}

/**
 * Portal-local suppression marker — the producer/consumer seam for the live inventory.
 * The facade PRODUCES these (adapting the suppression scan, resolving each marker's form
 * and risk); `buildSuppressions` in the pipeline CONSUMES them. `risk` is the resolved risk
 * flag (wildcard / unbounded / inert / typo / errs-under), or absent when the marker is
 * clean. BOTH this interface and `PortalSuppression` below change together — this is the
 * producer seam `scanPortalSuppressions` returns and `buildSuppressions` consumes, so a
 * field added to one without the other silently stops propagating.
 */
export interface SuppressionMarkerInput {
  file: string;
  line: number;
  aspectId: string;
  reason: string;
  /**
   * Suppression scope shape — 'line' (single marker line), 'range' (start/end block), or
   * 'file' (whole-file marker, no per-line/range scope). Drives the listing's scope label;
   * independent of `risk`, which flags WHY the waiver itself is suspect, not its shape.
   */
  form: 'line' | 'range' | 'file';
  /**
   * Resolved risk flag, or absent when the marker is clean. `'errs-under'` flags a waiver
   * on an aspect whose status can never itself error (`errs: 'under'`) — it waives nothing
   * that could actually fire. Precedence when a marker could read more than one: wildcard >
   * typo > inert > errs-under > unbounded.
   */
  risk?: 'wildcard' | 'unbounded' | 'inert' | 'typo' | 'errs-under';
}

export interface PortalSuppression {
  aspectId: string;
  file: string;
  line: number;
  reason: string;
  /** See `SuppressionMarkerInput.form` — carried through unchanged. */
  form: 'line' | 'range' | 'file';
  /** See `SuppressionMarkerInput.risk` — carried through unchanged. */
  risk?: 'wildcard' | 'unbounded' | 'inert' | 'typo' | 'errs-under';
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

/**
 * Portal-local source-file-count marker — the producer/consumer seam for the panel's real
 * file count. The facade PRODUCES one per node (`computeNodeMappedFiles`, the same
 * exclusion-aware, child-carve-out-aware expansion the source fingerprint uses);
 * `buildPortalNodes` in the pipeline CONSUMES it to fill `PortalNode.sourceFileCount`.
 */
export interface SourceFileCountMarkerInput {
  nodePath: string;
  sourceFileCount: number;
}

export interface HubEntry {
  path: string;
  count: number;
}

/** One member (a single pair) inside a `WorklistGroup` — the per-row detail the group's shared why/fix cannot carry. */
export interface WorklistMember {
  /** Subject component (nodePath). */
  node?: string;
  /** Subject file (nodeless `file:` unit) — exactly one of `node`/`file` is set. */
  file?: string;
  /** Per-line annotation for code-only groups (unverified). */
  aspectId?: string;
  /** Present ONLY when `group.divergentWhy`. */
  why?: string;
  /** Present ONLY when `group.divergentNext`. */
  next?: string;
  /** `messageData.what.split('\n').slice(1)` — tail only; present ONLY for FULL_WHAT codes. */
  whatLines?: string[];
  /**
   * The member's own distinguishing text — carried when NEITHER the subject (`node`/`file`)
   * NOR `aspectId` already tells this member apart from its siblings, mirroring the terminal's
   * own fallback (`renderRepoLevelGroup`'s per-member `what`; `renderGroup`'s member-bullet
   * `aspectId`-or-first-line fallback). Two disjoint cases, never both:
   *   - A REPO-LEVEL member (`node` and `file` both absent — a stale committed digest, an
   *     unreadable lock): the FULL `messageData.what`, every line. For a repo-level finding
   *     that text IS the entire content — nothing is dropped, not even line 0.
   *   - A subject-bearing member with no `aspectId` to annotate it with (neither the group nor
   *     the member itself carries one — a broken mapping entry, a missing log entry): the
   *     FIRST line of `messageData.what` only, enough to tell two same-code members apart.
   * Differs from `whatLines` in both shape and trigger: `whatLines` is the TAIL (every line
   * AFTER the first) of a FULL_WHAT code's `what`, carrying the reviewer's detailed reason
   * alongside a subject that already identifies the member; `what` is a STAND-IN identifier for
   * a member no other field identifies. The two never both populate on the same member — a
   * FULL_WHAT code never sets `what`, and this field is never set once `aspectId` is.
   */
  what?: string;
}

/**
 * One severity-homogeneous, code-homogeneous group of issues — the portal's mirror of the
 * CLI's `IssueGroup` (via `groupIssues`), split by severity BEFORE grouping so a group never
 * mixes errors and warnings under one badge.
 */
export interface WorklistGroup {
  /** Badge state keys off THIS (never the display label `rule`). */
  code: string;
  /** Display label (`getIssueLabel`). */
  rule: string;
  /** Rulebook deep-link target; absent for code-only groups (no link). */
  aspectId?: string;
  severity: 'error' | 'warning';
  pairCount: number;
  nodeCount: number;
  fileCount: number;
  /** `sharedWhy`. */
  why: string;
  /** `sharedNext`. */
  fix: string;
  divergentWhy: boolean;
  divergentNext: boolean;
  perMemberReason: boolean;
  members: WorklistMember[];
}

/**
 * The coverage block the CLI renders OUTSIDE groups (`renderUnmappedBlock`). Without this,
 * excluding coverage codes from grouping would silently drop them from the worklist — the
 * exact "All clear on a red build" honesty regression the portal exists to prevent.
 */
export interface WorklistCoverageBlock {
  /** `'unmapped-files' | 'uncovered-advisory'`. */
  code: string;
  severity: 'error' | 'warning';
  files: string[];
  why: string;
  fix: string;
}

/**
 * One file satisfied by the type-level lattice (matched a classifying type, no node maps it),
 * WHOSE CASCADE RAN — see `PortalTypeCoveredUncomputableFile` below for the disjoint third case
 * where it did not. `enforced` is true when at least one non-draft rule from the matched type's
 * cascade actually applies to this file (a real expected pair exists against it) — false means
 * the file is only NOMINALLY covered: its cascade ran and found nothing that checks it. Every
 * COMPUTABLE type-covered file appears here exactly once, sorted by path, whichever way it
 * goes — a file counted under `PortalResidue.typeCoveredUncomputable` never also appears here,
 * since "resolution ran and found nothing" and "resolution never ran" are mutually exclusive.
 */
export interface PortalTypeCoveredFile {
  path: string;
  type: string;
  enforced: boolean;
  /**
   * ABSENT iff `enforced === false` (zero pairs — `worstPairState`'s empty-seed would
   * fabricate green; the unenforced listing keeps its no-rule badge untouched instead of
   * reading a fake verified/unverified). When `enforced` is true: worst-state-wins over the
   * file's nodeless pairs — refused > unverified > warning > verified — reusing
   * `worstPairState` on a guaranteed-non-empty list, with each pair read through
   * `displayPairState` first so an advisory refusal still renders as `warning`, never a
   * blocking `refused`. This REPLACES the old `unverified: boolean` field: a refused pair
   * is a valid lock entry, so the old boolean rendered a refusal indistinguishable from
   * verified — `pairState` names the real outcome instead.
   */
  pairState?: Exclude<PortalPairState, 'n/a'>;
  /**
   * Refusal reasons; rendered for BOTH `refused` and `warning` pairState — an advisory
   * refusal's reason must not be dropped just because it renders as a warning, not a block.
   * Absent when `pairState` is absent or carries no refusal (`verified`/`unverified`).
   */
  reasons?: string[];
}

/**
 * One type-covered file whose matched type's rules an aspect `implies` cycle stopped from ever
 * being resolved — disjoint from `PortalTypeCoveredFile` above (see its own doc): this file
 * contributes to NEITHER `enforced` NOR the zero-rule state, because its cascade never ran to
 * decide either. `why` is the SAME cycle sentence `yg check`, `yg context --file`, and `yg owner
 * --file` already print for the identical fact (via the facade's `describeCascadeCycle`) — never
 * restated, so the wording cannot drift between the four surfaces.
 */
export interface PortalTypeCoveredUncomputableFile {
  path: string;
  type: string;
  why: string;
}

/**
 * The honest "what is NOT being verified" ledger: nodes that own source but carry
 * no non-draft effective aspect, plus repo files mapped to no node AND not
 * otherwise spoken for. `uncoveredFiles` excludes a file satisfied by the type-level
 * lattice (it has its own verdict — listing it here too would call a checked file
 * unguarded) and a file under a `coverage.excluded` root (it is deliberately
 * skipped, not silently missed) — mirroring `PortalCounts.uncoveredFiles` exactly,
 * so the chip's number and this list's length can never disagree. Surfaced so the
 * absence of red can never read as full coverage.
 */
export interface PortalResidue {
  noRuleNodes: string[];
  uncoveredFiles: string[];
  /**
   * Every type-covered file, matched type + whether anything enforces it (see
   * `PortalTypeCoveredFile`). An ENFORCED entry is not itself a residue item — it has a real
   * verdict, counted in the coverage bar like any other pair — but it is listed here too so a
   * consumer can render "type-covered as <type>" for every one of them from a single list. An
   * UNENFORCED entry genuinely belongs to this ledger: matched by a type, checked by nothing,
   * the same state `yg check` names under "satisfy coverage with no enforcement" and lists by
   * name — this is the field that lets the portal do the same, instead of folding that file
   * into a bare count next to the files that ARE checked.
   */
  typeCovered: PortalTypeCoveredFile[];
  /**
   * Every type-covered file whose matched type's rules an aspect `implies` cycle stopped from
   * ever being resolved (see `PortalTypeCoveredUncomputableFile`) — disjoint from `typeCovered`
   * above: a file appears in exactly one of the two lists, never both. Mirrors
   * `PortalCounts.typeCoveredUncomputable`'s count exactly. This is the state the honest answer
   * is "unknown," not "no rule applies" — rendered with the cycle named, the same way `yg
   * check`, `yg context --file`, and `yg owner --file` already do, rather than folded into
   * `typeCovered` with `enforced: false`, which would repeat the exact substitution ("we could
   * not determine what checks this file" read back as "nothing checks this file") this field
   * exists to rule out.
   */
  typeCoveredUncomputable: PortalTypeCoveredUncomputableFile[];
  /**
   * Files under a `coverage.excluded` root — deliberately skipped, not silently missed.
   * Mirrors `PortalCounts.excludedFiles`'s count exactly. Not a gap (nothing here needs
   * attention), but named here so a deliberately-excluded file has somewhere to be found by
   * name instead of only ever being a number.
   */
  excludedFiles: string[];
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
  /**
   * true ⇔ the universe was widened with at least one type-covered file (mirrors `yg
   * structure`'s own `hasTypeCovered` flag exactly, same widening, same trigger). The frontend
   * reads this to say "component or type-covered file" instead of "component" — this command's
   * own jargon-free-language rule — so a type-covered file's contribution to `nodeCount` /
   * `tunnels` / `reachMean` is never silently misnamed once it joins the universe. False (the
   * default) renders byte-identical to today's node-only wording.
   */
  hasTypeCovered: boolean;
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
  /**
   * Coverage-only issues (`unmapped-files` / `uncovered-advisory`) — rendered OUTSIDE
   * `worklist`, mirroring the CLI's `renderUnmappedBlock` placement. Excluding these codes
   * from grouping must never silently drop them from "needs attention": every consumer that
   * counts or renders the worklist must fold this array in too.
   */
  worklistCoverage: WorklistCoverageBlock[];
  residue: PortalResidue;
}
