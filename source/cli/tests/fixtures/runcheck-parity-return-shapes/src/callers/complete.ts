import { runCheck, type CheckResult } from '../core/check.js';

/**
 * COMPLIANT — passes every option the seam varies its returned issue set on,
 * including both rewrites that reach that set without ever being bound to a
 * name. Must stay silent.
 */
export function complete(graph: string, files: string[]): CheckResult {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
    scopeInProperty: 'in-scope',
    scopeInReturn: 'in-scope',
    changeScope: 'whole-project',
  });
}
