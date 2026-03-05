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
  artifacts: Record<string, ArtifactConfig>;
  quality?: QualityConfig;
}

export interface ArtifactConfig {
  required: 'always' | 'never' | { when: string };
  description: string;
  /** When true, include this artifact when building dependency context for structural relations */
  included_in_relations?: boolean;
}

export interface QualityConfig {
  min_artifact_length: number;
  max_direct_relations: number;
  context_budget: { warning: number; error: number };
}

// ============================================================
// Node
// ============================================================

export type RelationType = 'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens';

export interface NodeAspectEntry {
  aspect: string;
  exceptions?: string[];
  anchors?: string[];
}

export interface NodeMeta {
  name: string;
  type: string;
  aspects?: NodeAspectEntry[];
  blackbox?: boolean;
  relations?: Relation[];
  mapping?: NodeMapping;
}

export interface Relation {
  target: string;
  type: RelationType;
  consumes?: string[];
  failure?: string;
  /** For event relations (emits, listens): display name of the event, e.g. OrderPlaced */
  event_name?: string;
}

export interface NodeMapping {
  /** List of paths (files or directories). Type is auto-detected at runtime. */
  paths: string[];
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

export type AspectStability = 'schema' | 'protocol' | 'implementation';

export interface AspectDef {
  name: string;
  id: string;
  description?: string;
  /** Ids of aspects to include automatically (composition) */
  implies?: string[];
  /** How stable this aspect's claims are expected to be.
   *  schema = enforced by data model, changes require migration (most stable).
   *  protocol = contractual pattern, breaking causes visible failures.
   *  implementation = specific mechanism, subject to optimization (least stable). */
  stability?: AspectStability;
  artifacts: Artifact[];
}

// ============================================================
// Flow
// ============================================================

export interface FlowDef {
  /** Directory name under flows/, e.g. "checkout-flow" */
  path: string;
  name: string;
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
// Journal
// ============================================================

export interface JournalEntry {
  at: string;
  target?: string;
  note: string;
}

// ============================================================
// Graph (top-level)
// ============================================================

export interface Graph {
  config: YggConfig;
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
