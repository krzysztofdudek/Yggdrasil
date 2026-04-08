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
  node_types?: Record<string, NodeTypeConfig>;
  quality?: QualityConfig;
  llm?: LlmConfig;
  parallel?: number;
  debug?: boolean;
}

// ============================================================
// Architecture
// ============================================================

export interface ArchitectureNodeType {
  description: string;
  aspects?: string[];
  parents?: string[];
  relations?: Partial<Record<RelationType, string[]>>;
  /** Quality evaluation profile for this node type — tells the reviewer how to assess artifacts */
  quality_profile?: string;
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

/** Port on a target node — consumers must satisfy port's aspects */
export interface PortDef {
  description: string;
  aspects: string[];
}

/** LLM configuration — merged from yg-config.yaml + yg-secrets.yaml */
export interface LlmConfig {
  provider: 'ollama' | 'claude-code';
  model: string;
  endpoint?: string;
  api_key?: string;
  temperature: number;
  consensus: number;
  max_tokens: number | 'auto';
  /** Whether to run aspect verification (E055) during approve. Default: true. */
  verify_aspects: boolean;
  /** Whether to run artifact review (E056) during approve. Default: false. */
  verify_artifacts: boolean;
  /** Ollama model_info key for context length (e.g. "qwen35.context_length"). Auto-detected if omitted. */
  context_length_field?: string;
}

export interface NodeMeta {
  name: string;
  type: string;
  description?: string;
  aspects?: string[];
  ports?: Record<string, PortDef>;
  blackbox?: boolean;
  relations?: Relation[];
  /** Flat list of file/directory paths relative to repo root */
  mapping?: string[];
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
  implies?: string[];
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
// Dependency Resolution
// ============================================================

export interface Stage {
  stage: number;
  parallel: boolean;
  nodes: string[];
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
