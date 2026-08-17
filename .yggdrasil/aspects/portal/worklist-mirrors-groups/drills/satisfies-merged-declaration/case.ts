// Drill case for portal/worklist-mirrors-groups — satisfies-merged-declaration.
//
// IssueGroup is declared as TWO separate `interface IssueGroup { ... }` blocks in this
// file — legal TypeScript declaration merging; the compiler unions their members into one
// logical type. Every field is genuinely present (split across the two blocks) and
// genuinely mirrored to WorklistGroup. Must be SATISFIED: `findInterface` unions members
// across every same-named declaration, so reading a merged declaration correctly produces
// zero violations here — not the 3 spurious dead-pin refusals that reading only the FIRST
// block and treating every field declared solely in the second block as absent would
// produce.

export interface IssueGroup {
  code: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  label: string;
  pairCount: number;
  nodeCount: number;
  fileCount: number;
}

export interface IssueGroup {
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
