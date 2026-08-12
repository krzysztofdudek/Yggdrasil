import { runCheck } from '../core/check.js';

/**
 * VIOLATION — identical to the deficient caller (no injected artifacts
 * snapshot), but with a block comment between the arguments. tree-sitter counts
 * a comment as a named child of the argument list, so a matcher that indexes
 * named children positionally resolves the options argument to the SECOND
 * argument, finds a non-object, and skips the call in silence. A comment must
 * never be able to disable this rule at a call site.
 */
export function commentEvasion(graph: string, files: string[]): string[] {
  return runCheck(graph, /* boundary-injected */ files, {
    nowUtc: () => new Date(),
    scopeFilter: 'in-scope',
  });
}
