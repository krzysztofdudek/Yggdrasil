import { runCheck } from '../core/check.js';

/**
 * Passes every option the derivation knows about. A parity-only rule sees
 * nothing wrong here — the refusal must come from the unclassified member on
 * the seam this call reaches.
 */
export function complete(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
    changeScope: 'whole-project',
  });
}
