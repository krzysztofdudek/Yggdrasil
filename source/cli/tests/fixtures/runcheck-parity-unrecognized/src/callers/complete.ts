import { runCheck } from '../core/check.js';

/**
 * Passes every option the derivation can see, and NOT the one the rule's
 * ISSUE_TRANSFORM map lists — because while that entry is unproven it demands
 * nothing, so there is nothing here to refuse. Any requirement dropped from the
 * rewrite matcher makes the seam's corresponding read derive, and this call site
 * is refused for the omission instead: that is what turns each requirement into
 * something a single deletion cannot pass unnoticed.
 */
export function complete(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
  });
}
