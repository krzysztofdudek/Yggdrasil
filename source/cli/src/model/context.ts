// ============================================================
// Context Types
// ============================================================

export interface ContextLayer {
  type: 'global' | 'hierarchy' | 'relational' | 'aspects' | 'flows';
  label: string;
  content: string;
  source?: string;
  /** Optional attrs for formatters (e.g. target, type for dependency) */
  attrs?: Record<string, string>;
}
