// Drill case for portal/worklist-mirrors-groups — satisfies-mirror.
//
// Copies of the CURRENT IssueGroup (cli/group-issues.ts) and WorklistGroup
// (portal/contract.ts) interfaces, in sync with the MIRROR pinned in check.mjs.
// This case must PASS: every IssueGroup field has its named WorklistGroup
// counterpart. Referenced-but-not-declared types (CheckIssue, WorklistMember)
// are fine here — this aspect only parses interface shapes, it never type-checks.

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
  divergentNext: boolean;
  perMemberReason: boolean;
  members: WorklistMember[];
}
