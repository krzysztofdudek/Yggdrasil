/**
 * FileWhenPredicate — per-file predicate for node_type classification.
 *
 * Two atoms: `path` (glob against file path) and `content` (regex against file content).
 * Three operators: `all_of`, `any_of`, `not`.
 * Top-level single atom permitted (implicit single-clause predicate).
 *
 * Distinct from aspect-level `WhenPredicate` (which uses graph-shape atoms
 * relations/descendants/node). Same operator names, different atoms.
 */
export type FileWhenPredicate =
  | FileAtomicClause
  | FileBooleanClause;

export type FileAtomicClause = {
  /** Glob pattern matched against the file's repo-relative path. */
  path?: string;
  /** Regex pattern matched against the file content. */
  content?: string;
};

export type FileBooleanClause =
  | { all_of: FileWhenPredicate[] }
  | { any_of: FileWhenPredicate[] }
  | { not: FileWhenPredicate };

/**
 * PredicateTrace — execution trace of a FileWhenPredicate evaluation.
 *
 * Returned by evaluator alongside boolean result for rendering predicate
 * evaluation trees in error messages.
 */
export type PredicateTrace =
  | { kind: 'atom-path'; pattern: string; result: boolean; detail?: string }
  | { kind: 'atom-content'; pattern: string; result: boolean; detail?: string; truncated?: boolean }
  | { kind: 'all_of'; result: boolean; children: PredicateTrace[] }
  | { kind: 'any_of'; result: boolean; children: PredicateTrace[] }
  | { kind: 'not'; result: boolean; child: PredicateTrace }
  | { kind: 'exempt'; result: true; reason: string };

export type EvaluationResult = {
  result: boolean;
  trace: PredicateTrace;
  /**
   * Set to true when at least one file referenced by the predicate could not
   * be read (permissions, broken symlink, etc.). The validator uses this to
   * emit `file-unreadable` instead of `type-when-mismatch`. Unreadable files
   * are excluded from further validation.
   */
  unreadable?: boolean;
  /** OS error string (e.g. "EACCES (permission denied)") — present when `unreadable`. */
  unreadableReason?: string;
  /**
   * Why the file could not be evaluated, when `unreadable` is set:
   *   - 'read'      → the file's bytes could not be read at all (EACCES, vanished, …).
   *   - 'too-large' → the file is readable but exceeds the content-scan size limit,
   *                   so a `content` filter could not be applied to it.
   * Lets callers phrase an accurate diagnostic (a too-large file is readable, so
   * "could not read" would be misleading). Defaults to 'read' when absent.
   */
  unreadableKind?: 'read' | 'too-large';
};
