import { runCheck, type CheckResult } from '../core/check.js';

/**
 * VIOLATION — passes everything except the two rewrites that reach the returned
 * issue set without being bound to a name. Omitting either leaves the returned
 * list unrewritten while a caller that supplies it gets a rewritten one, so both
 * must be named here. This is what the give-up-when-no-return-names-an-identifier
 * step used to hide: with it in place neither derives, nothing is demanded, and
 * this call site reads as compliant.
 */
export function omitsReturnShapes(graph: string, files: string[]): CheckResult {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
    changeScope: 'whole-project',
  });
}
