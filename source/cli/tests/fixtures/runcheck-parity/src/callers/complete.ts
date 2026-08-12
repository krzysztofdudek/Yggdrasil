import { runCheck } from '../core/check.js';

/** COMPLIANT — passes every issue-affecting option (both gating ones and the
 *  whole-list rewrite) as plain properties. */
export function complete(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
    scopeFilter: 'in-scope',
  });
}
