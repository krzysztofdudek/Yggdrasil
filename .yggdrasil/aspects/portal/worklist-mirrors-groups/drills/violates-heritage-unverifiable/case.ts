// Drill case for portal/worklist-mirrors-groups — violates-heritage-unverifiable.
//
// WorklistGroup hoists pairCount/nodeCount/fileCount into a base interface
// (WorklistCounts) via `extends`, in the same file. The fields are still present and
// portal behaviour is unaffected, but this check reads only each interface's OWN
// property signatures — it cannot safely compare field sets while inherited members are
// invisible to it. Must be REFUSED with exactly ONE heritage diagnostic, never per-field
// "missing" claims for pairCount/nodeCount/fileCount (which would be misleading — those
// fields ARE present, just inherited).

export interface IssueGroup {
  code: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  label: string;
  pairCount: number;
  nodeCount: number;
  fileCount: number;
  sharedWhy: string;
  sharedNext: string;
  perMemberReason: boolean;
  divergentNext: boolean;
  divergentWhy: boolean;
  members: CheckIssue[];
}

interface WorklistCounts {
  pairCount: number;
  nodeCount: number;
  fileCount: number;
}

export interface WorklistGroup extends WorklistCounts {
  code: string;
  rule: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  why: string;
  fix: string;
  divergentWhy: boolean;
  divergentNext: boolean;
  perMemberReason: boolean;
  members: WorklistMember[];
}
