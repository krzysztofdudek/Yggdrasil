// ============================================================
// Config
// ============================================================

export interface YggConfig {
  name: string;
  stack: Record<string, string>;
  standards: string;
  tags: string[];
  node_types: string[];
  artifacts: Record<string, ArtifactConfig>;
  knowledge_categories: KnowledgeCategory[];
  quality?: QualityConfig;
}

export interface ArtifactConfig {
  required: 'always' | 'never' | { when: string };
  description: string;
  /** When true, include this artifact when building dependency context for structural relations */
  structural_context?: boolean;
}

export interface KnowledgeCategory {
  name: string;
  description: string;
}

export interface QualityConfig {
  min_artifact_length: number;
  max_direct_relations: number;
  context_budget: { warning: number; error: number };
  knowledge_staleness_days: number;
}

// ============================================================
// Node
// ============================================================

export type RelationType = 'uses' | 'calls' | 'extends' | 'implements' | 'emits' | 'listens';

export interface NodeMeta {
  name: string;
  type: string;
  tags?: string[];
  blackbox?: boolean;
  relations?: Relation[];
  knowledge?: string[];
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
  /** Parsed node.yaml content */
  meta: NodeMeta;
  /** All artifact files in the node's directory */
  artifacts: Artifact[];
  /** Child nodes (subdirectories with node.yaml) */
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
  tag: string;
  artifacts: Artifact[];
}

// ============================================================
// Flow
// ============================================================

export interface FlowDef {
  name: string;
  nodes: string[];
  knowledge?: string[];
  artifacts: Artifact[];
}

// ============================================================
// Knowledge
// ============================================================

export interface KnowledgeItem {
  name: string;
  scope: 'global' | { tags: string[] } | { nodes: string[] };
  category: string;
  path: string;
  artifacts: Artifact[];
}

// ============================================================
// Schema (graph layer reference, lives in templates/)
// ============================================================

export interface SchemaDef {
  /** Inferred from filename: 'node' | 'aspect' | 'flow' | 'knowledge' */
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
  /** Present when config.yaml could not be parsed and loader used fallback config */
  configError?: string;
  /** Parse errors for node.yaml files (path -> message); reported as E001 */
  nodeParseErrors?: Array<{ nodePath: string; message: string }>;
  /** All nodes indexed by their path (e.g. "orders/order-service") */
  nodes: Map<string, GraphNode>;
  aspects: AspectDef[];
  flows: FlowDef[];
  knowledge: KnowledgeItem[];
  schemas: SchemaDef[];
  /** Absolute path to the .yggdrasil/ directory */
  rootPath: string;
}

// ============================================================
// Context Package
// ============================================================

export type ContextSectionKey =
  | 'Global'
  | 'Knowledge'
  | 'Hierarchy'
  | 'OwnArtifacts'
  | 'Dependencies'
  | 'Aspects'
  | 'Flows';

export interface ContextPackage {
  nodePath: string;
  nodeName: string;
  layers: ContextLayer[];
  sections: ContextSection[];
  mapping: string[] | null;
  tokenCount: number;
}

export interface ContextLayer {
  type: 'global' | 'knowledge' | 'hierarchy' | 'own' | 'relational' | 'aspects' | 'flows';
  label: string;
  content: string;
  source?: string;
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

export type DriftStatus = 'ok' | 'drift' | 'missing' | 'unmaterialized';

export interface DriftEntry {
  nodePath: string;
  mappingPaths: string[];
  status: DriftStatus;
  details?: string;
}

export interface DriftNodeState {
  hash: string;
  files?: Record<string, string>;
}

/** Map: node-path → hash (legacy) or DriftNodeState (extended with per-file hashes) */
export type DriftState = Record<string, string | DriftNodeState>;

export interface DriftReport {
  entries: DriftEntry[];
  totalChecked: number;
  okCount: number;
  driftCount: number;
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
}
