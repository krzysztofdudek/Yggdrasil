// ============================================================
// LLM Verification Results (shared by drift and LLM subsystems)
// ============================================================

/** Cached LLM aspect verification result */
export interface AspectVerificationResult {
  satisfied: boolean;
  reason: string;
}

// ============================================================
// Drift
// ============================================================

/** Category of a drifted file — source (mapping) or graph (.yggdrasil/) */
export type DriftCategory = 'source' | 'graph';

/** Which layer of the context package brought this file into tracking */
export type TrackedFileLayer = 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source';

/** Per-file drift detail */
export interface DriftFileChange {
  filePath: string;
  category: DriftCategory;
}

export type NodeLifecycleState = 'ok' | 'missing' | 'unapproved';

export interface DriftNodeState {
  hash: string;
  files: Record<string, string>;  // path → sha256 hex — now required, not optional
  mtimes?: Record<string, number>; // path → mtime in ms — for mtime-based drift optimization
}

/** Upstream change with type annotation for CLI messages */
export interface AnnotatedChange {
  filePath: string;
  /** Human-readable annotation, e.g. "aspect content", "dependency metadata", "flow description", "parent metadata" */
  annotation: string;
}

/** Result of approveNode() — what happened and why */
export interface ApproveResult {
  action: 'approved' | 'initial' | 'refused' | 'no-change';
  previousHash?: string;
  currentHash: string;
  refuseReason?: string;
  aspectViolations?: Array<{ aspectId: string; reason: string }>;
  changedSource?: string[];
  changedUpstream?: AnnotatedChange[];
  blackboxBlocked?: boolean;
  antiLaunderingBlocked?: boolean;
  conflictingFiles?: Array<{ file: string; trackedBy: string }>;
  isBlackbox?: boolean;
  gcPaths?: string[];
}

/** Map: node-path → DriftNodeState. */
export type DriftState = Record<string, DriftNodeState>;

/** Append-only audit log entry — written by approve, never read by CLI */
export interface AuditEntry {
  ts: string;
  node: string;
  action: 'approved' | 'initial';
  prev: string | null;
  hash: string;
  reason: string | null;
  files: string[];
}

