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
