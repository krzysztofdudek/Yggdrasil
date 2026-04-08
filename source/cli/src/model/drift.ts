// ============================================================
// LLM Verification Results (shared by drift and LLM subsystems)
// ============================================================

/** Cached LLM aspect verification result */
export interface AspectVerificationResult {
  satisfied: boolean;
  reason: string;
}

/** Cached LLM artifact review result */
export interface ArtifactReviewResult {
  current: boolean;
  reason: string;
}

// ============================================================
// Drift
// ============================================================

/** Category of a drifted file — source (mapping) or graph (.yggdrasil/) */
export type DriftCategory = 'source' | 'graph';

/** Which layer of the context package brought this file into tracking */
export type TrackedFileLayer = 'own' | 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source';

/** Per-file drift detail */
export interface DriftFileChange {
  filePath: string;
  category: DriftCategory;
}

export type DriftStatus = 'ok' | 'source-drift' | 'graph-drift' | 'full-drift' | 'missing' | 'unmaterialized';

export interface DriftEntry {
  nodePath: string;
  status: DriftStatus;
  /** Changed files with their category (source or graph) */
  changedFiles?: DriftFileChange[];
  details?: string;
}

export interface DriftNodeState {
  hash: string;
  files: Record<string, string>;  // path → sha256 hex — now required, not optional
  mtimes?: Record<string, number>; // path → mtime in ms — for mtime-based drift optimization
  /** Reason provided with --reviewed, stored for audit trail */
  reviewedReason?: string;
  /** Cached aspect verification results from last LLM-powered approve */
  aspectResults?: Record<string, AspectVerificationResult>;
  /** Cached artifact review results from last LLM-powered approve */
  artifactReview?: Record<string, ArtifactReviewResult>;
}

/** Upstream change with type annotation for CLI messages */
export interface AnnotatedChange {
  filePath: string;
  /** Human-readable annotation, e.g. "aspect content", "dependency interface", "flow description", "parent artifact" */
  annotation: string;
}

/** Result of approveNode() — what happened and why */
export interface ApproveResult {
  /** What approve decided */
  action: 'approved' | 'reviewed' | 'no-change' | 'initial' | 'refused';
  /** Previous hash (undefined for first approve) */
  previousHash?: string;
  /** Current hash after recording */
  currentHash: string;
  /** For refused: reason string */
  refuseReason?: string;
  /** For refused: the three axis states */
  axes?: {
    ownArtifacts: 'changed' | 'unchanged';
    source: 'changed' | 'unchanged';
    otherTracked: 'changed' | 'unchanged';
  };
  /** Changed file details for error messages */
  changedOwnArtifacts?: string[];
  changedSource?: string[];
  changedOther?: AnnotatedChange[];
  /** Unchanged file details for error messages (per CLI messages spec) */
  unchangedArtifactNames?: string[];
  unchangedSourceFiles?: string[];
  /** Was blackbox blocker triggered? */
  blackboxBlocked?: boolean;
  /** Was anti-laundering triggered? */
  antiLaunderingBlocked?: boolean;
  /** Conflicting files for anti-laundering message */
  conflictingFiles?: Array<{ file: string; trackedBy: string }>;
  /** Was --reviewed used when refused? (distinct blackbox message) */
  reviewedAttempted?: boolean;
  /** Is the node a blackbox? (for cascade reviewed success message) */
  isBlackbox?: boolean;
  /** GC'd orphaned drift state paths */
  gcPaths?: string[];
  /** LLM aspect verification results (E055) */
  aspectResults?: Record<string, AspectVerificationResult>;
  /** LLM artifact review results (E056) */
  artifactReviewResults?: Record<string, ArtifactReviewResult>;
  /** Why LLM verification was skipped, if it was */
  llmSkipped?: 'not-configured' | 'unavailable' | 'blackbox';
  /** E055 structured violations for programmatic consumption */
  e055Violations?: Array<{ aspect: string; reason: string }>;
  /** E056 structured violations for programmatic consumption */
  e056Violations?: Array<{ name: string; reason: string }>;
}

/** Map: node-path → DriftNodeState. Legacy string format no longer supported. */
export type DriftState = Record<string, DriftNodeState>;

/** Append-only audit log entry — written by approve, never read by CLI */
export interface AuditEntry {
  ts: string;
  node: string;
  action: 'approved' | 'reviewed' | 'no-change' | 'initial';
  prev: string | null;
  hash: string;
  reason: string | null;
  files: string[];
}

export interface DriftReport {
  entries: DriftEntry[];
  totalChecked: number;
  okCount: number;
  sourceDriftCount: number;
  graphDriftCount: number;
  fullDriftCount: number;
  missingCount: number;
  unmaterializedCount: number;
}
