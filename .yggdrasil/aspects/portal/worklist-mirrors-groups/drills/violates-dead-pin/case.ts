// Drill case for portal/worklist-mirrors-groups — violates-dead-pin.
//
// IssueGroup no longer declares 'perMemberReason' (removed outright), but MIRROR still
// pins IssueGroup.perMemberReason -> WorklistGroup.perMemberReason. Must be REFUSED as a
// DEAD pin (pin-liveness check) — MIRROR is claiming coverage for a field that is no
// longer there. WorklistGroup itself is otherwise unaffected (its own perMemberReason
// field is still declared, just now uncovered by a live pin).

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
  divergentNext: boolean;
  divergentWhy: boolean;
  members: CheckIssue[];
  // perMemberReason removed — MIRROR still pins it below; this is the dead-pin case.
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
