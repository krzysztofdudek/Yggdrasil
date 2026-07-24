import { runCheck } from '../core/check.js';

/**
 * UNPROVABLE — the injected clock is supplied under a COMPUTED key. A computed
 * key cannot be read statically, so the rule must bail on the whole object
 * literal (as it does for a spread) rather than treat the key as absent: the
 * option is provably neither present nor missing here.
 */
export function computedKey(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    ['nowUtc']: () => new Date(),
    rulesArtifacts: ['agents-md'],
  });
}
