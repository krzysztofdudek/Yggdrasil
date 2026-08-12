import type { WhenPredicate } from './when.js';
import type { FileWhenPredicate } from './file-when.js';
import type { IssueMessage } from './validation.js';

export type {
  WhenPredicate,
  BooleanClause,
  AtomicClause,
  RelationClause,
  RelationMatch,
  DescendantsClause,
  NodeClause,
} from './when.js';
export type { FileWhenPredicate } from './file-when.js';

// ============================================================
// ReviewerConfig — named tier configurations
// ============================================================

export interface ReviewerConfig {
  /** Tier name used when an aspect doesn't declare one explicitly */
  default?: string;
  /** At least one entry required; key is the tier name */
  tiers: Record<string, LlmConfig>;
}

// ============================================================
// Config
// ============================================================

export interface CoverageConfig {
  /** Roots (POSIX, from repo root; "/" = whole repo) where an uncovered file is an error. */
  required: string[];
  /** Roots where an uncovered file is silent (no issue). */
  excluded: string[];
  /**
   * Opts the repo into type-level coverage enforcement (in addition to the
   * existing file-level coverage above). Read from the COMMITTED config
   * only — a gitignored secrets overlay can never change it, since the flag
   * changes what counts as covered/uncovered and must not vary per developer.
   * Default false (today's file-only coverage, unchanged).
   */
  typeLevel: boolean;
}

export interface YggConfig {
  version?: string;
  quality?: QualityConfig;
  /** Reviewer configuration — tiers + default. Optional in the type
   *  to preserve FALLBACK_CONFIG ergonomics; validator emits
   *  `config-reviewer-missing` when absent on a real project. */
  reviewer?: ReviewerConfig;
  parallel?: number;
  debug?: boolean;
  /** Controls what bare `yg check` does: false = read-only; 'deterministic' = free local fill; 'full' = full reviewer fill. */
  auto_approve?: 'deterministic' | 'full' | false;
  /**
   * Attention-layer switches. Absent ⇒ every signal at its default. `attention`
   * (default ON — absent `signals` OR absent `signals.attention` both mean ON)
   * toggles the advisory "structurally unusual" note in `yg context --file`; set
   * `signals: { attention: false }` to silence it. Never affects any verdict.
   */
  signals?: { attention?: boolean };
  /**
   * Committed-events opt-in. Absent ⇒ every LLM verification-fill event stays in
   * the LOCAL, gitignored sidecar (today's behavior). `committed_llm: true` opts
   * the repo into a COMMITTED, shared record of LLM-fill events
   * (`.yggdrasil/yg-events.llm.jsonl`, union-merged across branches, refusal
   * `reason` stripped for privacy); deterministic / drill / diag events always
   * stay local. Absent `events` OR absent `events.committed_llm` both mean OFF.
   * Never affects any verdict hash (recording it invalidates nothing).
   */
  events?: { committed_llm?: boolean };
  /** Coverage scope. Absent ⇒ DEFAULT_COVERAGE (whole repo required = today's behavior). */
  coverage?: CoverageConfig;
  /**
   * Progressive-mode settings. Absent ⇒ progressive mode is OFF and every run
   * behaves exactly as it always has. `reference` names the committed branch or
   * ref a run measures its change against (e.g. `origin/main`) — the point the
   * touched set is diffed from.
   *
   * COMMITTED-ONLY, like `coverage.typeLevel`: read from the committed
   * `yg-config.yaml` before the gitignored `yg-secrets.yaml` overlay is merged.
   * The reference decides how much of the graph a run answers for, so a local,
   * unshared file must never be able to move it.
   */
  progressive?: { reference?: string };
}

// ============================================================
// Architecture
// ============================================================

export interface ArchitectureNodeType {
  description: string;
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  /** Per-aspect explicit status override for aspects listed in `aspects` (channel 3) */
  aspectStatus?: Record<string, AspectStatus>;
  parents?: string[];
  relations?: Partial<Record<RelationType, string[]>>;
  /**
   * Default policy for relation types NOT listed in `relations`.
   * 'allow' (the default when undefined) ⇒ unlisted relation types may target
   * any node type. 'deny' ⇒ unlisted relation types target nothing (sink).
   * An explicit per-type list always overrides this for that relation type.
   */
  relationDefault?: 'allow' | 'deny';
  /**
   * Whether nodes of this type require a log entry per source-file change.
   * Undefined means caller should apply its own default (typically true).
   */
  log_required?: boolean;
  /**
   * Per-file classification predicate. Types without `when` are organizational
   * (parent-only — nodes of that type cannot carry a non-empty `mapping:`).
   */
  when?: FileWhenPredicate;
  /**
   * When set to 'strict', backward enforcement applies: any repo file matching
   * `when` must be in a node mapping of this type, and conversely a mapping
   * file must satisfy `when`.
   */
  enforce?: 'strict';
}

export interface ArchitectureDef {
  node_types: Record<string, ArchitectureNodeType>;
}

export interface QualityConfig {
  max_direct_relations: number;
}

// ============================================================
// Node
// ============================================================

export type RelationType = 'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens';

/** Port on a target node — consumers must satisfy port's aspects */
export interface PortDef {
  description: string;
  aspects: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  /** Per-aspect explicit status override for aspects listed in `aspects` (channel 6) */
  aspectStatus?: Record<string, AspectStatus>;
}

export type ReviewerProvider =
  // API
  | 'ollama' | 'openai' | 'anthropic' | 'google' | 'openai-compatible'
  // CLI
  | 'claude-code' | 'codex' | 'gemini-cli';

/** LLM configuration — merged from yg-config.yaml + yg-secrets.yaml */
export interface LlmConfig {
  provider: ReviewerProvider;
  model: string;
  endpoint?: string;
  api_key?: string;
  temperature: number;
  consensus: number;
  /** CLI providers: subprocess timeout in ms. Default: 120_000. */
  timeout?: number;
  /**
   * Optional per-tier cap on assembled reviewer-prompt length in characters.
   * Absent defaults to 50000. This is a GATE checked deterministically before the LLM
   * call — it never participates in verdict identity or hash computation (excluded
   * from canonicalTierJson like api_key and timeout).
   */
  max_prompt_chars?: number;
}

export interface NodeMeta {
  name: string;
  type: string;
  description?: string;
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  /** Per-aspect explicit status override for aspects listed in `aspects` (channel 1) */
  aspectStatus?: Record<string, AspectStatus>;
  ports?: Record<string, PortDef>;
  relations?: Relation[];
  /** Flat list of file/directory paths relative to repo root */
  mapping?: string[];
  /**
   * Optional per-node override of the built-in high-fan-out ceiling. A node that
   * is a DELIBERATE single-responsibility seam (a single auditable gateway or
   * orchestrator that concentrates coupling by design) may raise ITS OWN
   * direct-relation ceiling above the global default
   * (config.quality.max_direct_relations) by declaring both the number and a
   * human justification. The global default still governs every node without an
   * override, and a node still warns when it exceeds its OWN declared ceiling —
   * the allowance sanctions a specific, reviewed count, it never silences genuine
   * over-connection. CHECK PARAMETER ONLY — like status, it never folds into any
   * verdict hash (pair-hash builds from explicit inputs, never NodeMeta). Absent
   * or malformed → undefined (the strict global applies).
   */
  maxDirectRelations?: { limit: number; reason: string };
}

export interface Relation {
  target: string;
  type: RelationType;
  consumes?: string[];
  /** For event relations (emits, listens): display name of the event, e.g. OrderPlaced */
  event_name?: string;
}

export interface GraphNode {
  /** Path relative to model/, e.g. "orders/order-service" */
  path: string;
  /** Parsed yg-node.yaml content */
  meta: NodeMeta;
  /** Raw yg-node.yaml file content (for context assembly without disk access) */
  nodeYamlRaw?: string;
  /** Child nodes (subdirectories with yg-node.yaml) */
  children: GraphNode[];
  /** Parent node (null for top-level nodes) */
  parent: GraphNode | null;
}

export interface Artifact {
  /** Filename, e.g. "content.md" */
  filename: string;
  /** Full text content of the file */
  content: string;
}

// ============================================================
// AspectReviewerSpec — per-aspect reviewer choice + tier
// ============================================================

export interface AspectReviewerSpec {
  /**
   * Reviewer kind. Inferred at parse time from rule-file presence and always
   * populated on the in-memory model:
   *   - 'llm'           — ships content.md (LLM reviewer reads it)
   *   - 'deterministic' — ships check.mjs (local runner executes it)
   *   - 'aggregate'     — ships neither; a content-less, check-less bundle that
   *                       only `implies` other aspects. No own reviewer, no own
   *                       verdict — downstream verdict-expecting paths must
   *                       exclude it.
   */
  type: 'llm' | 'deterministic' | 'aggregate';
  /** Tier reference into ReviewerConfig.tiers; valid only when type === 'llm' */
  tier?: string;
}

// ============================================================
// AspectStatus — three-level enforcement
// ============================================================

export type AspectStatus = 'draft' | 'advisory' | 'enforced';

export const STATUS_ORDER: Readonly<Record<AspectStatus, number>> = {
  draft: 0,
  advisory: 1,
  enforced: 2,
};

export const ASPECT_STATUS_VALUES: readonly AspectStatus[] = ['draft', 'advisory', 'enforced'];

/** Propagation modifier on implies edges. */
export type StatusInherit = 'strictest' | 'own-default';

export const STATUS_INHERIT_VALUES: readonly StatusInherit[] = ['strictest', 'own-default'];

// ============================================================
// ErrsDirection — deterministic check error-direction label
// ============================================================

/**
 * The error-direction of a deterministic check — whether it can flag code the
 * rule does not actually forbid ('over', may produce false positives), only ever
 * fires on provable violations ('under', no false positives by design), or is
 * exact ('exact', neither over- nor under-approximates). Rendering/analysis metadata
 * only — declared exclusively on deterministic aspects and NEVER a verdict-hash
 * ingredient. Absent → undefined.
 */
export type ErrsDirection = 'over' | 'under' | 'exact';

export const ERRS_DIRECTION_VALUES: readonly ErrsDirection[] = ['over', 'under', 'exact'];

// ============================================================
// Aspect
// ============================================================

/** Review scope of an aspect: whole-node or per-file, with an optional file filter. */
export interface ScopeDef { per: 'node' | 'file'; files?: FileWhenPredicate }

export interface AspectDef {
  name: string;
  id: string;
  description?: string;
  /** Reviewer specification — type and optional tier reference */
  reviewer: AspectReviewerSpec;
  implies?: string[];
  /** Per-implies applicability filters for aspect ids listed in `implies` */
  impliesWhens?: Record<string, WhenPredicate>;
  /** Per-implies status propagation modifier for aspect ids listed in `implies`.
   *  Absent key → 'strictest' (default). */
  impliesStatusInherit?: Record<string, StatusInherit>;
  /** Global applicability filter for this aspect, applied on every channel */
  when?: WhenPredicate;
  artifacts: Artifact[];
  /** Supporting files for the LLM reviewer (lookup tables, catalogues, contracts). Permitted only when reviewer.type === 'llm'. */
  references?: Array<{ path: string; description?: string }>;
  /** Aspect-level default status. Absent → 'enforced'. Attach sites may override per the bump rule: bump up OK, downgrade is a validator error. */
  status?: AspectStatus;
  /**
   * Standing review-by date (bare ISO calendar date `YYYY-MM-DD`) — the
   * constitution's request to re-examine whether this rule still earns its place
   * by the given day. Valid on ANY aspect kind (llm / deterministic / aggregate)
   * and independent of `status`, because review cadence is about the rule's
   * continued relevance, not its reviewer kind or enforcement level. Parsed only
   * when present, and rejected (aspect-review-by-malformed) when present but not a
   * calendar-valid bare date. NEVER a verdict-hash ingredient — recording or
   * changing a review-by date invalidates no stored verdict. Absent → undefined.
   */
  reviewBy?: string;
  /**
   * Review scope: controls review granularity and the subject-file set.
   *   per: node (default) — one review over all subject files.
   *   per: file — one review per subject file.
   *   files: optional FileWhenPredicate filter; subject set = mapped files ∩ filter.
   * Absent → undefined (semantically equivalent to { per: 'node' }).
   * Forbidden on aggregate aspects (no rule source to scope).
   */
  scope?: ScopeDef;
  /**
   * Error-direction label of a deterministic check (over | under | exact).
   * Legal ONLY on deterministic aspects — declares whether the check may
   * over-approximate (false positives possible), under-approximate (no false
   * positives by design), or is exact. Rendering/analysis metadata only; NEVER
   * folded into any verdict hash. Absent → undefined.
   */
  errs?: ErrsDirection;
  /**
   * True when companion.mjs is present beside the aspect's rule sources.
   * Valid only when reviewer.type === 'llm'. Set by the loader when companion.mjs
   * is detected in the aspect directory.
   */
  hasCompanion?: boolean;
}

// ============================================================
// Flow
// ============================================================

export interface FlowDef {
  /** Directory name under flows/, e.g. "checkout-flow" */
  path: string;
  name: string;
  description?: string;
  nodes: string[];
  /** Optional aspect ids — aspects propagate to all participants */
  aspects?: string[];
  /** Per-aspect applicability filters for aspects listed in `aspects` */
  aspectWhens?: Record<string, WhenPredicate>;
  /** Per-aspect explicit status override for aspects listed in `aspects` (channel 5) */
  aspectStatus?: Record<string, AspectStatus>;
}

// ============================================================
// Graph (top-level)
// ============================================================

/**
 * Architecture file load error.
 *
 * Bare string keeps backward compatibility with legacy parse failures.
 * Structured form lets validators distinguish error codes — e.g.
 * `when-predicate-invalid` vs. generic `architecture-invalid`.
 */
export type ArchitectureLoadError =
  | { code: 'architecture-invalid'; messageData: IssueMessage }
  | { code: 'when-predicate-invalid'; messageData: IssueMessage };

export interface Graph {
  config: YggConfig;
  architecture: ArchitectureDef;
  /** Present when yg-architecture.yaml could not be parsed */
  architectureError?: ArchitectureLoadError;
  /** Present when yg-config.yaml could not be parsed and loader used fallback config */
  configError?: string;
  /** Structured form of configError — present when the config parse failure has what/why/next fields */
  configErrorMessage?: IssueMessage;
  /** Parse errors for yg-node.yaml files; reported as yaml-invalid */
  nodeParseErrors?: Array<{ nodePath: string; messageData: IssueMessage }>;
  /** Parse errors for yg-aspect.yaml files. Each carries the structured
   *  validator code for the validator to emit downstream. */
  aspectParseErrors?: Array<{
    aspectId: string;
    code: string;
    messageData: IssueMessage;
  }>;

  /** Structured error code carried alongside `configError`. Used by
   *  validator to suppress dependent checks (e.g., skip aspect-tier-unknown
   *  when the config is invalid). */
  configErrorCode?: string;
  /** All nodes indexed by their path (e.g. "orders/order-service") */
  nodes: Map<string, GraphNode>;
  aspects: AspectDef[];
  flows: FlowDef[];
  /** Absolute path to the .yggdrasil/ directory */
  rootPath: string;
}

// ============================================================
// Owner
// ============================================================

export interface OwnerResult {
  file: string;
  nodePath: string | null;
  mappingPath?: string;
  /** When false, file has no direct mapping; coverage comes from ancestor directory */
  direct?: boolean;
}
