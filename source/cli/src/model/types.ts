// ============================================================
// Config
// ============================================================

export interface NodeTypeConfig {
  description: string;
  required_aspects?: string[];
}

export interface YggConfig {
  version?: string;
  name: string;
  node_types: Record<string, NodeTypeConfig>;
  quality?: QualityConfig;
}

// ============================================================
// Architecture
// ============================================================

export interface ArchitectureNodeType {
  description: string;
  aspects?: string[];
  integration_aspects?: string[];
  parents?: string[];
  relations?: Partial<Record<RelationType, string[]>>;
}

export interface ArchitectureDef {
  node_types: Record<string, ArchitectureNodeType>;
}

export interface ArtifactConfig {
  required: 'always' | 'never' | { when: string };
  description: string;
  /** When true, include this artifact when building dependency context for structural relations */
  included_in_relations?: boolean;
}

/** The three standard artifacts — hardcoded, not configurable. */
export const STANDARD_ARTIFACTS: Record<string, ArtifactConfig> = {
  'responsibility.md': {
    required: 'always',
    description: 'What this node is responsible for, and what it is not',
    included_in_relations: true,
  },
  'interface.md': {
    required: { when: 'has_incoming_relations' },
    description: 'Public API — methods, parameters, return types, contracts, failure modes',
    included_in_relations: true,
  },
  'internals.md': {
    required: 'never',
    description: 'How the node works and why — algorithms, business rules, design decisions',
    included_in_relations: false,
  },
};

export interface QualityConfig {
  min_artifact_length: number;
  max_direct_relations: number;
  max_mapping_source_files?: number;
  context_budget: { warning: number; error: number; own_warning?: number };
}

// ============================================================
// Node
// ============================================================

export type RelationType = 'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens';

/** Typed anchor realization — currently supports regex. Future: ast, claim. */
export interface AnchorRealization {
  regex?: string;
  [key: string]: unknown; // Forward compatibility for v5 types (ast, claim)
}

// ============================================================
// Mapping Groups
// ============================================================

export interface MappingGroupAnchor {
  regex: string;
  rationale: string;
}

export interface MappingGroupAspect {
  aspect: string;
  anchors: Record<string, MappingGroupAnchor>;
}

export interface MappingGroup {
  paths: string[];
  aspects?: MappingGroupAspect[];
}

export interface LegacyNodeAspectEntry {
  aspect: string;
  exceptions?: string[];
  /** Anchor realizations — maps anchor ID to typed realization object */
  anchors?: Record<string, AnchorRealization>;
}

export interface NodeMeta {
  name: string;
  type: string;
  description?: string;
  aspects?: string[];
  integration_aspects?: string[];
  blackbox?: boolean;
  relations?: Relation[];
  mapping?: MappingGroup[];
}

export interface Relation {
  target: string;
  type: RelationType;
  consumes?: string[];
  failure?: string;
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
  /** All artifact files in the node's directory */
  artifacts: Artifact[];
  /** Child nodes (subdirectories with yg-node.yaml) */
  children: GraphNode[];
  /** Parent node (null for top-level nodes) */
  parent: GraphNode | null;
}

export interface Artifact {
  /** Filename, e.g. "description.md" */
  filename: string;
  /** Full text content of the file */
  content: string;
}

// ============================================================
// Aspect
// ============================================================

export interface AspectDef {
  name: string;
  id: string;
  description?: string;
  /** Ids of aspects to include automatically (composition) */
  implies?: string[];
  /** Abstract proof-point IDs that nodes carrying this aspect must realize.
   *  Always present (parser defaults to []). E039 fires when empty. */
  anchors: string[];
  artifacts: Artifact[];
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
  artifacts: Artifact[];
}

// ============================================================
// Schema (graph layer reference, lives in schemas/)
// ============================================================

export interface SchemaDef {
  /** Inferred from filename: 'node' | 'aspect' | 'flow' */
  schemaType: string;
}

// ============================================================
// Graph (top-level)
// ============================================================

export interface Graph {
  config: YggConfig;
  architecture: ArchitectureDef;
  /** Present when yg-architecture.yaml could not be parsed */
  architectureError?: string;
  /** Present when yg-config.yaml could not be parsed and loader used fallback config */
  configError?: string;
  /** Parse errors for yg-node.yaml files (path -> message); reported as E001 */
  nodeParseErrors?: Array<{ nodePath: string; message: string }>;
  /** All nodes indexed by their path (e.g. "orders/order-service") */
  nodes: Map<string, GraphNode>;
  aspects: AspectDef[];
  flows: FlowDef[];
  schemas: SchemaDef[];
  /** Absolute path to the .yggdrasil/ directory */
  rootPath: string;
}

// ============================================================
// Context Package
// ============================================================

export type ContextSectionKey =
  | 'Global'
  | 'Hierarchy'
  | 'OwnArtifacts'
  | 'Aspects'
  | 'Relational';

export interface ContextPackage {
  nodePath: string;
  nodeName: string;
  layers: ContextLayer[];
  sections: ContextSection[];
  mapping: string[] | null;
  tokenCount: number;
}

export interface ContextLayer {
  type: 'global' | 'hierarchy' | 'own' | 'relational' | 'aspects' | 'flows';
  label: string;
  content: string;
  source?: string;
  /** Optional attrs for formatters (e.g. target, type for dependency) */
  attrs?: Record<string, string>;
}

export interface ContextSection {
  key: ContextSectionKey;
  layers: ContextLayer[];
}

// ============================================================
// Context Map (v2 structured output)
// ============================================================

export interface RequiredAspectRef {
  id: string;
  source: string;
}

export interface FlowRef {
  id: string;
  aspects?: string[];
}

export interface GlossaryAspectEntry {
  name: string;
  description?: string;
  implies?: string[];
  files: string[];
}

export interface GlossaryFlowEntry {
  name: string;
  description?: string;
  participants: string[];
  aspects?: string[];
  files: string[];
}

export interface Glossary {
  aspects: Record<string, GlossaryAspectEntry>;
  flows: Record<string, GlossaryFlowEntry>;
}

export interface AncestorRef {
  path: string;
  name: string;
  type: string;
  description?: string;
  aspects: string[];
  files?: string[];
}

export interface DependencyRef {
  path: string;
  name: string;
  type: string;
  description?: string;
  relation: string;
  consumes?: string[];
  failure?: string;
  'event-name'?: string;
  aspects: string[];
  hierarchy: AncestorRef[];
  files?: string[];
}

export interface BudgetBreakdown {
  own: number;
  hierarchy: number;
  aspects: number;
  flows: number;
  dependencies: number;
  total: number;
}

export interface ContextMapOutput {
  meta: { tokenCount: number; budgetStatus: 'ok' | 'warning' | 'severe'; breakdown: BudgetBreakdown };
  project: string;
  node: {
    path: string;
    name: string;
    type: string;
    description?: string;
    mappings: string[];
    required_aspects: RequiredAspectRef[];
    integration_aspects?: RequiredAspectRef[];
    flows: FlowRef[];
    files: string[];
  };
  hierarchy: AncestorRef[];
  dependencies: DependencyRef[];
  glossary: Glossary;
}

// ============================================================
// Dependency Resolution
// ============================================================

export interface Stage {
  stage: number;
  parallel: boolean;
  nodes: string[];
}

// ============================================================
// Validation
// ============================================================

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code?: string;
  rule: string;
  message: string;
  nodePath?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  nodesScanned: number;
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
  /** Reason provided with --acknowledge, stored for audit trail */
  acknowledgeReason?: string;
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
  action: 'approved' | 'acknowledged' | 'no-change' | 'initial' | 'refused';
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
  /** Was --acknowledge used when refused? (distinct blackbox message) */
  acknowledgeAttempted?: boolean;
  /** Is the node a blackbox? (for cascade acknowledge success message) */
  isBlackbox?: boolean;
  /** GC'd orphaned drift state paths */
  gcPaths?: string[];
}

/** Map: node-path → DriftNodeState. Legacy string format no longer supported. */
export type DriftState = Record<string, DriftNodeState>;

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

// ============================================================
// Owner (formerly Which)
// ============================================================

export interface OwnerResult {
  file: string;
  nodePath: string | null;
  mappingPath?: string;
  /** When false, file has no direct mapping; coverage comes from ancestor directory */
  direct?: boolean;
}
