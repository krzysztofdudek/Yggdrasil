import { runCheck } from '../core/check.js';

/** COMPLIANT — passes both issue-gating options as plain properties. */
export function complete(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
  });
}
