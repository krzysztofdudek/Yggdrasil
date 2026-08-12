import { runCheck } from '../core/check.js';

/**
 * VIOLATION — passes every option the seam's own body can be read for (both
 * gating ones and the whole-list rewrite) and omits only the member the seam
 * declares but does not yet read. Nothing in runCheck can act on that member
 * today, which is exactly why a call site is easy to forget: by the time the
 * code that reads it lands, this surface would already be reporting a different
 * issue set from every other, with no error anywhere. The rule's hand-signed
 * ISSUE_TRANSFORM map is what demands it meanwhile, and this is that demand's
 * negative-direction proof — drop the entry and this call site goes silent.
 */
export function declaredOmitted(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
    scopeFilter: 'in-scope',
  });
}
