// ============================================================
// Config
// ============================================================

export interface YggConfig {
  version?: string;
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
}

export interface ArchitectureDef {
  node_types: Record<string, ArchitectureNodeType>;
}

export interface QualityConfig {
  max_direct_relations: number;
  max_mapping_source_files?: number;
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
  max_tokens: number | 'auto';
  /** Ollama model_info key for context length (e.g. "qwen35.context_length"). Auto-detected if omitted. */
  context_length_field?: string;
  /** CLI providers: subprocess timeout in ms. Default: 120_000. */
  timeout?: number;
}

export interface NodeMeta {
  name: string;
  type: string;
  description?: string;
  aspects?: string[];
  ports?: Record<string, PortDef>;
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
  /** Parse errors for yg-node.yaml files (path -> message); reported as yaml-invalid */
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
// Owner
// ============================================================

export interface OwnerResult {
  file: string;
  nodePath: string | null;
  mappingPath?: string;
  /** When false, file has no direct mapping; coverage comes from ancestor directory */
  direct?: boolean;
}
