import { runCheck } from '../core/check.js';

/**
 * VIOLATION — passes both issue-GATING options but omits the ISSUE-TRANSFORM
 * one, so this surface returns the assembled list unrewritten while a caller
 * that passes it returns a rewritten one: the same silent divergence a missing
 * gate causes, in the shape a gating ternary cannot express. This is the
 * negative-direction proof for the whole-list-rewrite classification — with the
 * transform matcher removed or loosened, this call site goes silent.
 */
export function transformOmitted(graph: string, files: string[]): string[] {
  return runCheck(graph, files, {
    nowUtc: () => new Date(),
    rulesArtifacts: ['agents-md'],
  });
}
