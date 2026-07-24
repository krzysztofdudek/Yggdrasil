import { runCheck } from '../core/check.js';

/**
 * VIOLATION — no options argument at all, so EVERY issue-gating option is
 * missing. The trailing comment gives the argument list three named children,
 * so a matcher that counts them positionally believes an options argument is
 * present and never reaches the "no options argument" branch.
 */
export function noOptions(graph: string, files: string[]): string[] {
  return runCheck(graph, files /* no options at all */);
}
