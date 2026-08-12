import { runCheck } from '../core/check.js';

/**
 * COMPLIANT — the injected clock is supplied as an object METHOD, which is
 * type-correct against `nowUtc?: () => Date`. A matcher that reads only `pair`
 * and `shorthand_property_identifier` entries sees no key here and refuses code
 * that provably passes the option.
 */
export function methodShorthand(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc() {
      return new Date();
    },
    rulesArtifacts: ['agents-md'],
    scopeFilter: 'in-scope',
    changeScope: 'whole-project',
  });
}
