// Drill case for portal/worklist-mirrors-groups — violates-unpinned-field.
//
// IssueGroup gains 'suppressedCount' with no WorklistGroup counterpart and no MIRROR /
// CLI_ONLY entry. Must be REFUSED (forward-exhaustiveness check) — this is the exact "CLI
// moves ahead, portal stands still" drift this rule exists to catch; the pre-fix version
// of this check could not see it at all (it only checked MIRROR-pinned fields).

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
  suppressedCount: number;
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
  divergentNext: boolean;
  perMemberReason: boolean;
  members: WorklistMember[];
}
