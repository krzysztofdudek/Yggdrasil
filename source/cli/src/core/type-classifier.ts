import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type { PredicateTrace } from '../model/file-when.js';
import { evaluateFileWhen, type EvalContext } from './file-when-evaluator.js';
import type { FileContentCache } from '../io/file-content-cache.js';

export type TypeMatch = {
  typeId: string;
  trace: PredicateTrace;
};

export type ClosestType = {
  typeId: string;
  trace: PredicateTrace;
  score: number;
};

export type UnreadableType = {
  typeId: string;
  reason: string;
  /** Why the file could not be evaluated: a genuine read failure, or over the content-scan size limit. */
  kind: 'read' | 'too-large';
};

export type ClassificationResult = {
  matches: TypeMatch[];
  closest: ClosestType[];
  unreadable: UnreadableType[];
};

/**
 * Classify a file against all types in the architecture.
 *
 * Returns:
 *   matches     — types whose `when` evaluates to true on this file
 *   closest     — top 3 non-matching types ranked by satisfied-fraction (descending)
 *   unreadable  — types whose `when` could not be evaluated on this file at all
 *                 (e.g. a `content:` predicate on a file over the size limit).
 *                 Distinct from a plain non-match: the predicate was never
 *                 actually applied, so this file must not be silently treated
 *                 as failing that type.
 *
 * Types without `when` (organizational) are skipped.
 * Files under `.yggdrasil/` are auto-exempt (evaluator returns vacuously true).
 */
export async function classifyFile(
  absPath: string,
  repoRelPath: string,
  graph: Graph,
  cache: FileContentCache,
): Promise<ClassificationResult> {
  const matches: TypeMatch[] = [];
  const partialScores: ClosestType[] = [];
  const unreadable: UnreadableType[] = [];

  const ctx: EvalContext = {
    absPath,
    repoRelPath,
    projectRoot: path.dirname(graph.rootPath),
    cache,
  };

  for (const [typeId, def] of Object.entries(graph.architecture.node_types)) {
    if (def.when === undefined) continue;
    const result = await evaluateFileWhen(def.when, ctx);
    if (result.unreadable) {
      unreadable.push({
        typeId,
        reason: result.unreadableReason ?? 'unreadable',
        kind: result.unreadableKind ?? 'read',
      });
      continue;
    }
    if (result.result) {
      matches.push({ typeId, trace: result.trace });
    } else {
      const score = computeSatisfiedFraction(result.trace);
      partialScores.push({ typeId, trace: result.trace, score });
    }
  }

  partialScores.sort((a, b) => b.score - a.score);
  const closest = partialScores.slice(0, 3);

  return { matches, closest, unreadable };
}

/**
 * Compute satisfied-fraction of a predicate trace (range 0..1).
 *
 * atom:    1.0 if matched, 0.0 otherwise
 * all_of:  average of children scores (1.0 for empty)
 * any_of:  max of children scores (0.0 for empty)
 * not:     1 - child score
 * exempt:  1.0 (vacuously true)
 */
function computeSatisfiedFraction(trace: PredicateTrace): number {
  switch (trace.kind) {
    case 'atom-path':
    case 'atom-content':
      return trace.result ? 1.0 : 0.0;
    case 'all_of': {
      if (trace.children.length === 0) return 1.0;
      const sum = trace.children.reduce((acc, c) => acc + computeSatisfiedFraction(c), 0);
      return sum / trace.children.length;
    }
    case 'any_of': {
      if (trace.children.length === 0) return 0.0;
      return Math.max(...trace.children.map(computeSatisfiedFraction));
    }
    case 'not':
      return 1.0 - computeSatisfiedFraction(trace.child);
    case 'exempt':
      return 1.0;
  }
}
