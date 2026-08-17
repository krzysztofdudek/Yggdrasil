// ============================================================
// Validation
// ============================================================

export type IssueSeverity = 'error' | 'warning';

export interface IssueMessage {
  /** What happened — facts, one line or short block */
  what: string;
  /** Why it's a problem — context for the agent */
  why: string;
  /** Concrete command or instruction to resolve */
  next: string;
}

export interface ValidationIssue {
  severity: IssueSeverity;
  code?: string;
  rule: string;
  messageData: IssueMessage;
  nodePath?: string;
  /**
   * The aspect this issue concerns. Set by aspect-keyed checks that have no
   * `nodePath` of their own (e.g. `description-missing`'s aspect case), and
   * also directly on `CheckIssue`-typed pair-derived issues
   * (aspect-newly-active / aspect-violation-*), which set it from
   * `pair.aspectId`.
   */
  aspectId?: string;
  /**
   * A nodeless issue's own file identity, in the same `file:<repo-relative
   * POSIX path>` form as `model/lock.ts`'s `fileUnit`. Set by per-file checks
   * that have no node to key on (e.g. `ambiguous-node-type`,
   * `tracked-file-gitignored`, `type-strict-orphan`), and also directly on
   * `CheckIssue`-typed pair-derived issues, which set it from `pair.unitKey`
   * so a nodeless member's FILE can render even though `nodePath` is
   * undefined (same as a repo-level issue).
   */
  unitKey?: string;
  /**
   * The flow this issue concerns — a flow is not a node and has no
   * `nodePath`, so without this there is nothing to match a flow issue
   * against (e.g. `description-missing`'s flow case).
   */
  flowName?: string;
  /**
   * The concrete file-to-file edges an aggregate issue is about, rather than
   * one example named in the message — structured identity for an issue that
   * has no single subject file (e.g. `type-relation-forbidden`). For a
   * single-file aggregate like `strict-overlap-conflict`, each entry is a
   * self-referencing `{fromFile, toFile}` pair: one file, not a relationship
   * between two, is the subject there, so this shared shape is reused as-is
   * rather than adding a second aggregate-identity field.
   */
  relationEdges?: Array<{ fromFile: string; toFile: string }>;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  nodesScanned: number;
}
