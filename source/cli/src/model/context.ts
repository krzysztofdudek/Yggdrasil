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

/** Reference to a node aspect in context output */
export interface NodeAspectRef {
  id: string;
  /** Exceptions to this aspect for this node */
  exceptions?: string[];
}

export interface FlowRef {
  id: string;
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
    aspects: NodeAspectRef[];
    required_aspects: RequiredAspectRef[];
    integration_aspects?: RequiredAspectRef[];
    flows: FlowRef[];
    files: string[];
  };
  hierarchy: AncestorRef[];
  dependencies: DependencyRef[];
  glossary: Glossary;
}
