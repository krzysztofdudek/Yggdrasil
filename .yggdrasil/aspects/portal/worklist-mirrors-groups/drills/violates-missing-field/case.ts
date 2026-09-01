// Drill case for portal/worklist-mirrors-groups — violates-missing-field.
//
// Same as satisfies-mirror/case.ts, EXCEPT WorklistGroup is missing `divergentNext`
// (the mirror of IssueGroup.divergentNext). This case must be REFUSED, naming
// 'IssueGroup.divergentNext has no WorklistGroup.divergentNext counterpart'.

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

export interface WorklistGroup {
  code: string;
  rule: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  pairCount: number;
  nodeCount: number;
  fileCount: number;
  why: string;
  fix: string;
  divergentWhy: boolean;
  // divergentNext dropped — this is the drifted field this drill case must catch.
  perMemberReason: boolean;
  members: WorklistMember[];
}
