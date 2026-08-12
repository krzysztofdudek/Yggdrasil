import { runCheck } from '../core/check.js';

/**
 * VIOLATION — passes the injected clock but not the injected artifacts
 * snapshot, so this surface silently reports one fewer issue than a caller
 * that passes both. This is the exact defect the rule exists to catch, and it
 * is the fixture's negative-direction proof: with the rule's matcher removed
 * or blinded, this call site goes silent.
 */
export function deficient(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    scopeFilter: 'in-scope',
    changeScope: 'whole-project',
  });
}
